import "dotenv/config";
import { S3Client, PutBucketCorsCommand } from "@aws-sdk/client-s3";

const r2Client = new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});

const corsConfig = {
    Bucket: process.env.R2_BUCKET_NAME,
    CORSConfiguration: {
        CORSRules: [
            {
                AllowedOrigins: ["http://localhost:5173", "https://send-v-2.vercel.app"],
                AllowedMethods: ["GET", "PUT", "POST", "DELETE", "HEAD"],
                AllowedHeaders: ["*"],
                ExposeHeaders: ["ETag"],
                MaxAgeSeconds: 3000,
            },
        ],
    },
};

async function setupCORS() {
    try {
        console.log("Setting up CORS for bucket:", process.env.R2_BUCKET_NAME);
        const command = new PutBucketCorsCommand(corsConfig);
        await r2Client.send(command);
        console.log("SUCCESS: CORS policy updated successfully!");
    } catch (err) {
        console.error("ERROR updating CORS policy:", err);
    }
}

setupCORS();
