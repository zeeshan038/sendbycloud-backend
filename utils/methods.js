//NPM Packages
import jwt from "jsonwebtoken";
import { Upload } from "@aws-sdk/lib-storage";
import archiver from "archiver";
import { PassThrough } from "stream";
import fs from "fs";
import path from "path";
import os from "os";
import { nanoid } from "nanoid";
import { getVideoMetadata, RESOLUTIONS, transcodeVideo } from "./videoProcessor.js";

import { GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import r2Client from "./R2.js";
import File from "../models/files.js";
import User from "../models/User.js";
import { sendEmail, buildFileDestroyedHtml } from "./Nodemailer.js";

export const generateToken = (user) => {
    return jwt.sign({ user }, process.env.JWT_SECRET);
};

export const sanitizeFileName = (fileName) => {
    return fileName.replace(/[^a-zA-Z0-9.\-_]/g, "_");
};


export const createZipAndUpload = async (transferId, files, shortId) => {
    let upload;
    try {
        const transfer = await File.findById(transferId);
        if (!transfer) return;

        const maxZipBytes = process.env.ZIP_MAX_TOTAL_BYTES
            ? Number(process.env.ZIP_MAX_TOTAL_BYTES)
            : 0;
        if (Number.isFinite(maxZipBytes) && maxZipBytes > 0 && transfer.totalSize > maxZipBytes) {
            console.log(
                `[ZIP] Skipped ${shortId}: totalSize ${transfer.totalSize} > ZIP_MAX_TOTAL_BYTES ${maxZipBytes}`
            );
            return;
        }

        const archive = archiver('zip', {
            zlib: { level: 0 } 
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
            queueSize: 20,
            partSize: 100 * 1024 * 1024
        });

        let lastLoggedMB = 0;
        upload.on("httpUploadProgress", (progress) => {
            const loadedMB = Math.floor(progress.loaded / (1024 * 1024));
            if (loadedMB - lastLoggedMB >= 500) {
                console.log(`[ZIP] ${shortId} Progress: ~${loadedMB} MB uploaded`);
                lastLoggedMB = loadedMB;
            }
        });

        archive.pipe(passThrough);

        const appendStreamToArchive = (stream, name) =>
            new Promise((resolve, reject) => {
                const onEntry = () => {
                    archive.off("error", onError);
                    resolve();
                };
                const onError = (err) => {
                    archive.off("entry", onEntry);
                    reject(err);
                };
                archive.once("entry", onEntry);
                archive.once("error", onError);
                archive.append(stream, { name });
            });

        for (const fileData of files) {
            const objectKey = typeof fileData === 'string' ? fileData : fileData.key;
            const originalName = typeof fileData === 'object' && fileData.name
                ? fileData.name
                : (objectKey.split('_').slice(1).join('_') || objectKey);

            try {
                const response = await r2Client.send(new GetObjectCommand({
                    Bucket: process.env.R2_BUCKET_NAME,
                    Key: objectKey,
                }));
                await appendStreamToArchive(response.Body, originalName);
                console.log(`[ZIP] Appended ${originalName} to archive`);
            } catch (err) {
                console.error(`[ZIP] Failed to fetch ${originalName}:`, err.message);
            }
        }

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
            
            // Critical check for literal 'TRANSFER_ID' string which suggests a frontend/upload bug
            if (objectKey.includes("TRANSFER_ID")) {
                console.error(`[VIDEO] CRITICAL: Literal "TRANSFER_ID" found in key "${objectKey}". This transfer is corrupted and cannot be processed. Please check your frontend logic.`);
                continue;
            }

            // Check if it's a video by extension
            const isVideo = /\.(mp4|mov|avi|wmv|flv|webm|mkv|m4v)$/i.test(objectKey);
            if (!isVideo) continue;

            try {
                console.log(`[VIDEO] Getting metadata for ${objectKey} without downloading using presigned URL...`);

                const presignedUrl = await getSignedUrl(r2Client, new GetObjectCommand({
                    Bucket: process.env.R2_BUCKET_NAME,
                    Key: objectKey,
                }), { expiresIn: 3600 });

                const metadata = await getVideoMetadata(presignedUrl);

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
                        console.log(`Starting stream-based multi-resolution transcoding for ${objectKey}`);

                        const pathParts = objectKey.split('/');
                        const fileName = pathParts.pop();
                        const folderPath = pathParts.join('/');
                        
                        const qualityEntries = [];

                        // We process sequentially to avoid overwhelming node.js/FFmpeg CPU
                        for (const targetRes of targets) {
                            try {
                                console.log(`[VIDEO] Transcoding stream for ${targetRes.label}...`);
                                
                                const getCommand = new GetObjectCommand({
                                    Bucket: process.env.R2_BUCKET_NAME,
                                    Key: objectKey,
                                });
                                // Get readable stream from R2
                                const response = await r2Client.send(getCommand);
                                
                                // Pipe through FFmpeg directly
                                const outputStream = transcodeVideo(response.Body, targetRes);
                                
                                const qualityPrefix = `${folderPath}/${targetRes.label}_${fileName.replace(/\.[^/.]+$/, "")}`; // Safe name format
                                const resKey = `${qualityPrefix}.mp4`; // Output streamable fMP4 directly to R2!

                                const upload = new Upload({
                                    client: r2Client,
                                    params: {
                                        Bucket: process.env.R2_BUCKET_NAME,
                                        Key: resKey,
                                        Body: outputStream,
                                        ContentType: 'video/mp4'
                                    }
                                });

                                await upload.done();
                                console.log(`[VIDEO] Uploaded fMP4 for ${targetRes.label} to R2 (${resKey})`);

                                qualityEntries.push({ label: targetRes.label, key: resKey, isOriginal: false });
                            } catch (e) {
                                console.error(`[VIDEO] Error streaming transcode for ${targetRes.label}:`, e.message);
                            }
                        }

                        for (const quality of qualityEntries) {
                            await File.updateOne(
                                { _id: transferId },
                                { $push: { [`files.${i}.qualities`]: quality } }
                            );
                        }
                    }
                }
            } catch (err) {
                console.warn(`[VIDEO] Could not process video ${objectKey} in bucket ${process.env.R2_BUCKET_NAME}:`, err.message);
                if (err.name === 'NoSuchKey' || err.code === 'NoSuchKey' || err.message.includes('key does not exist')) {
                    console.error(`[VIDEO] CRITICAL: Key "${objectKey}" not found. Current R2_FOLDER is "${process.env.R2_FOLDER}". Check if this matches your storage structure.`);
                }
            }
        }
    } catch (error) {
        console.error("Error in extractVideoResolutions:", error);
    }
};

/**
 * @Description Permanently destroys a transfer (R2 files + DB status + Email)
 * @Param transferIdOrObject: File ID or full File object
 */
export const destroyTransfer = async (transferIdOrObject) => {
    try {
        let transfer = typeof transferIdOrObject === 'object' ? transferIdOrObject : await File.findById(transferIdOrObject);
        if (!transfer || transfer.status === 'destroyed') return;

        console.log(`[DESTROY] Starting destruction of transfer: ${transfer._id} (${transfer.shortId})`);

        // 1. Delete all original files and their qualities (including HLS segments)
        for (const fileItem of transfer.files) {
            const mainKey = typeof fileItem === 'string' ? fileItem : fileItem.key;
            if (mainKey) {
                await deleteFromR2(mainKey);
            }

            // Delete transcoded qualities if they exist
            if (fileItem.qualities && Array.isArray(fileItem.qualities)) {
                for (const quality of fileItem.qualities) {
                    if (quality.key) {
                        // If it's a playlist, delete everything in that quality "folder"
                        if (quality.key.endsWith('playlist.m3u8')) {
                            const prefix = quality.key.replace('playlist.m3u8', '');
                            await deletePrefixFromR2(prefix);
                        } else if (quality.key !== mainKey) {
                            await deleteFromR2(quality.key);
                        }
                    }
                }
            }
        }

        // 2. Delete zipKey if it exists
        if (transfer.zipKey) {
            await deleteFromR2(transfer.zipKey);
        }

        // 3. Mark as destroyed in DB
        transfer.status = "destroyed";
        await transfer.save();

        // 4. Notify end user (sender)
        if (transfer.senderEmail) {
            try {
                const html = buildFileDestroyedHtml({
                    shortId: transfer.shortId,
                    fileCount: transfer.files.length
                });
                await sendEmail({
                    to: transfer.senderEmail,
                    subject: `Files Permanently Destroyed - ${transfer.shortId}`,
                    html
                });
                console.log(`[DESTROY] Notification sent to ${transfer.senderEmail}`);
            } catch (emailErr) {
                console.error(`[DESTROY] Failed to send email to ${transfer.senderEmail}:`, emailErr.message);
            }
        }

        console.log(`[DESTROY] Successfully destroyed transfer: ${transfer._id}`);
        return true;
    } catch (error) {
        console.error(`[DESTROY] Error destroying transfer:`, error);
        return false;
    }
};

export const deleteFromR2 = async (key) => {
    try {
        const command = new DeleteObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: key,
        });
        await r2Client.send(command);
        console.log(`[R2] Deleted object: ${key}`);
    } catch (err) {
        console.error(`[R2] Error deleting ${key}:`, err.message);
    }
};

export const deletePrefixFromR2 = async (prefix) => {
    try {
        if (!prefix || prefix === '/' || prefix === '') return;

        const listCommand = new ListObjectsV2Command({
            Bucket: process.env.R2_BUCKET_NAME,
            Prefix: prefix,
        });
        const listedObjects = await r2Client.send(listCommand);

        if (!listedObjects.Contents || listedObjects.Contents.length === 0) return;

        const deleteCommand = new DeleteObjectsCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Delete: {
                Objects: listedObjects.Contents.map(({ Key }) => ({ Key })),
                Quiet: true
            },
        });

        await r2Client.send(deleteCommand);
        console.log(`[R2] Deleted ${listedObjects.Contents.length} objects with prefix: ${prefix}`);

        if (listedObjects.IsTruncated) {
            await deletePrefixFromR2(prefix);
        }
    } catch (err) {
        console.error(`[R2] Error deleting prefix ${prefix}:`, err.message);
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

/**
 * @Description Links any unclaimed transfers (user: null) with the matching senderEmail to a userId
 * @Param email: The user's email
 * @Param userId: The user's new Mongoose ID
 */
export const claimTransfersByEmail = async (email, userId) => {
    try {
        if (!email || !userId) return;

        const unclaimedTransfers = await File.find({ senderEmail: email, user: null });
        if (unclaimedTransfers.length === 0) return;

        const totalClaimedSize = unclaimedTransfers.reduce((sum, transfer) => sum + (transfer.totalSize || 0), 0);

        const result = await File.updateMany(
            { senderEmail: email, user: null },
            { $set: { user: userId } }
        );
        
        if (result.modifiedCount > 0) {
            console.log(`[CLAIM] Linked ${result.modifiedCount} anonymous transfers (${totalClaimedSize} bytes) to user ${email} (${userId})`);
            
            await User.findByIdAndUpdate(userId, { $inc: { storageUsed: totalClaimedSize } });
        }
    } catch (error) {
        console.error(`[CLAIM] Error linking transfers for ${email}:`, error);
    }
};