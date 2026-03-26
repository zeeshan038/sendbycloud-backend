//NPM Packages
import jwt from "jsonwebtoken";
import { Upload } from "@aws-sdk/lib-storage";
import archiver from "archiver";
import { PassThrough } from "stream";
import fs from "fs";
import path from "path";
import os from "os";
import { nanoid } from "nanoid";
import { getVideoMetadata, RESOLUTIONS,transcodeMultipleResolutions } from "./videoProcessor.js";

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import r2Client from "./R2.js";
import File from "../models/files.js";

export const generateToken = (user) => {
    return jwt.sign({ user }, process.env.JWT_SECRET, { expiresIn: "1h" });
};

export const sanitizeFileName = (fileName) => {
    return fileName.replace(/[^a-zA-Z0-9.\-_]/g, "_");
};




export const createZipAndUpload = async (transferId, files, shortId) => {
    let upload;
    try {
        const archive = archiver('zip', {
            zlib: { level: 9 }
        });

        archive.on("error", (err) => {
            console.error(`[ZIP] Archiver Error for ${shortId}:`, err);
            if (upload) upload.abort();
        });

        const passThrough = new PassThrough();
        const folderPrefix = process.env.R2_FOLDER ? `${process.env.R2_FOLDER}/` : "";
        const zipKey = `${folderPrefix}transfers/sendbycloud-${shortId}.zip`;

        upload = new Upload({
            client: r2Client,
            params: {
                Bucket: process.env.R2_BUCKET_NAME,
                Key: zipKey,
                Body: passThrough,
                ContentType: 'application/zip'
            },
            queueSize: 10,
            partSize: 10 * 1024 * 1024
        });

        archive.pipe(passThrough);

        const fetchedFiles = await Promise.all(files.map(async (fileData) => {
            const objectKey = typeof fileData === 'string' ? fileData : fileData.key;
            const originalName = typeof fileData === 'object' && fileData.name
                ? fileData.name
                : (objectKey.split('_').slice(1).join('_') || objectKey);

            const response = await r2Client.send(new GetObjectCommand({
                Bucket: process.env.R2_BUCKET_NAME,
                Key: objectKey,
            }));
            return { body: response.Body, name: originalName };
        }));

        for (const { body, name } of fetchedFiles) {
            const entryName = files.length > 1 ? `Files/${name}` : name;
            archive.append(body, { name: entryName });
            console.log(`[ZIP] Appended ${name} to archive`);
        }

        // Finalize the archive after all files are appended
        archive.finalize();

        // Wait for the upload to complete
        await upload.done();

        await File.findByIdAndUpdate(transferId, { zipKey });
        console.log(`[ZIP] Success for transfer ${shortId}: ${zipKey}`);
    } catch (error) {
        console.error(`[ZIP] Critical Error for ${shortId}:`, error);
        if (upload) {
            try {
                await upload.abort();
                console.log(`[ZIP] Aborted incomplete upload for ${shortId}`);
            } catch (abortError) {
                console.error(`[ZIP] Failed to abort ${shortId}:`, abortError);
            }
        }
    }
};


export const extractVideoResolutions = async (transferId, files) => {
    try {
        const transfer = await File.findById(transferId);
        if (!transfer) return;

        const updatedFiles = transfer.files;

        for (let i = 0; i < updatedFiles.length; i++) {
            const fileData = updatedFiles[i];
            const objectKey = typeof fileData === 'string' ? fileData : fileData.key;

            // Check if it's a video by extension
            const isVideo = /\.(mp4|mov|avi|wmv|flv|webm|mkv|m4v)$/i.test(objectKey);
            if (!isVideo) continue;

            let tempVideoPath = null;
            try {
                tempVideoPath = path.join(os.tmpdir(), `temp-${nanoid()}-${objectKey.split('/').pop()}`);
                console.log(`[VIDEO] Downloading ${objectKey} to ${tempVideoPath} for processing...`);

                const getCommand = new GetObjectCommand({
                    Bucket: process.env.R2_BUCKET_NAME,
                    Key: objectKey,
                });

                const response = await r2Client.send(getCommand);
                const writeStream = fs.createWriteStream(tempVideoPath);

                await new Promise((resolve, reject) => {
                    response.Body.pipe(writeStream);
                    writeStream.on('finish', resolve);
                    writeStream.on('error', reject);
                });

                console.log(`[VIDEO] Download complete. Running ffprobe on local file.`);
                const metadata = await getVideoMetadata(tempVideoPath);

                if (metadata && metadata.shortSide) {
                    // Update metadata immediately
                    const fileToUpdate = typeof updatedFiles[i] === 'string' ? { key: objectKey } : updatedFiles[i];
                    fileToUpdate.resolution = `${metadata.shortSide}p`;
                    fileToUpdate.duration = metadata.duration;
                    fileToUpdate.metadata = metadata;
                    if (!fileToUpdate.qualities) {
                        fileToUpdate.qualities = [{ label: 'Original', key: objectKey, isOriginal: true }];
                    }

                    await File.updateOne(
                        { _id: transferId },
                        { $set: { [`files.${i}`]: fileToUpdate } }
                    );

                    const targets = RESOLUTIONS.filter(r => r.shortSide < metadata.shortSide);
                    if (targets.length > 0) {
                        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcode-'));
                        try {
                            console.log(`Starting multi-resolution transcoding for ${objectKey} in ${tempDir}`);
                            const outputFiles = await transcodeMultipleResolutions(tempVideoPath, targets, tempDir);

                            await Promise.all(outputFiles.map(async (outFile) => {
                                const pathParts = objectKey.split('/');
                                const fileName = pathParts.pop();
                                const folderPath = pathParts.join('/');
                                const resKey = `${folderPath}/${outFile.label}_${fileName}`;

                                const fileStream = fs.createReadStream(outFile.path);
                                const upload = new Upload({
                                    client: r2Client,
                                    params: {
                                        Bucket: process.env.R2_BUCKET_NAME,
                                        Key: resKey,
                                        Body: fileStream,
                                        ContentType: 'video/mp4'
                                    }
                                });

                                await upload.done();
                                console.log(`Uploaded ${outFile.label} to R2`);

                                await File.updateOne(
                                    { _id: transferId },
                                    { $push: { [`files.${i}.qualities`]: { label: outFile.label, key: resKey, isOriginal: false } } }
                                );
                            }));
                        } finally {
                            try {
                                fs.rmSync(tempDir, { recursive: true, force: true });
                            } catch (e) {
                                console.error(`Error cleaning up tempDir ${tempDir}:`, e.message);
                            }
                        }
                    }
                }
            } catch (err) {
                console.warn(`[VIDEO] Could not process video ${objectKey} in bucket ${process.env.R2_BUCKET_NAME}:`, err.message);
                if (err.name === 'NoSuchKey' || err.code === 'NoSuchKey' || err.message.includes('key does not exist')) {
                    console.error(`[VIDEO] CRITICAL: Key "${objectKey}" not found. Current R2_FOLDER is "${process.env.R2_FOLDER}". Check if this matches your storage structure.`);
                }
            } finally {
                if (tempVideoPath && fs.existsSync(tempVideoPath)) {
                    try {
                        fs.unlinkSync(tempVideoPath);
                        console.log(`Cleaned up temp video file: ${tempVideoPath}`);
                    } catch (e) {
                        console.error(`Error deleting temp video file ${tempVideoPath}:`, e.message);
                    }
                }
            }
        }
    } catch (error) {
        console.error("Error in extractVideoResolutions:", error);
    }
};

export const calculateExpireDate = (expireIn) => {
    if (!expireIn || expireIn === "unlimited") return null;

    const now = new Date();
    // Match patterns like "7d", "1 Day", "3 Months", "2 Years"
    const match = expireIn.match(/^(\d+)\s*(d|Day|Days|Month|Months|Year|Years)$/i);
    
    let value, unit;
    if (match) {
        value = parseInt(match[1]);
        unit = match[2].toLowerCase();
    } else if (expireIn.match(/^\d+d$/i)) {
        value = parseInt(expireIn);
        unit = 'd';
    } else {
        return null;
    }

    if (unit.startsWith('d')) {
        now.setDate(now.getDate() + value);
    } else if (unit.startsWith('m')) {
        now.setMonth(now.getMonth() + value);
    } else if (unit.startsWith('y')) {
        now.setFullYear(now.getFullYear() + value);
    }

    return now;
};