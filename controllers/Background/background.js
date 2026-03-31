import Background from "../../models/Backgrounds.js";
import r2Client from "../../utils/R2.js";
import { PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { nanoid } from "nanoid";
import { sanitizeFileName } from "../../utils/methods.js";

/**
 * @Description Create Background
 * @Route POST /api/background/create
 * @Access Private
 */
export const createBackground = async (req, res) => {
    const { id } = req.user;
    const { name, url, type, isActive, link } = req.body;
    try {

        const background = new Background({
            user: id,
            name,
            url,
            type,
            isActive,
            link
        });
        await background.save();
        return res.status(201).json({
            status: true,
            msg: "Background created successfully",
            data: background
        });
    } catch (error) {
        return res.status(500).json({
            status: false,
            msg: error.message
        });
    }
}


/**
 * @Description Get All Backgrounds
 * @Route GET /api/background/all
 * @Access Private
 */
export const getAllBackgrounds = async (req, res) => {
    const { id } = req.user;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    try {
        const backgrounds = await Background.find({ user: id }).sort({ createdAt: -1 }).lean().exec();
        return res.status(200).json({
            status: true,
            msg: "Backgrounds fetched successfully",
            data: backgrounds
        });
    } catch (error) {
        return res.status(500).json({
            status: false,
            msg: error.message
        });
    }
}

/**
 * @Description Generate a Presigned URL for Background Upload directly to R2
 * @Route POST /api/background/generate-upload-url
 * @Access Private
 */
export const generateBackgroundUploadUrl = async (req, res) => {
    const { fileName, fileType } = req.body;

    if (!fileName || !fileType) {
        return res.status(400).json({ status: false, msg: "fileName and fileType are required" });
    }

    try {
        const safeName = sanitizeFileName(fileName);
        const objectKey = `backgrounds/${nanoid(8)}-${safeName}`;
        
        const command = new PutObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: objectKey,
            ContentType: fileType,
        });

        // 1 hour expiry for the upload link
        const uploadUrl = await getSignedUrl(r2Client, command, { expiresIn: 3600 });
        
        // Final public URL
        // Using a backend proxy route to avoid Cloudflare R2 public domain issues
        const publicUrl = `${process.env.BACKEND_URL}/api/background/view/${objectKey}`;

        // Diagnostic Signed URL (valid for 24 hours) to verify file existence
        const getCommand = new GetObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: objectKey,
        });
        const signedViewerUrl = await getSignedUrl(r2Client, getCommand, { expiresIn: 86400 });

        return res.status(200).json({
            status: true,
            msg: "Presigned URL generated successfully",
            uploadUrl,
            objectKey,
            publicUrl,
            signedViewerUrl
        });
    } catch (error) {
        console.error("Error generating background upload URL:", error);
        return res.status(500).json({
            status: false,
            msg: "Server error generating upload URL"
        });
    }
};

/**
 * @Description Proxy to view background directly from R2
 * @Param key: Object key (including prefix)
 */
export const viewBackground = async (req, res) => {
    try {
        // key will be the first capture group from the regex: /^\/view\/(.+)/
        const key = req.params[0];

        if (!key) {
            return res.status(400).json({ status: false, msg: "Key is required" });
        }

        const command = new GetObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: key,
        });

        const response = await r2Client.send(command);

        // Set content-type and other headers
        res.setHeader('Content-Type', response.ContentType);
        res.setHeader('Content-Length', response.ContentLength);
        res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year

        // Pipe the stream to response
        response.Body.pipe(res);
    } catch (error) {
        console.error("Error viewing background:", error);
        if (error.name === "NoSuchKey") {
            return res.status(404).json({ status: false, msg: "Background not found" });
        }
        return res.status(500).json({ status: false, msg: "Server error fetching background" });
    }
};

/**
 * @Description Delete Background
 * @Route DELETE /api/background/delete/:bgId
 * @Access Private
 */
export const deleteBg = async (req, res) => {
    const { id } = req.user;
    const { bgId } = req.params;
    try {
        const background = await Background.findByIdAndDelete({
            user: id,
            _id: bgId
        }).lean().exec();

        if (!background) {
            return res.status(404).json({
                status: false,
                msg: "Background not found"
            });
        }
        
        // Attempt to delete it from R2 storage
        if (background.url) {
            try {
                // parse out the key from URL
                let key = background.url;
                try {
                    const parsedUrl = new URL(background.url);
                    key = parsedUrl.pathname.substring(1); // remove leading slash
                } catch (e) {
                    // if it's not a valid URL (just the key itself), use it directly
                }
                
                await r2Client.send(new DeleteObjectCommand({
                    Bucket: process.env.R2_BUCKET_NAME,
                    Key: key
                }));
                console.log(`Deleted background object from R2: ${key}`);
            } catch (err) {
                console.error(`Failed to delete background from R2:`, err);
            }
        }
        
        return res.status(200).json({
            status: true,
            msg: "Background deleted successfully",
            data: background
        });
    } catch (error) {
        return res.status(500).json({
            status: false,
            msg: error.message
        });
    }
}

/**
 * @Description Update Status
 * @Route PUT /api/background/update-status/:bgId
 * @Access Private
 */
export const updateStatus = async (req, res) => {
    const { id } = req.user;
    const { bgId } = req.params;
    const { isActive } = req.body;
    try {
        const background = await Background.findOneAndUpdate({
            user: id,
            _id: bgId
        }, {
            isActive
        }, {
            new: true
        }).lean().exec();

        if (!background) {
            return res.status(404).json({
                status: false,
                msg: "Background not found"
            });
        }

        return res.status(200).json({
            status: true,
            msg: "Background status updated successfully",
            data: background
        });
    } catch (error) {
        return res.status(500).json({
            status: false,
            msg: error.message
        });
    }
}