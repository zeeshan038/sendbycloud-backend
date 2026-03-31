import "dotenv/config";
import mongoose from "mongoose";
import { ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import r2Client from "../utils/R2.js";
import File from "../models/files.js";
import User from "../models/User.js";

async function clearAll() {
    try {
        console.log("-----------------------------------------");
        console.log("DANGER: PERMANENT DATA WIPE IN PROGRESS");
        console.log("-----------------------------------------");

        console.log("Connecting to MongoDB...");
        await mongoose.connect(process.env.MONGO_URI);
        console.log("Connected.");

        const folderPrefix = process.env.R2_FOLDER ? `${process.env.R2_FOLDER}/` : "";
        const transfersPrefix = `${folderPrefix}transfers/`;

        console.log(`Step 1: Deleting R2 objects under prefix: ${transfersPrefix}`);
        
        let continuationToken;
        let totalObjectsDeleted = 0;

        do {
            const listCommand = new ListObjectsV2Command({
                Bucket: process.env.R2_BUCKET_NAME,
                Prefix: transfersPrefix,
                ContinuationToken: continuationToken,
            });
 
            const listedObjects = await r2Client.send(listCommand);

            if (listedObjects.Contents && listedObjects.Contents.length > 0) {
                const deleteParams = {
                    Bucket: process.env.R2_BUCKET_NAME,
                    Delete: {
                        Objects: listedObjects.Contents.map(({ Key }) => ({ Key })),
                        Quiet: true,
                    },
                };

                await r2Client.send(new DeleteObjectsCommand(deleteParams));
                totalObjectsDeleted += listedObjects.Contents.length;
                console.log(`Deleted ${listedObjects.Contents.length} objects...`);
            }

            continuationToken = listedObjects.NextContinuationToken;
        } while (continuationToken);

        console.log(`Success: Deleted ${totalObjectsDeleted} objects from R2.`);

        console.log("Step 2: Clearing File collection in MongoDB...");
        const fileResult = await File.deleteMany({});
        console.log(`Success: Deleted ${fileResult.deletedCount} file records from DB.`);

        console.log("Step 3: Resetting storageUsed for all users...");
        const userResult = await User.updateMany({}, { $set: { storageUsed: 0 } });
        console.log(`Success: Reset storage count for ${userResult.modifiedCount} users.`);

        console.log("-----------------------------------------");
        console.log("ALL DATA WIPED SUCCESSFULLY");
        console.log("-----------------------------------------");
        
        process.exit(0);
    } catch (error) {
        console.error("CRITICAL ERROR DURING CLEANUP:", error);
        process.exit(1);
    }
}

clearAll();
