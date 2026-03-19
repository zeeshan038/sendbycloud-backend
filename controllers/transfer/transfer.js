//NPM Pacakages
import mongoose from "mongoose";
import { nanoid } from "nanoid";

//utils
import r2Client from "../../utils/R2.js";
import {
    PutObjectCommand,
    GetObjectCommand,
    CreateMultipartUploadCommand,
    UploadPartCommand,
    CompleteMultipartUploadCommand,
    AbortMultipartUploadCommand,
    DeleteObjectCommand,
    HeadObjectCommand
} from "@aws-sdk/client-s3";
import { sanitizeFileName } from "../../utils/methods.js";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";
import archiver from "archiver";
import { PassThrough } from "stream";
import fs from "fs";
import path from "path";
import os from "os";
import { getVideoMetadata, RESOLUTIONS, transcodeVideo, transcodeMultipleResolutions } from "../../utils/videoProcessor.js";


//Models
import File from "../../models/files.js";

//schema
import { TransferSchema, VerifyPasswordSchema } from "../../schema/Transfer.js";

/**
 * @Description Send File to the user 
 * @Route POST api/file/Send
 * @Access Public OR Private
 */

const createZipAndUpload = async (transferId, files, shortId) => {
    try {
        const archive = archiver('zip', {
            zlib: { level: 9 }
        });

        const passThrough = new PassThrough();
        const folderPrefix = process.env.R2_FOLDER ? `${process.env.R2_FOLDER}/` : "";
        const zipKey = `${folderPrefix}transfers/sendbycloud-${shortId}.zip`;

        const upload = new Upload({
            client: r2Client,
            params: {
                Bucket: process.env.R2_BUCKET_NAME,
                Key: zipKey,
                Body: passThrough,
                ContentType: 'application/zip'
            }
        });

        archive.pipe(passThrough);

        for (const fileData of files) {
            const objectKey = typeof fileData === 'string' ? fileData : fileData.key;
            const originalName = typeof fileData === 'object' && fileData.name
                ? fileData.name
                : (objectKey.split('_').slice(1).join('_') || objectKey);

            const getObjectCommand = new GetObjectCommand({
                Bucket: process.env.R2_BUCKET_NAME,
                Key: objectKey,
            });

            const response = await r2Client.send(getObjectCommand);
            const entryName = files.length > 1 ? `Files/${originalName}` : originalName;
            archive.append(response.Body, { name: entryName });
            console.log(`Added ${originalName} to zip`);
        }

        archive.finalize();

        await upload.done();

        // Update transfer with zipKey
        await File.findByIdAndUpdate(transferId, { zipKey });
        console.log(`Zip created and uploaded for transfer ${transferId}: ${zipKey}`);
    } catch (error) {
        console.error("Error creating zip:", error);
    }
};

const extractVideoResolutions = async (transferId, files) => {
    try {
        const transfer = await File.findById(transferId);
        if (!transfer) return;

        const updatedFiles = transfer.files;
        
        for (let i = 0; i < updatedFiles.length; i++) {
            const fileData = updatedFiles[i];
            const objectKey = typeof fileData === 'string' ? fileData : fileData.key;

            // Check if it's a video by extension
            const isVideo = /\.(mp4|mov|avi|wmv|flv|webm|mkv|m4v)$/i.test(objectKey);
            if (!isVideo) continue;

            try {
                // Generate a temporary signed URL for ffprobe and ffmpeg
                const getCommand = new GetObjectCommand({
                    Bucket: process.env.R2_BUCKET_NAME,
                    Key: objectKey,
                });
                const signedUrl = await getSignedUrl(r2Client, getCommand, { expiresIn: 3600 });

                const metadata = await getVideoMetadata(signedUrl);
                if (metadata && metadata.shortSide) {
                    // Update metadata immediately
                    const fileToUpdate = typeof updatedFiles[i] === 'string' ? { key: objectKey } : updatedFiles[i];
                    fileToUpdate.resolution = `${metadata.shortSide}p`;
                    fileToUpdate.duration = metadata.duration;
                    fileToUpdate.metadata = metadata;
                    if (!fileToUpdate.qualities) {
                        fileToUpdate.qualities = [{ label: 'Original', key: objectKey, isOriginal: true }];
                    }
                    
                    await File.updateOne(
                        { _id: transferId },
                        { $set: { [`files.${i}`]: fileToUpdate } }
                    );

                    const targets = RESOLUTIONS.filter(r => r.shortSide < metadata.shortSide);
                    if (targets.length === 0) continue;

                    // Create temp directory for this transcoding job
                    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcode-'));
                    
                    try {
                        console.log(`Starting multi-resolution transcoding for ${objectKey} in ${tempDir}`);
                        const outputFiles = await transcodeMultipleResolutions(signedUrl, targets, tempDir);

                        // Upload all generated files in parallel
                        await Promise.all(outputFiles.map(async (outFile) => {
                            const pathParts = objectKey.split('/');
                            const fileName = pathParts.pop();
                            const folderPath = pathParts.join('/');
                            const resKey = `${folderPath}/${outFile.label}_${fileName}`;

                            const fileStream = fs.createReadStream(outFile.path);
                            const upload = new Upload({
                                client: r2Client,
                                params: {
                                    Bucket: process.env.R2_BUCKET_NAME,
                                    Key: resKey,
                                    Body: fileStream,
                                    ContentType: 'video/mp4'
                                }
                            });

                            await upload.done();
                            console.log(`Uploaded ${outFile.label} to R2`);

                            // Update qualities in DB
                            await File.updateOne(
                                { _id: transferId },
                                { 
                                    $push: { 
                                        [`files.${i}.qualities`]: {
                                            label: outFile.label,
                                            key: resKey,
                                            isOriginal: false
                                        }
                                    } 
                                }
                            );
                        }));
                    } finally {
                        // Cleanup temp files
                        try {
                            fs.rmSync(tempDir, { recursive: true, force: true });
                            console.log(`Cleaned up temp directory: ${tempDir}`);
                        } catch (cleanupErr) {
                            console.error(`Error cleaning up ${tempDir}:`, cleanupErr.message);
                        }
                    }
                }
            } catch (err) {
                console.warn(`Could not process video ${objectKey}`, err.message);
            }
        }
    } catch (error) {
        console.error("Error in extractVideoResolutions:", error);
    }
};


/**
 * @Description Upload Speed test
 * @Route POST api/file/speed-test
 * @Access Public
 */
/**
 * @Description Network Speed test (Latency, Download, Upload)
 * @Route ALL api/transfer/speed-test
 * @Access Public
 */
export const speedTest = async (req, res) => {
    try {
        if (req.method === 'GET') {
            const { download, size } = req.query;
            
            // If download requested, send binary data
            if (download === 'true') {
                const downloadSize = parseInt(size) || 1024 * 1024 * 5; // Default 5MB
                
                // Cap at 100MB to prevent abuse
                if (downloadSize > 100 * 1024 * 1024) {
                    return res.status(400).json({ 
                        status: false, 
                        msg: "Download size too large (max 100MB)" 
                    });
                }
                
                res.setHeader('Content-Type', 'application/octet-stream');
                res.setHeader('Content-Length', downloadSize);
                res.setHeader('Content-Disposition', 'attachment; filename="speedtest.bin"');
                
                // Stream chunks of zeros to minimize memory usage
                const chunkSize = 64 * 1024;
                let sent = 0;
                
                while (sent < downloadSize) {
                    const toSend = Math.min(chunkSize, downloadSize - sent);
                    // Using a single buffer repeatedly would be even better, 
                    // but for simplicity and safety against modifications:
                    res.write(Buffer.alloc(toSend, 0));
                    sent += toSend;
                }
                return res.end();
            }

            // Normal GET: Latency/Ping test
            return res.status(200).json({ 
                status: true, 
                msg: "Server is ready for speed test",
                timestamp: Date.now()
            });

        } else if (req.method === 'POST') {
            // Upload test: Measure how much data we receive
            let bytesReceived = 0;
            
            // Note: If express.json() or other body parsers are used, 
            // they may have already consumed the stream if the Content-Type matched.
            // For raw speed tests, clients should send application/octet-stream.
            
            req.on('data', (chunk) => {
                bytesReceived += chunk.length;
            });

            req.on('end', () => {
                // If bytesReceived is 0, it might be because a body-parser already consumed it
                // and put it in req.body (though for binary data that's unlikely unless configured).
                // Or simply no data was sent.
                
                return res.status(200).json({
                    status: true,
                    msg: "Upload test completed",
                    bytesReceived: bytesReceived || (req.body ? JSON.stringify(req.body).length : 0),
                    timestamp: Date.now()
                });
            });

            // Handle stream errors
            req.on('error', (err) => {
                console.error("Upload test stream error:", err);
                if (!res.headersSent) {
                    res.status(500).json({ status: false, msg: "Stream error during upload test" });
                }
            });
        } else {
            return res.status(405).json({ status: false, msg: "Method not allowed" });
        }
    } catch (error) {
        console.error("Speed test general error:", error);
        if (!res.headersSent) {
            return res.status(500).json({ status: false, msg: error.message });
        }
    }
};

export const sendFile = async (req, res) => {
    const { getShareableLink = false, selfDestruct = false , isDownloadAble = false } = req.query;
    const payload = req.body;

    // Validation
    const { error } = TransferSchema(payload);
    if (error) {
        return res.status(400).json({
            status: false,
            msg: error.details[0].message
        });
    }

    const {
        senderEmail,
        recevierEmails,
        files,
        totalSize,
        uploadType,
        password,
        expireDate,
        downloadLimit,
        expireIn,
        background,
        transferId: payloadTransferId,
        shortId: payloadShortId
    } = payload;

    try {

        const file = await File.create({
            user: req.body.user || null,
            senderEmail,
            recevierEmails,
            files,
            totalSize,
            uploadType,
            password,
            expireDate,
            downloadLimit,
            expireIn,
            background,
            selfDestruct: selfDestruct === 'true' || selfDestruct === true,
            isDownloadAble: isDownloadAble === 'true' || isDownloadAble === true,
            shortId: payloadShortId || payloadTransferId || nanoid(8)
        });

        const shareLink = `${process.env.CLIENT_URL}/${file.shortId}`;

        // If multiple files, create zip in background
        if (files.length > 1) {
            createZipAndUpload(file._id, files, file.shortId);
        }

        // Extract video resolutions in background
        const hasVideos = files.some(f => {
            const name = typeof f === 'string' ? f : (f.fileName || f.name || f.key);
            return /\.(mp4|mov|avi|wmv|flv|webm|mkv|m4v)$/i.test(name);
        });

        if (hasVideos || uploadType === 'Videos') {
            extractVideoResolutions(file._id, files);
        }

        if (getShareableLink === 'true' || getShareableLink === true) {
            return res.status(200).json({
                status: true,
                msg: "Share Link Generated",
                shareLink
            });
        }

        return res.status(200).json({
            status: true,
            msg: "File sent successfully",
            shareLink,
            shortId: file.shortId
        });
    } catch (error) {
        return res.status(500).json({
            status: false,
            msg: error.message
        });
    }
};

/**
 * @Description Generate multiple presigned URLs for direct browser-to-R2 uploads
 * @Route POST api/transfer/generate-upload-urls
 * @Access Public
 */
export const generateUploadUrls = async (req, res) => {
    const { files, transferId: existingId } = req.body;
    try {
        if (!files || !Array.isArray(files) || files.length === 0) {
            return res.status(400).json({ status: false, error: "Please provide an array of files" });
        }

        const transferId = existingId || nanoid(8);
        console.log("Generating upload URLs for transfer:", transferId);

        const uploadUrls = await Promise.all(
            files.map(async (file) => {
                const safeName = sanitizeFileName(file.fileName);
                const folderPrefix = process.env.R2_FOLDER ? `${process.env.R2_FOLDER}/` : "";
                const objectKey = `${folderPrefix}transfers/${transferId}/${safeName}`;

                const command = new PutObjectCommand({
                    Bucket: process.env.R2_BUCKET_NAME,
                    Key: objectKey,
                    ContentType: file.fileType,
                });

                const url = await getSignedUrl(r2Client, command, { expiresIn: 10800 });
                console.log(url);
                return {
                    originalName: file.fileName,
                    objectKey,
                    url
                };
            })
        );
        console.log(uploadUrls);
        return res.status(200).json({
            status: true,
            msg: "Presigned URLs generated successfully",
            transferId,
            uploadUrls
        });
    } catch (error) {
        console.error("Error generating presigned URLs:", error);
        return res.status(500).json({
            status: false,
            msg: "Server error generating upload URLs"
        });
    }
};

/**
 * @Description Initiate a multipart upload
 * @Route POST api/transfer/initiate-multipart
 * @Access Public
 */
export const initiateMultipartUpload = async (req, res) => {
    const { fileName, fileType, transferId: existingId } = req.body;
    try {
        if (!fileName) {
            return res.status(400).json({ status: false, error: "fileName is required" });
        }

        const transferId = existingId || nanoid(8);
        const safeName = sanitizeFileName(fileName);
        const folderPrefix = process.env.R2_FOLDER ? `${process.env.R2_FOLDER}/` : "";
        const objectKey = `${folderPrefix}transfers/${transferId}/${safeName}`;

        const command = new CreateMultipartUploadCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: objectKey,
            ContentType: fileType || "application/octet-stream",
        });

        const response = await r2Client.send(command);

        return res.status(200).json({
            status: true,
            msg: "Multipart upload initiated",
            uploadId: response.UploadId,
            transferId,
            key: objectKey
        });
    } catch (error) {
        console.error("Error initiating multipart upload:", error);
        return res.status(500).json({ status: false, msg: error.message });
    }
};

/**
 * @Description Generate a presigned URL for a specific part
 * @Route POST api/transfer/get-part-url
 * @Access Public
 */
export const getPartUploadUrl = async (req, res) => {
    const { uploadId, key, partNumber } = req.body;
    try {
        if (!uploadId || !key || !partNumber) {
            return res.status(400).json({ status: false, error: "uploadId, key, and partNumber are required" });
        }

        const command = new UploadPartCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: key,
            UploadId: uploadId,
            PartNumber: Number(partNumber),
        });

        const url = await getSignedUrl(r2Client, command, { expiresIn: 3600 }); // 1 hour

        return res.status(200).json({
            status: true,
            url
        });
    } catch (error) {
        console.error("Error generating part URL:", error);
        return res.status(500).json({ status: false, msg: error.message });
    }
};

/**
 * @Description Complete a multipart upload
 * @Route POST api/transfer/complete-multipart
 * @Access Public
 */
export const completeMultipartUpload = async (req, res) => {
    const { uploadId, key, parts } = req.body;
    try {
        if (!uploadId || !key || !parts || !Array.isArray(parts)) {
            return res.status(400).json({ status: false, error: "uploadId, key, and parts are required" });
        }

        // Parts must be sorted by PartNumber
        const sortedParts = parts
            .map(part => ({
                ETag: part.ETag,
                PartNumber: Number(part.PartNumber)
            }))
            .sort((a, b) => a.PartNumber - b.PartNumber);

        const command = new CompleteMultipartUploadCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: {
                Parts: sortedParts,
            },
        });

        const response = await r2Client.send(command);

        return res.status(200).json({
            status: true,
            msg: "Multipart upload completed",
            location: response.Location,
            key: response.Key
        });
    } catch (error) {
        console.error("Error completing multipart upload:", error);
        return res.status(500).json({ status: false, msg: error.message });
    }
};

/**
 * @Description Abort a multipart upload
 * @Route POST api/transfer/abort-multipart
 * @Access Public
 */
export const abortMultipartUpload = async (req, res) => {
    const { uploadId, key } = req.body;
    try {
        if (!uploadId || !key) {
            return res.status(400).json({ status: false, error: "uploadId and key are required" });
        }

        const command = new AbortMultipartUploadCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: key,
            UploadId: uploadId,
        });

        await r2Client.send(command);

        return res.status(200).json({
            status: true,
            msg: "Multipart upload aborted successfully"
        });
    } catch (error) {
        console.error("Error aborting multipart upload:", error);
        return res.status(500).json({ status: false, msg: error.message });
    }
};


/**
 * @Description Get transfers
 * @Route GET api/transfer/get/:id
 * @Access Public
 */
export const getTransfer = async (req, res) => {
    const { shortId } = req.params;
    try {
        const isObjectId = mongoose.Types.ObjectId.isValid(shortId);
        const transfer = await File.findOne(
            isObjectId ? { _id: shortId } : { shortId: shortId }
        );

        if (!transfer) {
            return res.status(404).json({
                status: false,
                msg: "Transfer not found"
            });
        }

        return res.status(200).json({
            status: true,
            msg: "Transfer found",
            transferDetails: transfer
        });
    } catch (error) {
        console.error("Error fetching transfer:", error);
        return res.status(500).json({
            status: false,
            msg: error.message
        });
    }
};

/**
 * @Description Get download links for a transfer
 * @Route GET api/transfer/download/:id
 * @Access Public
 */
export const getDownloadUrl = async (req, res) => {
    const { shortId } = req.params;
    const { preview = false, password = "" } = req.query;
    try {
        // Find by shortId or standard MongoDB ID
        const isObjectId = mongoose.Types.ObjectId.isValid(shortId);
        const transfer = await File.findOne(
            isObjectId ? { _id: shortId } : { shortId: shortId }
        );

        if (!transfer) {
            return res.status(404).json({
                status: false,
                msg: "Transfer not found"
            });
        }

        // Check password if set
        if (transfer.password && transfer.password !== password) {
            return res.status(401).json({
                status: false,
                msg: "Invalid password for this transfer"
            });
        }

        // Check self-destruct logic: Only block if it's NOT a preview or if it already reached the limit
        if (transfer.selfDestruct && transfer.downloadCount >= 1) {
            return res.status(410).json({
                status: false,
                msg: "This transfer has self-destructed and is no longer available."
            });
        }

        // Generate signed URLs for each file in the transfer
        const fileUrls = await Promise.all(
            transfer.files.map(async (fileData) => {
                // Handle both cases: fileData is a string (old way) or an object (new way)
                const objectKey = typeof fileData === 'string' ? fileData : fileData.key;

                // Extract original name (everything after the first underscore)
                const originalName = typeof fileData === 'object' && fileData.name
                    ? fileData.name
                    : (objectKey.split('_').slice(1).join('_') || objectKey);

                const command = new GetObjectCommand({
                    Bucket: process.env.R2_BUCKET_NAME,
                    Key: objectKey,
                    // This is the "magic" string that forces a direct download with the original name
                    ResponseContentDisposition: preview === 'true'
                        ? 'inline'
                        : `attachment; filename="${originalName}"; filename*=UTF-8''${encodeURIComponent(originalName)}`
                });

                // URL valid for 7 days (standard for file sharing)
                const url = await getSignedUrl(r2Client, command, { expiresIn: 604800 });

                // Generate signed URLs for all qualities
                let qualityUrls = [];
                if (fileData.qualities && Array.isArray(fileData.qualities)) {
                    qualityUrls = await Promise.all(
                        fileData.qualities.map(async (q) => {
                            const qCommand = new GetObjectCommand({
                                Bucket: process.env.R2_BUCKET_NAME,
                                Key: q.key,
                                ResponseContentDisposition: preview === 'true'
                                    ? 'inline'
                                    : `attachment; filename="${q.label}_${originalName}"`
                            });
                            const qUrl = await getSignedUrl(r2Client, qCommand, { expiresIn: 604800 });
                            return {
                                label: q.label,
                                url: qUrl,
                                isOriginal: q.isOriginal
                            };
                        })
                    );
                }

                return {
                    objectKey,
                    url,
                    fileName: originalName,
                    qualities: qualityUrls.length > 0 ? qualityUrls : null,
                    resolution: fileData.resolution || null,
                    duration: fileData.duration || null,
                    streamUrl: /\.(mp4|mov|avi|wmv|flv|webm|mkv|m4v)$/i.test(originalName) 
                        ?process.env.BACKEND_URL||`${'http://localhost:8080'}/api/transfer/stream/${transfer.shortId}?key=${encodeURIComponent(objectKey)}`
                        : null
                };
            })
        );

        let zipUrl = null;
        let zipStatus = "none";

        if (transfer.files.length > 1) {
            if (transfer.zipKey) {
                const zipCommand = new GetObjectCommand({
                    Bucket: process.env.R2_BUCKET_NAME,
                    Key: transfer.zipKey,
                    ResponseContentDisposition: `attachment; filename="all_files.zip"`
                });
                zipUrl = await getSignedUrl(r2Client, zipCommand, { expiresIn: 604800 });
                zipStatus = "ready";
            } else {
                zipStatus = "processing";
            }
        }


        // ONLY increment downloadCount if this is a real download, NOT a preview
        if (preview !== 'true') {
            transfer.downloadCount += 1;
            await transfer.save();
        }

        return res.status(200).json({
            status: true,
            files: fileUrls,
            zipUrl,
            zipStatus,
            isSelfDestruct: transfer.selfDestruct,
            isDownloadAble: transfer.isDownloadAble,
            transferDetails: {
                senderEmail: transfer.senderEmail,
                recevierEmails: transfer.recevierEmails,
                totalSize: transfer.totalSize,
                expireIn: transfer.expireIn,
            }
        });

    } catch (error) {
        console.error("Error fetching download URLs:", error);
        return res.status(500).json({
            status: false,
            msg: error.message
        });
    }
};

/**
 * @Description Verify transfer password
 * @Route POST api/transfer/verify-password/:shortId
 * @Access Public
 */
export const verifyPassword = async (req, res) => {
    const { shortId } = req.params;
    const { password } = req.body;

    const { error } = VerifyPasswordSchema(req.body);
    if (error) {
        return res.status(400).json({ status: false, msg: error.details[0].message });
    }

    try {
        const isObjectId = mongoose.Types.ObjectId.isValid(shortId);
        const transfer = await File.findOne(
            isObjectId ? { _id: shortId } : { shortId: shortId }
        );

        if (!transfer) {
            return res.status(404).json({ status: false, msg: "Transfer not found" });
        }

        if (transfer.password === password) {
            return res.status(200).json({ status: true, msg: "Password verified" });
        } else {
            return res.status(401).json({ status: false, msg: "Invalid password" });
        }
    } catch (error) {
        return res.status(500).json({ status: false, msg: error.message });
    }
};

/**
 * @Description Delete a transfer
 * @Route DELETE api/transfer/delete/:id
 * @Access Private (Owner only)
 */
export const deleteTransfer = async (req, res) => {
    const { id } = req.params;
    try {
        // Find and delete the transfer record
        const transfer = await File.findByIdAndDelete(id);

        if (!transfer) {
            return res.status(404).json({ status: false, msg: "Transfer not found" });
        }

        // Cleanup files in R2
        const cleanupFiles = async () => {
            try {
                // Delete individual files
                for (const fileData of transfer.files) {
                    const objectKey = typeof fileData === 'string' ? fileData : fileData.key;
                    await r2Client.send(new DeleteObjectCommand({
                        Bucket: process.env.R2_BUCKET_NAME,
                        Key: objectKey
                    }));

                    // Delete transcoded versions
                    if (fileData.qualities && Array.isArray(fileData.qualities)) {
                        for (const quality of fileData.qualities) {
                            if (quality.key && quality.key !== objectKey) {
                                await r2Client.send(new DeleteObjectCommand({
                                    Bucket: process.env.R2_BUCKET_NAME,
                                    Key: quality.key
                                }));
                            }
                        }
                    }
                }

                // Delete zip file if it exists
                if (transfer.zipKey) {
                    await r2Client.send(new DeleteObjectCommand({
                        Bucket: process.env.R2_BUCKET_NAME,
                        Key: transfer.zipKey
                    }));
                }
                console.log(`Successfully cleaned up R2 objects for transfer ${id}`);
            } catch (err) {
                console.error(`Error cleaning up R2 objects for transfer ${id}:`, err);
            }
        };

        // Run cleanup in background
        cleanupFiles();

        return res.status(200).json({
            status: true,
            msg: "Transfer and associated files deleted successfully"
        });
    } catch (error) {
        return res.status(500).json({ status: false, msg: error.message });
    }
};

/**
 * @Description Stream video in chunks (Range requests)
 * @Route GET api/transfer/stream/:shortId?key=...
 * @Access Public
 */
export const streamVideo = async (req, res) => {
    const { shortId } = req.params;
    const { key, password = "" } = req.query;

    if (!key) {
        return res.status(400).json({ status: false, msg: "Key is required" });
    }

    try {
        const transfer = await File.findOne({ shortId });
        if (!transfer) {
            console.warn(`Streaming attempt for non-existent transfer: ${shortId}`);
            return res.status(404).json({ status: false, msg: "Transfer not found" });
        }

        // Check password if set
        if (transfer.password && transfer.password !== password) {
            return res.status(401).json({ status: false, msg: "Invalid password" });
        }

        // Security: Verify that this key actually belongs to this transfer
        const isValidFile = transfer.files.some(f => {
            const mainKey = typeof f === 'string' ? f : f.key;
            if (mainKey === key) return true;
            // Also check transcoded qualities
            if (f.qualities && Array.isArray(f.qualities)) {
                return f.qualities.some(q => q.key === key);
            }
            return false;
        });

        if (!isValidFile) {
            console.error(`Security alert: Key ${key} does not belong to transfer ${shortId}`);
            console.log("Available keys in this transfer:", transfer.files.map(f => typeof f === 'string' ? f : (f.key || f)));
            return res.status(403).json({ status: false, msg: "Unauthorized: File does not belong to this transfer" });
        }

        const range = req.headers.range;
        const headCommand = new HeadObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: key,
        });

        const metadata = await r2Client.send(headCommand);
        const fileSize = metadata.ContentLength;

        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : Math.min(start + 1024 * 1024, fileSize - 1); // 1MB chunks

            const chunksize = (end - start) + 1;
            const fileCommand = new GetObjectCommand({
                Bucket: process.env.R2_BUCKET_NAME,
                Key: key,
                Range: `bytes=${start}-${end}`,
            });

            const response = await r2Client.send(fileCommand);

            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': metadata.ContentType || 'video/mp4',
            });
            response.Body.pipe(res);
        } else {
            res.writeHead(200, {
                'Content-Length': fileSize,
                'Content-Type': metadata.ContentType || 'video/mp4',
            });
            
            const fileCommand = new GetObjectCommand({
                Bucket: process.env.R2_BUCKET_NAME,
                Key: key,
            });
            const response = await r2Client.send(fileCommand);
            response.Body.pipe(res);
        }
    } catch (error) {
        if (error.name === 'NotFound') {
            console.error(`File physically missing on R2: ${key}`);
        } else {
            console.error("Streaming error:", error);
        }
        
        if (!res.headersSent) {
            res.status(error.name === 'NotFound' ? 404 : 500).json({ 
                status: false, 
                msg: error.name === 'NotFound' ? "File not found on storage server" : error.message 
            });
        }
    }
};