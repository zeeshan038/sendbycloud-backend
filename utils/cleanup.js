import File from "../models/files.js";
import { destroyTransfer } from "./methods.js";

export const startCleanupJob = () => {
    const interval = 2 * 60 * 60 * 1000;

    const runCleanup = async () => {
        console.log("[CLEANUP] Starting expired files cleanup job...");
        try {
            const now = new Date();
            const expiredFiles = await File.find({
                status: "active",
                expireDate: { $lte: now }
            });

            console.log(`[CLEANUP] Found ${expiredFiles.length} expired transfers to destroy.`);

            for (const transfer of expiredFiles) {
                try {
                    await destroyTransfer(transfer);
                } catch (err) {
                    console.error(`[CLEANUP] Failed to destroy transfer ${transfer._id}:`, err.message);
                }
            }
        } catch (error) {
            console.error("[CLEANUP] Error during cleanup job:", error);
        }
    };

    // Run once on startup after a short delay, then on interval
    setTimeout(runCleanup, 10000);
    setInterval(runCleanup, interval);
};




// Cleanup files in R2
export const cleanupFiles = async (transfer) => {
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
    } catch (err) {
        return res.status(404).json({
            status: false,
            msg: err.message
        })
    }
};