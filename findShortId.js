import mongoose from "mongoose";
import "dotenv/config";
import File from "./models/files.js";

async function findShortId() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        const file = await File.findOne();
        if (file) {
            console.log(file.shortId);
        } else {
            console.log("No files found");
        }
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

findShortId();
