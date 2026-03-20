import mongoose from "mongoose";
import "dotenv/config";
import File from "./models/files.js";

const API_URL = "http://127.0.0.1:8080/api/transfer";
const SHORT_ID = "lR0tKvMuRJ";

async function verifyPerfectedFlow() {
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
        
        const getData = await getRes.json();
        console.log("GET Response received.");
        
        // Check session ID
        if (!getData.downloadSessionId) {
            throw new Error("Missing downloadSessionId in GET response");
        }
        console.log(`Received downloadSessionId: ${getData.downloadSessionId}`);

        // Check enhanced metadata
        const firstFile = getData.files[0];
        console.log("First file metadata:", JSON.stringify(firstFile, null, 2));
        if (firstFile.size === undefined || firstFile.contentType === undefined || firstFile.rangeSupported !== true) {
            throw new Error("Missing or incorrect enhanced metadata (size, contentType, rangeSupported)");
        }
        console.log("SUCCESS: Enhanced metadata found.");

        // 3. Call POST /download-complete/:shortId with session ID
        console.log(`Calling POST ${API_URL}/download-complete/${SHORT_ID}`);
        const postRes = await fetch(`${API_URL}/download-complete/${SHORT_ID}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ downloadSessionId: getData.downloadSessionId })
        });
        
        if (!postRes.ok) {
            const errorData = await postRes.json();
            throw new Error(`POST failed: ${postRes.status} - ${errorData.msg}`);
        }
        
        const postData = await postRes.json();
        console.log(`POST Response: ${postData.msg}, new count: ${postData.downloadCount}`);

        // 4. Verify count has incremented atomically
        file = await File.findOne({ shortId: SHORT_ID });
        if (file.downloadCount === initialCount + 1) {
            console.log("SUCCESS: downloadCount incremented correctly.");
        } else {
            console.error(`ERROR: downloadCount is ${file.downloadCount}, expected ${initialCount + 1}`);
        }

        // 5. Test missing session ID error
        console.log("Testing POST without downloadSessionId...");
        const failRes = await fetch(`${API_URL}/download-complete/${SHORT_ID}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        if (failRes.status === 400) {
            console.log("SUCCESS: Correctly rejected missing session ID.");
        } else {
            console.error(`ERROR: Expected 400 for missing session ID, got ${failRes.status}`);
        }

        process.exit(0);
    } catch (err) {
        console.error("Verification failed:", err.message);
        process.exit(1);
    }
}

verifyPerfectedFlow();
