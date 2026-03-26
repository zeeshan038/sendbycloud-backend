import 'dotenv/config';
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import r2Client from "../utils/R2.js";

const testKey = process.argv[2];

if (!testKey) {
  console.log("Usage: node scripts/test-r2.js <object-key>");
  process.exit(1);
}

const run = async () => {
  try {
    console.log(`Checking if key "${testKey}" exists in bucket "${process.env.R2_BUCKET_NAME}"...`);
    const command = new HeadObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: testKey,
    });
    const response = await r2Client.send(command);
    console.log("Success! File exists.");
    console.log("Content Length:", response.ContentLength);
    console.log("Content Type:", response.ContentType);
  } catch (error) {
    console.error("Error:", error.message);
    if (error.name === 'NotFound') {
      console.log("\nDIAGNOSIS:");
      console.log(`The key "${testKey}" was not found.`);
      console.log(`Current R2_FOLDER is "${process.env.R2_FOLDER}".`);
      console.log(`Check if the file is actually in that folder in the R2 dashboard.`);
    }
  }
};

run();
