import "dotenv/config";
import mongoose from "mongoose";
import connectDb from "../config/db.js";
import User from "../models/User.js";
import File from "../models/files.js";

const recalculateStorage = async () => {
    try {
        await connectDb();
        console.log("Starting storage recalculation...");

        const users = await User.find({});
        console.log(`Found ${users.length} users to process.`);

        for (const user of users) {
            // Find all active files for this user
            const activeFiles = await File.find({ user: user._id, status: "active" });
            const actualStorageUsed = activeFiles.reduce((sum, file) => sum + (file.totalSize || 0), 0);

            if (user.storageUsed !== actualStorageUsed) {
                console.log(`Fixing storage for user ${user.email}: ${user.storageUsed} -> ${actualStorageUsed}`);
                user.storageUsed = actualStorageUsed;
                await user.save();
            } else {
                // Also fix negative values if they were somehow "correct" but negative (unlikely)
                if (user.storageUsed < 0) {
                    console.log(`Fixing negative storage for user ${user.email}: ${user.storageUsed} -> 0`);
                    user.storageUsed = 0;
                    await user.save();
                } else {
                    console.log(`User ${user.email} storage is correct: ${actualStorageUsed}`);
                }
            }
        }

        console.log("Recalculation completed successfully.");
        process.exit(0);
    } catch (error) {
        console.error("Error during recalculation:", error);
        process.exit(1);
    }
};

recalculateStorage();
