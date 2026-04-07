//NPM Pacakages
import mongoose from "mongoose";
import { nanoid } from "nanoid";
import jwt from "jsonwebtoken";

//Models
import File from "../../models/files.js";
import Background from "../../models/Backgrounds.js";
import OTP from "../../models/OTP.js";
import User from "../../models/User.js";


//schema
import {
    TransferSchema,
    VerifyPasswordSchema
} from "../../schema/Transfer.js";

// utils
import {
    extractVideoResolutions,
    calculateExpireDate
} from "../../utils/methods.js";
import { triggerWorkerZip } from "../../services/zipService.js";
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
import { sendEmail, buildFileReceivedHtml } from "../../utils/Nodemailer.js";
import { cleanupFiles } from "../../utils/cleanup.js";

/**
 * @Description Network Speed test (Latency, Download, Upload)
 * @Route ALL api/transfer/speed-test
 * @Access Public
 */
export const speedTest = async (req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Surrogate-Control', 'no-store');

        if (req.method === 'GET') {
            const { download, size } = req.query;

            if (download === 'true') {
                const parsedSize = Number(size);
                const downloadSize = Number.isFinite(parsedSize) && parsedSize > 0
                    ? parsedSize
                    : 5 * 1024 * 1024;

                const maxSize = 100 * 1024 * 1024;
                if (downloadSize > maxSize) {
                    return res.status(400).json({
                        status: false,
                        msg: 'Download size too large (max 100MB)'
                    });
                }

                res.status(200);
                res.setHeader('Content-Type', 'application/octet-stream');
                res.setHeader('Content-Length', String(downloadSize));
                res.setHeader('Content-Disposition', 'attachment; filename="speedtest.bin"');

                const chunkSize = 64 * 1024;
                const zeroChunk = Buffer.alloc(chunkSize, 0);
                let sent = 0;

                const writeChunk = () => {
                    while (sent < downloadSize) {
                        const remaining = downloadSize - sent;
                        const currentChunk =
                            remaining >= chunkSize ? zeroChunk : zeroChunk.subarray(0, remaining);

                        const canContinue = res.write(currentChunk);
                        sent += currentChunk.length;

                        if (!canContinue) {
                            res.once('drain', writeChunk);
                            return;
                        }
                    }

                    res.end();
                };

                writeChunk();
                return;
            }

            return res.status(200).json({
                status: true,
                msg: 'Server is ready for speed test',
                timestamp: Date.now()
            });
        }

        if (req.method === 'POST') {
            const contentLengthHeader = req.headers['content-length'];
            const contentLength = contentLengthHeader ? Number(contentLengthHeader) : null;

            let bytesReceived = 0;

            req.on('data', (chunk) => {
                bytesReceived += chunk.length;
            });

            req.on('end', () => {
                return res.status(200).json({
                    status: true,
                    msg: 'Upload test completed',
                    bytesReceived,
                    contentLength: Number.isFinite(contentLength) ? contentLength : null,
                    timestamp: Date.now()
                });
            });

            req.on('error', (err) => {
                console.error('Upload test stream error:', err);
                if (!res.headersSent) {
                    return res.status(500).json({
                        status: false,
                        msg: 'Stream error during upload test'
                    });
                }
            });

            return;
        }

        return res.status(405).json({
            status: false,
            msg: 'Method not allowed'
        });
    } catch (error) {
        console.error('Speed test general error:', error);
        if (!res.headersSent) {
            return res.status(500).json({
                status: false,
                msg: error.message || 'Internal server error'
            });
        }
    }
};

/**
 * @Description Send File
 * @Route POST api/transfer/send-file
 * @Access Private
 */
export const sendFile = async (req, res) => {
    const userId = req.user?._id ?? null;

    const {
        getShareableLink = false,
        selfDestruct = false,
        isDownloadAble = false
    } = req.query;
    const payload = req.body;

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
        backgroundType,
        backgroundLink,
        verificationToken,
        transferId: payloadTransferId,
        shortId: payloadShortId
    } = payload;

    try {
        if (!userId && (recevierEmails && recevierEmails.length > 0)) {
            let isVerified = false;

            if (verificationToken) {
                try {
                    const decoded = jwt.verify(verificationToken, process.env.JWT_SECRET);
                    if (decoded.email === senderEmail && decoded.type === 'transfer_verification') {
                        isVerified = true;
                    }
                } catch (err) {
                    console.error("Token verification failed:", err.message);
                }
            }

            if (!isVerified) {
                const verifiedOtp = await OTP.findOne({ email: senderEmail, isVerified: true });
                if (verifiedOtp) {
                    isVerified = true;
                    await OTP.deleteOne({ _id: verifiedOtp._id });
                }
            }

            if (!isVerified) {
                return res.status(401).json({
                    status: false,
                    msg: "Email verification required for unlogged transfers"
                });
            }
        }

        let activeBackground = background;
        let activeBackgroundType = backgroundType;
        let activeBackgroundLink = backgroundLink;

        if (!activeBackground) {
            const query = userId ? { user: userId, isActive: true } : { isActive: true };
            const latestBg = await Background.findOne(query).sort({ createdAt: -1 });

            if (latestBg) {
                activeBackground = latestBg.url;
                activeBackgroundType = latestBg.type;
                activeBackgroundLink = latestBg.link;
            }
        }

        const finalExpireDate = expireDate || calculateExpireDate(expireIn);

        const file = await File.create({
            user: userId,
            senderEmail,
            recevierEmails,
            files,
            totalSize,
            uploadType,
            password,
            expireDate: finalExpireDate,
            downloadLimit,
            expireIn,
            background: activeBackground,
            backgroundType: activeBackgroundType,
            backgroundLink: activeBackgroundLink,
            selfDestruct: selfDestruct === 'true' || selfDestruct === true,
            isDownloadAble: isDownloadAble === 'true' || isDownloadAble === true,
            shortId: payloadShortId || payloadTransferId || nanoid(8)
        });

        if (userId) {
            await User.findByIdAndUpdate(userId, { $inc: { storageUsed: totalSize } });
        }

        const shareLink = `${process.env.CLIENT_URL}/${file.shortId}`;
        console.log("share link", shareLink);

        (async () => {
            try {
                if (files.length > 1) {
                    await triggerWorkerZip(file._id.toString(), files, file.shortId);
                }
                if (uploadType === 'Videos') {
                    console.log("[VIDEO] Starting background resolution extraction for", file.shortId);
                    await extractVideoResolutions(file._id, files);
                }
            } catch (err) {
                console.error("[BACKGROUND] Error:", err);
            }
        })();

        if (getShareableLink === 'true' || getShareableLink === true) {
            return res.status(200).json({
                status: true,
                msg: "Share Link Generated",
                shareLink
            });
        }

        const fileCount = files.length;
        const subject = `${senderEmail} shared ${fileCount} file${fileCount > 1 ? "s" : ""} with you via SendByCloud`;
        const formattedExpireDate = expireDate
            ? new Date(expireDate).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
            : "N/A";

        const text = `${senderEmail} shared ${fileCount} file${fileCount > 1 ? "s" : ""} with you via SendByCloud.\n\nDownload: ${shareLink}\n\nThis link expires on: ${formattedExpireDate}`;

        // send email to receiver
        await sendEmail({
            to: recevierEmails,
            subject,
            text,
            html: buildFileReceivedHtml({
                senderEmail,
                shareLink,
                fileCount: files.length,
                totalSize: totalSize,
                expireDate: expireDate,
                clientUrl: process.env.CLIENT_URL,
            }),
        });


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
    const {
        files,
        transferId: existingId
    } = req.body;
    try {
        if (!files || !Array.isArray(files) || files.length === 0) {
            return res.status(400).json({ status: false, error: "Please provide an array of files" });
        }

        const transferId = existingId || nanoid(8);
        console.log("Generating upload URLs for transfer:", transferId);

        const folderPrefix = process.env.R2_FOLDER ? `${process.env.R2_FOLDER}/` : "";
        const uploadUrls = await Promise.all(
            files.map(async (file) => {
                const safeName = sanitizeFileName(file.fileName);
                const objectKey = `${folderPrefix}transfers/${transferId}/${safeName}`;

                const command = new PutObjectCommand({
                    Bucket: process.env.R2_BUCKET_NAME,
                    Key: objectKey,
                    ContentType: file.fileType,
                });

                const url = await getSignedUrl(r2Client, command, { expiresIn: 10800 });
                return {
                    originalName: file.fileName,
                    objectKey,
                    url
                };
            })
        );
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
    const { fileName, fileType, transferId: existingId, partCount = 0 } = req.body;
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
        const uploadId = response.UploadId;

        // Optimized Batch Start: Sign the first batch of URLs immediately
        const initialUrls = {};
        if (partCount > 0) {
            const batchSize = Math.min(partCount, 100); // First batch of presigned part URLs
            await Promise.all(
                Array.from({ length: batchSize }, async (_, i) => {
                    const pn = i + 1;
                    const partCommand = new UploadPartCommand({
                        Bucket: process.env.R2_BUCKET_NAME,
                        Key: objectKey,
                        UploadId: uploadId,
                        PartNumber: pn,
                    });
                    initialUrls[pn] = await getSignedUrl(r2Client, partCommand, { expiresIn: 3600 });
                })
            );
        }

        return res.status(200).json({
            status: true,
            msg: "Multipart upload initiated",
            uploadId,
            transferId,
            key: objectKey,
            initialUrls
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
 * @Description Generate multiple presigned URLs for specific parts (Batch)
 * @Route POST api/transfer/get-part-urls
 * @Access Public
 */
export const getPartUploadUrls = async (req, res) => {
    const { uploadId, key, partNumbers } = req.body;
    try {
        if (!uploadId || !key || !partNumbers || !Array.isArray(partNumbers)) {
            return res.status(400).json({
                status: false,
                error: "uploadId, key, and partNumbers array are required"
            });
        }

        const urls = {};
        // Parallelize signing — getSignedUrl is fast but async
        await Promise.all(
            partNumbers.map(async (pn) => {
                const command = new UploadPartCommand({
                    Bucket: process.env.R2_BUCKET_NAME,
                    Key: key,
                    UploadId: uploadId,
                    PartNumber: Number(pn),
                });
                urls[pn] = await getSignedUrl(r2Client, command, { expiresIn: 3600 });
            })
        );

        return res.status(200).json({
            status: true,
            urls
        });
    } catch (error) {
        console.error("Error generating part URLs (batch):", error);
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

        // Remove sensitive fields from preview
        const transferObj = transfer.toObject();
        const isProtected = !!transferObj.password;
        delete transferObj.password;

        return res.status(200).json({
            status: true,
            msg: "Transfer found",
            isProtected,
            transferDetails: transferObj
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
        // Find the transfer record
        const transfer = await File.findById(id);

        if (!transfer) {
            return res.status(404).json({ status: false, msg: "Transfer not found" });
        }

        // Reduce user storage defensively
        if (transfer.user && transfer.totalSize && transfer.totalSize > 0) {
            await User.updateOne(
                { _id: transfer.user },
                [
                    {
                        $set: {
                            storageUsed: {
                                $max: [0, { $subtract: ["$storageUsed", transfer.totalSize] }]
                            }
                        }
                    }
                ]
            );
        }

        await File.findByIdAndDelete(id);

        // Run cleanup in background
        cleanupFiles(transfer);

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
                return f.qualities.some(q => {
                    if (q.key === key) return true;
                    if (q.key.endsWith('.m3u8') && key.endsWith('.ts')) {
                        const dirPrefix = q.key.substring(0, q.key.lastIndexOf('/') + 1);
                        if (key.startsWith(dirPrefix)) return true;
                    }
                    return false;
                });
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

            // Add caching for chunks
            if (key.endsWith('.ts') || key.endsWith('.mp4')) {
                res.setHeader('Cache-Control', 'public, max-age=31536000');
            } else if (key.endsWith('.m3u8')) {
                res.setHeader('Cache-Control', 'no-cache');
            }

            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': metadata.ContentType || (key.endsWith('.mp4') ? 'video/mp4' : 'video/MP2T'),
            });
            response.Body.pipe(res);
        } else {
            // Add caching for segments
            if (key.endsWith('.ts') || key.endsWith('.mp4')) {
                res.setHeader('Cache-Control', 'public, max-age=31536000');
            } else if (key.endsWith('.m3u8')) {
                res.setHeader('Cache-Control', 'no-cache');
            }

            res.writeHead(200, {
                'Content-Length': fileSize,
                'Content-Type': metadata.ContentType || (key.endsWith('.mp4') ? 'video/mp4' : 'video/MP2T'),
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


/**
 * @Description Generate ALL presigned URLs for all parts in one shot
 * @Route POST api/transfer/get-all-part-urls
 * @Access Public
 */
export const getAllPartUploadUrls = async (req, res) => {
    const { uploadId, key, totalParts } = req.body;
    console.log('get-all-part-urls called:', { uploadId, key, totalParts });
    try {
        if (!uploadId || !key || !totalParts) {
            return res.status(400).json({
                status: false,
                error: "uploadId, key, and totalParts are required"
            });
        }

        const count = Number(totalParts);
        if (!Number.isFinite(count) || count < 1 || count > 10000) {
            return res.status(400).json({
                status: false,
                error: "totalParts must be a number between 1 and 10000"
            });
        }

        // ✅ Sign all URLs in parallel — getSignedUrl is CPU-bound not I/O-bound
        // so Promise.all here is safe and fast regardless of part count
        const urls = await Promise.all(
            Array.from({ length: count }, (_, i) => {
                const command = new UploadPartCommand({
                    Bucket: process.env.R2_BUCKET_NAME,
                    Key: key,
                    UploadId: uploadId,
                    PartNumber: i + 1,
                });
                return getSignedUrl(r2Client, command, { expiresIn: 3600 });
            })
        );


        console.log('Generated', urls.length, 'URLs');
        return res.status(200).json({
            status: true,
            urls  // 0-indexed array: urls[0] = part 1, urls[1] = part 2, etc.
        });
    } catch (error) {
        console.error("Error generating all part URLs:", error);
        return res.status(500).json({ status: false, msg: error.message });
    }
};

/**
 * @Description Get all presigned download URLs for a file (Batch)
 * @Route POST api/transfer/get-all-download-part-urls/:shortId
 * @Access Public
 */
export const getAllDownloadPartUrls = async (req, res) => {
    const { shortId } = req.params;
    const { key, partSize, totalSize, password = "" } = req.body;

    try {
        if (!key || !partSize || !totalSize) {
            return res.status(400).json({ status: false, error: "key, partSize, and totalSize are required" });
        }

        const isObjectId = mongoose.Types.ObjectId.isValid(shortId);
        const transfer = await File.findOne(isObjectId ? { _id: shortId } : { shortId });
        if (!transfer) {
            return res.status(404).json({ status: false, msg: "Transfer not found" });
        }

        // Check password if set
        if (transfer.password && transfer.password !== password) {
            return res.status(401).json({ status: false, msg: "Invalid password" });
        }

        // Security: Verify that this key belongs to this transfer
        const isValidFile = transfer.files.some(f => (typeof f === 'string' ? f : f.key) === key);
        if (!isValidFile) {
            return res.status(403).json({ status: false, msg: "Unauthorized: File does not belong to this transfer" });
        }

        const numParts = Math.ceil(totalSize / partSize);
        const maxRangeParts = 10000;
        if (numParts > maxRangeParts) {
            return res.status(400).json({
                status: false,
                msg: `Too many parts (max ${maxRangeParts}); use a larger partSize for this file`
            });
        }

        // Parallel sign all URLs
        const parts = await Promise.all(
            Array.from({ length: numParts }, async (_, i) => {
                const start = i * partSize;
                const end = Math.min((i + 1) * partSize, totalSize) - 1;

                const command = new GetObjectCommand({
                    Bucket: process.env.R2_BUCKET_NAME,
                    Key: key,
                });

                const url = await getSignedUrl(r2Client, command, {
                    expiresIn: 3600,
                    signableHeaders: new Set(["range"])
                });

                return {
                    partNumber: i + 1,
                    url,
                    range: { start, end }
                };
            })
        );

        return res.status(200).json({
            status: true,
            parts
        });
    } catch (error) {
        console.error("Error generating all download part URLs:", error);
        return res.status(500).json({ status: false, msg: error.message });
    }
};

export const zipCompleteWebhook = async (req, res) => {
    // Verify it's from your worker
    const secret = req.headers['x-worker-secret'];
    if (secret !== process.env.WORKER_SECRET) {
        return res.status(401).json({ status: false });
    }

    const { transferId, zipKey, shortId, error } = req.body;

    if (error) {
        console.error(`[ZIP] Worker reported error for ${shortId}:`, error);
        return res.status(200).json({ status: true });
    }

    await File.findByIdAndUpdate(transferId, { 
        zipKey,
        zipReady: true 
    });

    console.log(`[ZIP] ZIP ready for ${shortId}: ${zipKey}`);
    return res.status(200).json({ status: true });
};