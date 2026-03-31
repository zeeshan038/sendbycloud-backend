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
