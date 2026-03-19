import { Router } from "express";
import multer from "multer";
import sharp from "sharp";
import r2Client from "../utils/R2.js";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";
import { sanitizeFileName } from "../utils/methods.js";
import { getVideoMetadata, bufferToStream } from "../utils/videoProcessor.js";

const router = Router();

// Helper to upload to R2 using chunked multipart upload
const uploadToR2 = async (buffer, filename, mimetype) => {
    try {
        const upload = new Upload({
            client: r2Client,
            params: {
                Bucket: process.env.R2_BUCKET_NAME,
                Key: filename,
                Body: buffer,
                ContentType: mimetype,
            },
            partSize: 5 * 1024 * 1024, 
            queueSize: 4, 
        });

        upload.on("httpUploadProgress", (progress) => {
            console.log(`Uploaded ${progress.loaded} of ${progress.total} bytes for ${filename}`);
        });

        await upload.done();

        const getCommand = new GetObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: filename,
        });
        const url = await getSignedUrl(r2Client, getCommand, { expiresIn: 604800 }); // 7 days valid

        return { status: true, signedUrl: url };
    } catch (error) {
        return { status: false, error: error.message };
    }
};

const uploadImage = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith("image/")) {
            cb(null, true);
        } else {
            cb(new Error("Only image files are allowed (jpeg, png, webp, etc.)"), false);
        }
    },
});

router.post("/images", (req, res, next) => {
    uploadImage.single("image")(req, res, (err) => {
        if (err instanceof multer.MulterError) {
            if (err.code === "LIMIT_UNEXPECTED_FILE") {
                return res.status(400).json({
                    success: false,
                    msg: "Unexpected field name. Please use the key 'image' for your file."
                });
            }
            return res.status(400).json({ success: false, msg: err.message });
        } else if (err) {
            return res.status(400).json({ success: false, msg: err.message });
        }
        next();
    });
}, async (req, res) => {
    try {
        const file = req.file;
        if (!file) {
            return res.status(400).json({
                success: false,
                msg: "No image file provided. Use form field name 'image'.",
            });
        }

        const folderPrefix = process.env.R2_FOLDER ? `${process.env.R2_FOLDER}/` : "";
        const prefix = folderPrefix + "uploads/images/";
        const safeName = sanitizeFileName(file.originalname);
        const filename = `${prefix}${Date.now()}_${safeName}`;

        // Compress with Sharp
        const compressedBuffer = await sharp(file.buffer)
            .resize({ width: 1600, withoutEnlargement: true })
            .toFormat("jpeg")
            .jpeg({ quality: 80, progressive: true })
            .toBuffer();

        // Upload to R2
        const uploadResult = await uploadToR2(compressedBuffer, filename, "image/jpeg");

        if (!uploadResult.status) {
            return res.status(500).json({
                status: false,
                msg: "Upload failed",
                error: uploadResult.error,
            });
        }

        return res.status(200).json({
            status: true,
            url: uploadResult.signedUrl,
            fileName: filename,
            msg: "Image uploaded, compressed and ready (Signed URL valid for 7 days)",
        });
    } catch (error) {
        console.error("Image Upload Route Error:", error);
        return res.status(500).json({
            status: false,
            msg: "Server error during upload",
            error: error.message,
        });
    }
});

const uploadVideo = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith("video/")) {
            cb(null, true);
        } else {
            cb(new Error("Only video files are allowed (mp4, webm, etc.)"), false);
        }
    },
});

router.post("/videos", (req, res, next) => {
    uploadVideo.single("video")(req, res, (err) => {
        if (err instanceof multer.MulterError) {
            if (err.code === "LIMIT_UNEXPECTED_FILE") {
                return res.status(400).json({
                    success: false,
                    msg: "Unexpected field name. Please use the key 'video' for your file."
                });
            }
            if (err.code === "LIMIT_FILE_SIZE") {
                return res.status(400).json({
                    success: false,
                    msg: "Video file too large. Maximum size is 50MB."
                });
            }
            return res.status(400).json({ success: false, msg: err.message });
        } else if (err) {
            return res.status(400).json({ success: false, msg: err.message });
        }
        next();
    });
}, async (req, res) => {
    try {
        const file = req.file;
        if (!file) {
            return res.status(400).json({
                success: false,
                msg: "No video file provided. Use form field name 'video'.",
            });
        }

        const folderPrefix = process.env.R2_FOLDER ? `${process.env.R2_FOLDER}/` : "";
        const prefix = folderPrefix + "uploads/videos/";
        const safeName = sanitizeFileName(file.originalname);
        const filename = `${prefix}${Date.now()}_${safeName}`;

        // Upload to R2 directly with the file.buffer
        const uploadResult = await uploadToR2(file.buffer, filename, file.mimetype);

        // Extract metadata if it's a video
        let videoMeta = null;
        try {
            const stream = bufferToStream(file.buffer);
            videoMeta = await getVideoMetadata(stream);
        } catch (probeErr) {
            console.error("FFprobe error:", probeErr);
        }

        if (!uploadResult.status) {
            return res.status(500).json({
                status: false,
                msg: "Upload failed",
                error: uploadResult.error,
            });
        }

        return res.status(200).json({
            status: true,
            url: uploadResult.signedUrl,
            fileName: filename,
            resolution: videoMeta?.resolution || null,
            metadata: videoMeta,
            msg: "Video uploaded successfully",
        });
    } catch (error) {
        console.error("Video Upload Route Error:", error);
        return res.status(500).json({
            status: false,
            msg: "Server error during upload",
            error: error.message,
        });
    }
});

export default router;