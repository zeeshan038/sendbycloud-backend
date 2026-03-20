import mongoose from "mongoose";
import { nanoid } from "nanoid";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import r2Client from "../../utils/R2.js";

// Models
import File from "../../models/files.js";

const SIGNED_URL_EXPIRY = 3600;

/**
 * @Description Get download metadata and signed URLs
 * @Route GET api/transfer/download/:shortId
 * @Access Public
 */
export const getDownloadUrl = async (req, res) => {
    const { shortId } = req.params;
    const { preview = false, password = "" } = req.query;
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

        // Check password if set
        if (transfer.password && transfer.password !== password) {
            return res.status(401).json({
                status: false,
                msg: "Invalid password for this transfer"
            });
        }

        if (transfer.selfDestruct && transfer.downloadCount >= 1) {
            return res.status(410).json({
                status: false,
                msg: "This transfer has self-destructed and is no longer available."
            });
        }

        const downloadSessionId = nanoid(12);

        const fileUrls = await Promise.all(
            transfer.files.map(async (fileData) => {
                const objectKey = typeof fileData === 'string' ? fileData : fileData.key;

                const originalName = typeof fileData === 'object' && fileData.name
                    ? fileData.name
                    : (objectKey.split('_').slice(1).join('_') || objectKey);

                const command = new GetObjectCommand({
                    Bucket: process.env.R2_BUCKET_NAME,
                    Key: objectKey,
                    ResponseContentDisposition: preview === 'true'
                        ? 'inline'
                        : `attachment; filename="${originalName}"; filename*=UTF-8''${encodeURIComponent(originalName)}`
                });

                const url = await getSignedUrl(r2Client, command, { expiresIn: SIGNED_URL_EXPIRY });

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
                            const qUrl = await getSignedUrl(r2Client, qCommand, { expiresIn: SIGNED_URL_EXPIRY });
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
                    size: typeof fileData === 'object' ? fileData.size || null : null,
                    contentType: typeof fileData === 'object' ? fileData.type || fileData.fileType || null : null,
                    rangeSupported: true,
                    qualities: qualityUrls.length > 0 ? qualityUrls : null,
                    resolution: fileData.resolution || null,
                    duration: fileData.duration || null,
                    streamUrl: /\.(mp4|mov|avi|wmv|flv|webm|mkv|m4v)$/i.test(originalName) 
                        ? `${process.env.BACKEND_URL || 'http://localhost:8080'}/api/transfer/stream/${transfer.shortId}?key=${encodeURIComponent(objectKey)}`
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
                zipUrl = await getSignedUrl(r2Client, zipCommand, { expiresIn: SIGNED_URL_EXPIRY });
                zipStatus = "ready";
            } else {
                zipStatus = "processing";
            }
        }

        return res.status(200).json({
            status: true,
            downloadSessionId,
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
 * @Description Mark download as started
 * @Route POST api/transfer/download-start/:shortId
 * @Access Public
 */
export const startDownload = async (req, res) => {
    const { shortId } = req.params;
    const { downloadSessionId } = req.body;
    try {
        if (!downloadSessionId) {
            return res.status(400).json({ status: false, msg: "downloadSessionId is required" });
        }

        const isObjectId = mongoose.Types.ObjectId.isValid(shortId);
        const transfer = await File.findOne(
            isObjectId ? { _id: shortId } : { shortId: shortId }
        );

        if (!transfer) {
            return res.status(404).json({ status: false, msg: "Transfer not found" });
        }

        console.log(`Download started for transfer: ${shortId} (Session: ${downloadSessionId})`);

        return res.status(200).json({
            status: true,
            msg: "Download marked as started"
        });
    } catch (error) {
        return res.status(500).json({
            status: false,
            msg: error.message
        });
    }
};

/**
 * @Description Mark download as complete and increment downloadCount
 * @Route POST api/transfer/download-complete/:shortId
 * @Access Public
 */
export const completeDownload = async (req, res) => {
    const { shortId } = req.params;
    const { downloadSessionId } = req.body;
    try {
        if (!downloadSessionId) {
            return res.status(400).json({ status: false, msg: "downloadSessionId is required" });
        }

        const isObjectId = mongoose.Types.ObjectId.isValid(shortId);
        const transfer = await File.findOne(
            isObjectId ? { _id: shortId } : { shortId: shortId }
        );

        if (!transfer) {
            return res.status(404).json({ status: false, msg: "Transfer not found" });
        }

        if (transfer.selfDestruct && transfer.downloadCount >= 1) {
            return res.status(410).json({
                status: false,
                msg: "This transfer has already self-destructed."
            });
        }

        // Atomic increment
        const updated = await File.findOneAndUpdate(
            isObjectId ? { _id: shortId } : { shortId: shortId },
            { $inc: { downloadCount: 1 } },
            { new: true }
        );

        console.log(`Download completed for transfer: ${shortId}. New count: ${updated.downloadCount}`);

        return res.status(200).json({
            status: true,
            msg: "Download marked as complete",
            downloadCount: updated.downloadCount
        });
    } catch (error) {
        return res.status(500).json({
            status: false,
            msg: error.message
        });
    }
};

/**
 * @Description Mark download as cancelled
 * @Route POST api/transfer/download-cancel/:shortId
 * @Access Public
 */
export const cancelDownload = async (req, res) => {
    const { shortId } = req.params;
    const { downloadSessionId } = req.body;
    try {
        if (!downloadSessionId) {
            return res.status(400).json({ status: false, msg: "downloadSessionId is required" });
        }

        const isObjectId = mongoose.Types.ObjectId.isValid(shortId);
        const transfer = await File.findOne(
            isObjectId ? { _id: shortId } : { shortId: shortId }
        );

        if (!transfer) {
            return res.status(404).json({ status: false, msg: "Transfer not found" });
        }

        console.log(`Download cancelled for transfer: ${shortId} (Session: ${downloadSessionId})`);

        return res.status(200).json({
            status: true,
            msg: "Download marked as cancelled"
        });
    } catch (error) {
        return res.status(500).json({
            status: false,
            msg: error.message
        });
    }
};

/**
 * @Description Generate a presigned URL for a specific download part (range)
 * @Route POST api/transfer/download-part/:shortId
 * @Access Public
 */
export const getDownloadPartUrl = async (req, res) => {
    const { shortId } = req.params;
    const { key, partNumber, partSize, password = "" } = req.body;

    try {
        if (!key || partNumber === undefined || !partSize) {
            return res.status(400).json({ status: false, msg: "key, partNumber, and partSize are required" });
        }

        const isObjectId = mongoose.Types.ObjectId.isValid(shortId);
        const transfer = await File.findOne(
            isObjectId ? { _id: shortId } : { shortId: shortId }
        );

        if (!transfer) {
            return res.status(404).json({ status: false, msg: "Transfer not found" });
        }

        // Check password if set
        if (transfer.password && transfer.password !== password) {
            return res.status(401).json({ status: false, msg: "Invalid password" });
        }

        // Verify key ownership
        const isValidFile = transfer.files.some(f => {
            const mainKey = typeof f === 'string' ? f : f.key;
            if (mainKey === key) return true;
            if (f.qualities && Array.isArray(f.qualities)) {
                return f.qualities.some(q => q.key === key);
            }
            return false;
        });

        if (!isValidFile) {
            return res.status(403).json({ status: false, msg: "Unauthorized: File does not belong to this transfer" });
        }

        // Calculate byte range
        const start = Number(partNumber) * Number(partSize);
        const end = start + Number(partSize) - 1;

        const command = new GetObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: key,
            Range: `bytes=${start}-${end}`
        });

        const url = await getSignedUrl(r2Client, command, { expiresIn: 3600 });

        return res.status(200).json({
            status: true,
            url,
            range: { start, end }
        });

    } catch (error) {
        console.error("Error generating part download URL:", error);
        return res.status(500).json({ status: false, msg: error.message });
    }
};
