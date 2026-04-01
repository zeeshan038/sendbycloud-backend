import mongoose from "mongoose";
import { nanoid } from "nanoid";
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import r2Client from "../../utils/R2.js";
import File from "../../models/files.js";
import { destroyTransfer } from "../../utils/methods.js";

// ─── Constants ───────────────────────────────────────────────────────────────
const SIGNED_URL_EXPIRY = 7200;

const _transferCache = new Map();

const getCachedTransfer = async (shortId) => {
  if (_transferCache.has(shortId)) return _transferCache.get(shortId);
  const transfer = await findTransfer(shortId);
  if (transfer) {
    _transferCache.set(shortId, transfer);
    setTimeout(() => _transferCache.delete(shortId), 30 * 60 * 1000);
  }
  return transfer;
};

const invalidateCache = (shortId) => _transferCache.delete(shortId);

const buildDownloadDisposition = (filename, preview = false) => {
  if (preview === "true") return "inline";
  const safeName = filename || "download";
  return `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
};

const findTransfer = (shortId) => {
  const isObjectId = mongoose.Types.ObjectId.isValid(shortId);
  return File.findOne(isObjectId ? { _id: shortId } : { shortId });
};

const runLimitedParallel = async (items, limit, worker) => {
  const results = new Array(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
};

// ─── GET /api/transfer/download/:shortId ─────────────────────────────────────
export const getDownloadUrl = async (req, res) => {
  const { shortId } = req.params;
  const { preview = false, password = "" } = req.query;

  try {
    const transfer = await findTransfer(shortId);

    if (!transfer)
      return res.status(404).json({ status: false, msg: "Transfer not found" });

    if (transfer.password && transfer.password !== password)
      return res.status(401).json({ status: false, msg: "Invalid password for this transfer" });

    if (transfer.selfDestruct && transfer.downloadCount >= 1)
      return res.status(410).json({
        status: false,
        msg: "This transfer has self-destructed and is no longer available."
      });

    _transferCache.set(shortId, transfer);
    setTimeout(() => _transferCache.delete(shortId), 30 * 60 * 1000);

    const downloadSessionId = nanoid(12);

    const fileUrls = await runLimitedParallel(transfer.files, 10, async (fileData) => {
      const objectKey = typeof fileData === "string" ? fileData : fileData?.key;

      if (!objectKey) {
        return {
          objectKey: null, url: null, isDirectUrl: false, fileName: null, size: null,
          contentType: null, rangeSupported: true, qualities: null,
          resolution: null, duration: null, streamUrl: null, missing: true
        };
      }

      const originalName =
        typeof fileData === "object" && fileData?.name
          ? fileData.name
          : objectKey.split("_").slice(1).join("_") || objectKey;

      let url = null;
      let missing = false;

      // ── Always generate presigned R2 URL directly — no proxy ──────────────
      // DOWNLOAD_PROXY_URL is no longer used. Presigned URLs support Range
      // headers natively, so the frontend fetches R2 directly with no backend
      // calls during the actual download.
      try {
        const command = new GetObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: objectKey,
          ResponseContentDisposition: buildDownloadDisposition(originalName, preview),
          ResponseCacheControl: "public, max-age=3600"
        });
        url = await getSignedUrl(r2Client, command, { expiresIn: SIGNED_URL_EXPIRY });
      } catch (err) {
        console.error(`Error generating signed URL for: ${objectKey}`, err);
        missing = true;
      }

      let qualityUrls = [];
      let hlsMasterKey = null;

      if (typeof fileData === "object" && Array.isArray(fileData?.qualities) && fileData.qualities.length > 0) {
        const processedQualities = await runLimitedParallel(fileData.qualities, 5, async (q) => {
          if (q.key && q.key.endsWith(".m3u8")) {
            if (q.label === "HLS_Master") hlsMasterKey = q.key;
            return null;
          }

          try {
            const qCommand = new GetObjectCommand({
              Bucket: process.env.R2_BUCKET_NAME,
              Key: q.key,
              ResponseContentDisposition: buildDownloadDisposition(`${q.label}_${originalName}`, preview),
              ResponseCacheControl: "public, max-age=3600"
            });
            const qUrl = await getSignedUrl(r2Client, qCommand, { expiresIn: SIGNED_URL_EXPIRY });
            return { label: q.label, url: qUrl, isOriginal: q.isOriginal };
          } catch (err) {
            console.error(`Error generating quality URL: ${q.key}`, err);
            return { label: q.label, url: null, isOriginal: q.isOriginal, missing: true };
          }
        });
        qualityUrls = processedQualities.filter(Boolean);
      }

      let streamUrlResult = null;
      if (/\.(mp4|mov|avi|wmv|flv|webm|mkv|m4v)$/i.test(originalName)) {
        const streamKey = hlsMasterKey || objectKey;
        streamUrlResult = `${process.env.BACKEND_URL || "http://localhost:8080"}/api/transfer/stream/${transfer.shortId}?key=${encodeURIComponent(streamKey)}`;
      }

      return {
        objectKey,
        url,
        isDirectUrl: true,  // ← presigned R2 URLs always support Range headers
        fileName: originalName,
        size: typeof fileData === "object" ? fileData?.size || null : null,
        contentType: typeof fileData === "object" ? fileData?.type || fileData?.fileType || null : null,
        rangeSupported: true,
        qualities: qualityUrls.length > 0 ? qualityUrls : null,
        resolution: typeof fileData === "object" ? fileData?.resolution || null : null,
        duration: typeof fileData === "object" ? fileData?.duration || null : null,
        streamUrl: streamUrlResult,
        missing
      };
    });

    let zipUrl = null;
    let zipStatus = "none";
    let zipMissing = false;

    if (transfer.files.length > 1) {
      if (transfer.zipKey) {
        try {
          const zipCommand = new GetObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: transfer.zipKey,
            ResponseContentDisposition: buildDownloadDisposition("all_files.zip", preview),
            ResponseCacheControl: "public, max-age=3600"
          });
          zipUrl = await getSignedUrl(r2Client, zipCommand, { expiresIn: SIGNED_URL_EXPIRY });
          zipStatus = "ready";
        } catch (err) {
          console.error(`Error generating ZIP URL: ${transfer.zipKey}`, err);
          zipStatus = "missing";
          zipMissing = true;
        }
      } else {
        zipStatus = "processing";
      }
    }

    return res.status(200).json({
      status: true,
      downloadSessionId,
      files: fileUrls,
      zipUrl,
      zipStatus,
      zipMissing,
      isSelfDestruct: transfer.selfDestruct,
      isDownloadAble: transfer.isDownloadAble,
      transferDetails: {
        senderEmail: transfer.senderEmail,
        recevierEmails: transfer.recevierEmails,
        totalSize: transfer.totalSize,
        expireIn: transfer.expireIn,
        background: transfer.background,
        backgroundType: transfer.backgroundType,
        backgroundLink: transfer.backgroundLink
      }
    });
  } catch (error) {
    console.error("Error fetching download URLs:", error);
    return res.status(500).json({ status: false, msg: error.message });
  }
};

// ─── POST /api/transfer/download-start/:shortId ───────────────────────────────
export const startDownload = async (req, res) => {
  const { shortId } = req.params;
  const { downloadSessionId } = req.body;

  try {
    if (!downloadSessionId)
      return res.status(400).json({ status: false, msg: "downloadSessionId is required" });

    const transfer = await getCachedTransfer(shortId);
    if (!transfer)
      return res.status(404).json({ status: false, msg: "Transfer not found" });

    console.log(`Download started for transfer: ${shortId} (Session: ${downloadSessionId})`);
    return res.status(200).json({ status: true, msg: "Download marked as started" });
  } catch (error) {
    return res.status(500).json({ status: false, msg: error.message });
  }
};

// ─── POST /api/transfer/download-complete/:shortId ────────────────────────────
export const completeDownload = async (req, res) => {
  const { shortId } = req.params;
  const { downloadSessionId } = req.body;

  try {
    if (!downloadSessionId)
      return res.status(400).json({ status: false, msg: "downloadSessionId is required" });

    const transfer = await findTransfer(shortId);
    if (!transfer)
      return res.status(404).json({ status: false, msg: "Transfer not found" });

    if (transfer.selfDestruct && transfer.downloadCount >= 1)
      return res.status(410).json({ status: false, msg: "This transfer has already self-destructed." });

    const isObjectId = mongoose.Types.ObjectId.isValid(shortId);
    const updated = await File.findOneAndUpdate(
      isObjectId ? { _id: shortId } : { shortId },
      { $inc: { downloadCount: 1 } },
      { new: true }
    );

    invalidateCache(shortId);

    console.log(`Download completed for transfer: ${shortId}. New count: ${updated.downloadCount}`);

    if (updated.selfDestruct && updated.downloadCount >= 1) {
      console.log(`[SELF-DESTRUCT] Triggering destruction for ${shortId}`);
      destroyTransfer(updated).catch(err =>
        console.error(`[SELF-DESTRUCT] Error:`, err.message)
      );
    }

    return res.status(200).json({
      status: true,
      msg: "Download marked as complete",
      downloadCount: updated.downloadCount
    });
  } catch (error) {
    return res.status(500).json({ status: false, msg: error.message });
  }
};

// ─── POST /api/transfer/download-cancel/:shortId ──────────────────────────────
export const cancelDownload = async (req, res) => {
  const { shortId } = req.params;
  const { downloadSessionId } = req.body;

  try {
    if (!downloadSessionId)
      return res.status(400).json({ status: false, msg: "downloadSessionId is required" });

    const transfer = await getCachedTransfer(shortId);
    if (!transfer)
      return res.status(404).json({ status: false, msg: "Transfer not found" });

    console.log(`Download cancelled for transfer: ${shortId} (Session: ${downloadSessionId})`);
    return res.status(200).json({ status: true, msg: "Download marked as cancelled" });
  } catch (error) {
    return res.status(500).json({ status: false, msg: error.message });
  }
};


export const getDownloadPartUrl = async (req, res) => {
  const { shortId } = req.params;
  const { key, partNumber, partSize, password = "" } = req.body;

  try {
    if (!key || partNumber === undefined || !partSize)
      return res.status(400).json({
        status: false,
        msg: "key, partNumber, and partSize are required"
      });

    const transfer = await getCachedTransfer(shortId);
    if (!transfer)
      return res.status(404).json({ status: false, msg: "Transfer not found" });

    if (transfer.password && transfer.password !== password)
      return res.status(401).json({ status: false, msg: "Invalid password" });

    const effectiveKey = key === "zip" ? transfer.zipKey : key;

    if (!effectiveKey)
      return res.status(400).json({ status: false, msg: "Valid key or zipKey is required" });

    const isValidFile =
      transfer.zipKey === effectiveKey ||
      transfer.files.some((f) => {
        const mainKey = typeof f === "string" ? f : f.key;
        if (mainKey === effectiveKey) return true;
        if (Array.isArray(f?.qualities))
          return f.qualities.some((q) => q.key === effectiveKey);
        return false;
      });

    if (!isValidFile) {
      console.warn(`Unauthorized download-part attempt: key "${effectiveKey}" not in transfer ${shortId}`);
      return res.status(403).json({
        status: false,
        msg: "Unauthorized: File does not belong to this transfer"
      });
    }

    const partIndex = Number(partNumber) - 1;
    const partSizeNum = Number(partSize);
    const start = partIndex * partSizeNum;

    if (isNaN(start) || start < 0 || isNaN(partSizeNum) || partSizeNum <= 0)
      return res.status(400).json({ status: false, msg: "Invalid partNumber or partSize" });

    let fileSize = null;
    for (const f of transfer.files) {
      if (typeof f === "string") {
        if (f === effectiveKey) break;
      } else if (f.key === effectiveKey) {
        fileSize = f.size || null;
        break;
      } else if (Array.isArray(f.qualities)) {
        const q = f.qualities.find((q) => q.key === effectiveKey);
        if (q) { fileSize = q.size || null; break; }
      }
    }

    if (!fileSize) {
      try {
        const head = await r2Client.send(new HeadObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: effectiveKey,
        }));
        fileSize = head.ContentLength;

        for (const f of transfer.files) {
          if (typeof f !== "string" && f.key === effectiveKey) {
            f.size = fileSize; break;
          }
        }
      } catch (headErr) {
        if (
          headErr?.$metadata?.httpStatusCode === 404 ||
          headErr?.name === "NotFound" ||
          headErr?.Code === "NoSuchKey"
        ) {
          return res.status(404).json({ status: false, msg: "File not found in storage" });
        }
      }
    }

    if (fileSize && start >= fileSize)
      return res.status(416).json({ status: false, msg: "Range out of bounds" });

    const end = fileSize
      ? Math.min(start + partSizeNum - 1, fileSize - 1)
      : start + partSizeNum - 1;

    // ── Always return a presigned URL — no proxy ───────────────────────────
    const command = new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: effectiveKey,
      Range: `bytes=${start}-${end}`,
      ResponseCacheControl: "public, max-age=3600"
    });

    const url = await getSignedUrl(r2Client, command, { expiresIn: SIGNED_URL_EXPIRY });

    return res.status(200).json({ status: true, url, range: { start, end } });

  } catch (error) {
    console.error("Error generating part download URL:", error);

    if (
      error?.$metadata?.httpStatusCode === 404 ||
      error?.name === "NotFound" ||
      error?.Code === "NoSuchKey"
    ) {
      return res.status(404).json({ status: false, msg: "File not found in storage" });
    }

    return res.status(500).json({ status: false, msg: error.message });
  }
};