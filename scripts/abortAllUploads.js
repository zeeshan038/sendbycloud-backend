import 'dotenv/config';
import r2Client from '../utils/R2.js';
import { ListMultipartUploadsCommand, AbortMultipartUploadCommand } from '@aws-sdk/client-s3';

async function abortAll() {
    try {
        console.log("-----------------------------------------");
        console.log("ABORING ALL INCOMPLETE MULTIPART UPLOADS");
        console.log("-----------------------------------------");

        let totalAborted = 0;
        let keyMarker;
        let uploadIdMarker;

        do {
            const listCommand = new ListMultipartUploadsCommand({
                Bucket: process.env.R2_BUCKET_NAME,
                KeyMarker: keyMarker,
                UploadIdMarker: uploadIdMarker,
            });

            const res = await r2Client.send(listCommand); 

            if (res.Uploads && res.Uploads.length > 0) {
                console.log(`Found ${res.Uploads.length} incomplete uploads. Aborting...`);
                
                await Promise.all(res.Uploads.map(async (upload) => {
                    try {
                        const abortCommand = new AbortMultipartUploadCommand({
                            Bucket: process.env.R2_BUCKET_NAME,
                            Key: upload.Key,
                            UploadId: upload.UploadId,
                        });
                        await r2Client.send(abortCommand);
                        totalAborted++;
                    } catch (err) {
                        console.error(`Failed to abort ${upload.Key} (ID: ${upload.UploadId}):`, err.message);
                    }
                }));
            }

            keyMarker = res.NextKeyMarker;
            uploadIdMarker = res.NextUploadIdMarker;
        } while (keyMarker || uploadIdMarker);

        console.log("-----------------------------------------");
        console.log(`Success: Aborted ${totalAborted} total uploads.`);
        console.log("-----------------------------------------");
        
        process.exit(0);
    } catch (error) {
        console.error("CRITICAL ERROR DURING ABORT:", error);
        process.exit(1);
    }
}

abortAll();
