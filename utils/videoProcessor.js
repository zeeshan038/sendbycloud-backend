import ffmpeg from 'fluent-ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { Upload } from '@aws-sdk/lib-storage';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { pipeline } from 'stream/promises';
import r2Client from './R2.js';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

export const RESOLUTIONS = [
    { height: 144,  bitrate: '150k'   },
    { height: 240,  bitrate: '400k'   },
    { height: 360,  bitrate: '800k'   },
    { height: 480,  bitrate: '1200k'  },
    { height: 720,  bitrate: '2500k'  },
    { height: 1080, bitrate: '5000k'  },
    { height: 1440, bitrate: '10000k' },
    { height: 2160, bitrate: '18000k' },
];

// ── Get video metadata ────────────────────────────────────────────────────────
export const getVideoMetadata = async (objectKey) => {
    const tempPath = path.join(os.tmpdir(), `probe_${Date.now()}.mp4`);

    try {
        console.log(`[VIDEO] Downloading first 5MB for probe: ${objectKey}`);

        const response = await r2Client.send(new GetObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: objectKey,
            Range: 'bytes=0-5242880'
        }));

        await pipeline(response.Body, fs.createWriteStream(tempPath));

        const partialResult = await new Promise((resolve) => {
            ffmpeg.ffprobe(tempPath, (err, metadata) => {
                if (err) { resolve(null); return; }
                const videoStream = metadata.streams.find(s => s.codec_type === 'video');
                if (!videoStream) { resolve(null); return; }
                resolve({
                    width: videoStream.width,
                    height: videoStream.height,
                    shortSide: Math.min(videoStream.width, videoStream.height),
                    duration: parseFloat(metadata.format.duration) || 0,
                    codec: videoStream.codec_name,
                });
            });
        });

        if (partialResult) {
            console.log(`[VIDEO] Probe succeeded with partial file`);
            return partialResult;
        }

        console.log(`[VIDEO] moov atom not in first 5MB, downloading full file...`);
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);

        const fullResponse = await r2Client.send(new GetObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: objectKey,
        }));
        await pipeline(fullResponse.Body, fs.createWriteStream(tempPath));

        return await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(tempPath, (err, metadata) => {
                if (err) return reject(err);
                const videoStream = metadata.streams.find(s => s.codec_type === 'video');
                if (!videoStream) return reject(new Error('No video stream found'));
                resolve({
                    width: videoStream.width,
                    height: videoStream.height,
                    shortSide: Math.min(videoStream.width, videoStream.height),
                    duration: parseFloat(metadata.format.duration) || 0,
                    codec: videoStream.codec_name,
                });
            });
        });

    } finally {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
};

// ── Upload a single local file to R2 ─────────────────────────────────────────
const uploadToR2 = async (localPath, r2Key, contentType) => {
    const upload = new Upload({
        client: r2Client,
        params: {
            Bucket: process.env.R2_BUCKET_NAME,
            Key: r2Key,
            Body: fs.createReadStream(localPath),
            ContentType: contentType,
        }
    });
    await upload.done();
};

// ── Transcode one resolution to HLS ──────────────────────────────────────────
const transcodeResolution = (localVideoPath, res, resDir, metadata, progressCallback, resIndex, totalRes) => {
    const resLabel = `${res.height}p`;
    const playlistPath = path.join(resDir, 'playlist.m3u8');
    const segmentPattern = path.join(resDir, 'segment_%03d.ts');

    return new Promise((resolve, reject) => {
        let lastProgress = 0;

        ffmpeg(localVideoPath)
            .outputOptions([
                '-c:v libx264',
                '-c:a aac',
                `-b:v ${res.bitrate}`,
                '-b:a 128k',
                // ✅ Fix 1: handle portrait AND landscape videos correctly
                `-vf scale='if(gt(iw,ih),-2,${res.height})':'if(gt(iw,ih),${res.height},-2)'`,
                // 🚀 PERFORMANCE FIXES for smooth adaptive streaming
                '-preset veryfast',      // Better compression than ultrafast, still fast
                '-crf 26',               // Slightly better quality/size than 28
                '-g 48',                 // Force keyframe every 48 frames (~2s @ 24fps)
                '-keyint_min 48',        // Minimum keyframe interval
                '-sc_threshold 0',       // Disable scene change detection for better HLS slicing
                '-hls_time 4',           // Shorter segments for faster starts/switches
                '-hls_playlist_type vod',// Mark as fixed-length VOD
                '-hls_list_size 0',
                `-hls_segment_filename ${segmentPattern}`,
                '-f hls',
            ])
            .output(playlistPath)
            .on('start', () => console.log(`[VIDEO] FFmpeg started for ${resLabel}`))
            .on('stderr', (line) => {
                const match = line.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
                if (match && metadata.duration && progressCallback) {
                    const secs = parseInt(match[1]) * 3600
                               + parseInt(match[2]) * 60
                               + parseInt(match[3]);
                    const progress = Math.min(100, Math.round((secs / metadata.duration) * 100));
                    if (progress > lastProgress + 2) {
                        lastProgress = progress;
                        progressCallback({ resolution: resLabel, progress });
                    }
                }
            })
            .on('end', () => {
                console.log(`[VIDEO] ${resLabel} transcoding complete`);
                resolve(playlistPath);
            })
            .on('error', (err) => {
                console.error(`[VIDEO] ${resLabel} transcoding error:`, err.message);
                reject(err);
            })
            .run();
    });
};

// ── Transcode video to HLS at multiple resolutions ────────────────────────────
export const transcodeToHLS = async (transferId, fileIndex, objectKey, metadata, progressCallback = null) => {
    const startMs = Date.now();

    // ✅ Fix 2: use shortSide for filtering — fixes portrait videos
    const targets = RESOLUTIONS.filter(r => r.height < metadata.shortSide);
    if (targets.length === 0) {
        console.log(`[VIDEO] No lower resolutions needed for ${objectKey} (shortSide: ${metadata.shortSide})`);
        return [{ label: 'Original', key: objectKey, isOriginal: true }];
    }

    console.log(`[VIDEO] Will transcode to: ${targets.map(r => r.height + 'p').join(', ')}`);

    const tempDir = path.join(os.tmpdir(), `hls_${transferId}_${fileIndex}_${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    const localVideoPath = path.join(tempDir, 'input.mp4');
    console.log(`[VIDEO] Downloading to disk: ${objectKey}`);

    const downloadResponse = await r2Client.send(new GetObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: objectKey,
    }));
    await pipeline(downloadResponse.Body, fs.createWriteStream(localVideoPath));
    console.log(`[VIDEO] Download complete (${((Date.now() - startMs) / 1000).toFixed(1)}s)`);

    const r2BasePrefix = objectKey.split('/').slice(0, -1).join('/');
    const masterPlaylistLines = ['#EXTM3U', '#EXT-X-VERSION:3', ''];
    const qualityEntries = [];

    try {
        const resDirs = targets.map(res => {
            const resDir = path.join(tempDir, `${res.height}p`);
            fs.mkdirSync(resDir, { recursive: true });
            return resDir;
        });

        console.log(`[VIDEO] Transcoding ${targets.length} resolutions in parallel...`);
        await Promise.all(
            targets.map((res, i) =>
                transcodeResolution(
                    localVideoPath,
                    res,
                    resDirs[i],
                    metadata,
                    progressCallback,
                    i,
                    targets.length
                )
            )
        );

        console.log(`[VIDEO] All transcoded (${((Date.now() - startMs) / 1000).toFixed(1)}s), uploading...`);

        await Promise.all(
            targets.map(async (res, i) => {
                const resLabel = `${res.height}p`;
                const resDir = resDirs[i];
                const playlistPath = path.join(resDir, 'playlist.m3u8');
                const segmentFiles = fs.readdirSync(resDir).filter(f => f.endsWith('.ts'));
                const r2ResPrefix = `${r2BasePrefix}/hls/${resLabel}`;

                console.log(`[VIDEO] Uploading ${resLabel} (${segmentFiles.length} segments)...`);

                await Promise.all([
                    uploadToR2(playlistPath, `${r2ResPrefix}/playlist.m3u8`, 'application/x-mpegURL'),
                    ...segmentFiles.map(seg =>
                        uploadToR2(
                            path.join(resDir, seg),
                            `${r2ResPrefix}/${seg}`,
                            'video/MP2T'
                        )
                    )
                ]);

                console.log(`[VIDEO] ${resLabel} uploaded`);

                qualityEntries.push({
                    index: i,
                    label: resLabel,
                    key: `${r2ResPrefix}/playlist.m3u8`,
                    isOriginal: false
                });

                masterPlaylistLines.push(
                    `#EXT-X-STREAM-INF:BANDWIDTH=${parseInt(res.bitrate) * 1000},RESOLUTION=${Math.round(res.height * 16 / 9)}x${res.height}`,
                    `${resLabel}/playlist.m3u8`,
                    ''
                );
            })
        );

        qualityEntries.sort((a, b) => a.index - b.index);
        qualityEntries.forEach(q => delete q.index);

        const masterKey = `${r2BasePrefix}/hls/master.m3u8`;
        await r2Client.send(new PutObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: masterKey,
            Body: masterPlaylistLines.join('\n'),
            ContentType: 'application/x-mpegURL',
        }));

        console.log(`[VIDEO] Master playlist uploaded: ${masterKey}`);

        const allQualities = [
            { label: 'Original', key: objectKey, isOriginal: true },
            ...qualityEntries,
            { label: 'HLS_Master', key: masterKey, isOriginal: false }
        ];

        console.log(`[VIDEO] ✅ Done ${objectKey} in ${((Date.now() - startMs) / 1000).toFixed(1)}s`);
        return allQualities;

    } finally {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
            console.log(`[VIDEO] Cleaned up: ${tempDir}`);
        } catch (e) {
            console.warn(`[VIDEO] Cleanup warning:`, e.message);
        }
    }
};