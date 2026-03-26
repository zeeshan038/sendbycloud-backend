import r2Client from "./R2.js";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import File from "../models/files.js";


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
                    console.log(`[CLEANUP] Destroying transfer: ${transfer._id} (${transfer.shortId})`);

                    // 1. Delete all original files and their qualities
                    for (const fileItem of transfer.files) {
                        const mainKey = typeof fileItem === 'string' ? fileItem : fileItem.key;
                        if (mainKey) {
                            await deleteFromR2(mainKey);
                        }

                        // Delete transcoded qualities if they exist
                        if (fileItem.qualities && Array.isArray(fileItem.qualities)) {
                            for (const quality of fileItem.qualities) {
                                if (quality.key && quality.key !== mainKey) {
                                    await deleteFromR2(quality.key);
                                }
                            }
                        }
                    }

                    // 2. Delete zipKey if it exists
                    if (transfer.zipKey) {
                        await deleteFromR2(transfer.zipKey);
                    }

                    // 3. Mark as destroyed in DB
                    transfer.status = "destroyed";
                    await transfer.save();

                    console.log(`[CLEANUP] Successfully destroyed transfer: ${transfer._id}`);
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

const deleteFromR2 = async (key) => {
    try {
        const command = new DeleteObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: key,
        });
        await r2Client.send(command);
        console.log(`[CLEANUP] Deleted from R2: ${key}`);
    } catch (err) {
        console.error(`[CLEANUP] Error deleting ${key} from R2:`, err.message);
    }
};
