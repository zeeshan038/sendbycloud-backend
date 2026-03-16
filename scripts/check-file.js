import "dotenv/config";
import mongoose from "mongoose";
import File from "../models/files.js";

async function check() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        const file = await File.findOne({ shortId: "p7vyLQ9oJN" });
        console.log("File found:", file);
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}
check();
