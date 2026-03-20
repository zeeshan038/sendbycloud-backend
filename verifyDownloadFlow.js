import mongoose from "mongoose";
import "dotenv/config";
import File from "./models/files.js";

const API_URL = "http://localhost:8080/api/transfer";
const SHORT_ID = "lR0tKvMuRJ";

async function verifyFlow() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        
        // 1. Get initial count
        let file = await File.findOne({ shortId: SHORT_ID });
        const initialCount = file.downloadCount;
        console.log(`Initial downloadCount: ${initialCount}`);

        // 2. Call GET /download/:shortId
        console.log(`Calling GET ${API_URL}/download/${SHORT_ID}`);
        const getRes = await fetch(`${API_URL}/download/${SHORT_ID}`);
        if (!getRes.ok) throw new Error(`GET failed: ${getRes.status}`);
        
        // 3. Verify count hasn't changed
        file = await File.findOne({ shortId: SHORT_ID });
        console.log(`downloadCount after GET: ${file.downloadCount}`);
        if (file.downloadCount !== initialCount) {
            console.error("ERROR: downloadCount incremented on GET request!");
        } else {
            console.log("SUCCESS: downloadCount remained the same after GET.");
        }

        // 4. Call POST /download-complete/:shortId
        console.log(`Calling POST ${API_URL}/download-complete/${SHORT_ID}`);
        const postRes = await fetch(`${API_URL}/download-complete/${SHORT_ID}`, { method: 'POST' });
        if (!postRes.ok) throw new Error(`POST failed: ${postRes.status}`);
        
        // 5. Verify count has incremented
        file = await File.findOne({ shortId: SHORT_ID });
        console.log(`downloadCount after POST complete: ${file.downloadCount}`);
        if (file.downloadCount === initialCount + 1) {
            console.log("SUCCESS: downloadCount incremented after POST complete.");
        } else {
            console.error(`ERROR: downloadCount is ${file.downloadCount}, expected ${initialCount + 1}`);
        }

        process.exit(0);
    } catch (err) {
        console.error("Verification failed:", err.message);
        process.exit(1);
    }
}

verifyFlow();
