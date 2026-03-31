import 'dotenv/config';
import r2Client from '../utils/R2.js';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';

async function list() {
    try {
        console.log("Listing top 100 objects in bucket:", process.env.R2_BUCKET_NAME);
        const res = await r2Client.send(new ListObjectsV2Command({ 
            Bucket: process.env.R2_BUCKET_NAME,
            MaxKeys: 100 
        }));
        
        if (!res.Contents || res.Contents.length === 0) {
            console.log("Bucket is empty according to ListObjectsV2.");
        } else {
            res.Contents.forEach(obj => {
                console.log(`- ${obj.Key} (${obj.Size} bytes)`);
            });
            console.log(`\nTotal shown: ${res.Contents.length}`);
            if (res.IsTruncated) console.log("More objects exist...");
        }
    } catch (err) {
        console.error("Error listing objects:", err);
    }
}

list();
