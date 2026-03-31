import ffmpeg from 'fluent-ffmpeg';
import ffprobe from '@ffprobe-installer/ffprobe';
import ffmpegStatic from '@ffmpeg-installer/ffmpeg';
import { Readable, PassThrough } from 'stream';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const getBinaryPath = (npmPath, name) => {
    try {
        execSync(process.platform === 'win32' ? `where ${name}` : `which ${name}`, { stdio: 'ignore' });
        return name;
    } catch {
        return npmPath;
    }
};

ffmpeg.setFfprobePath(getBinaryPath(ffprobe.path, 'ffprobe'));
ffmpeg.setFfmpegPath(getBinaryPath(ffmpegStatic.path, 'ffmpeg'));

export const RESOLUTIONS = [
    { label: '144p', shortSide: 144, bitrate: '150k' },
    { label: '240p', shortSide: 240, bitrate: '400k' },
    { label: '360p', shortSide: 360, bitrate: '800k' },
    { label: '480p', shortSide: 480, bitrate: '1400k' },
    { label: '720p', shortSide: 720, bitrate: '2800k' },
    { label: '1080p', shortSide: 1080, bitrate: '5000k' }
];

export const getVideoMetadata = (source) => {
    return new Promise((resolve, reject) => {
        ffmpeg(source).ffprobe((err, metadata) => {
            if (err) return reject(err);

            const videoStream = metadata.streams.find(s => s.codec_type === 'video');
            if (!videoStream) return resolve(null);

            const { width, height, duration } = videoStream;
            const shortSide = Math.min(width, height);

            resolve({
                width,
                height,
                shortSide,
                duration: parseFloat(duration) || 0,
                codec: videoStream.codec_name,
                bitrate: parseInt(videoStream.bit_rate) || 0
            });
        });
    });
};
 
export const transcodeVideo = (source, targetRes) => {
    const passThrough = new PassThrough();
    const scaleFilter = `scale='if(gt(iw,ih),-2,${targetRes.shortSide})':'if(gt(iw,ih),${targetRes.shortSide},-2)'`;

    ffmpeg(source)
        .videoFilters(scaleFilter)
        .format('mp4')
        .on('start', (cmd) => console.log(`[${targetRes.label}]`, cmd))
        .on('error', (err) => {
            console.error(`Error (${targetRes.label}):`, err.message);
            passThrough.destroy(err);
        })
        .on('end', () => console.log(`Done (${targetRes.label})`))
        .outputOptions([
            '-c:v libx264',
            '-preset ultrafast',
            '-crf 30',
            // Avoid CPU oversubscription when running multiple encodes/workers.
            '-threads 1',
            '-filter_threads 1',
            '-x264-params threads=1:rc-lookahead=0',
            '-tune zerolatency',
            '-movflags frag_keyframe+empty_moov+default_base_moof',
            '-c:a aac',
            '-b:a 96k'
        ])
        .pipe(passThrough);

    return passThrough;
};

/**
 * SINGLE-PASS MULTI-RESOLUTION TRANSCODING
 * Processes all resolutions in one FFmpeg process to save CPU and Time.
 */
export const transcodeMultipleResolutions = (source, targets, outputDir) => {
    return new Promise((resolve, reject) => {
        if (targets.length === 0) return resolve([]);

        ffmpeg.ffprobe(source, (err, metadata) => {
            if (err) return reject(err);
            
            const hasAudio = metadata.streams.some(s => s.codec_type === 'audio');
            const command = ffmpeg(source);

            command.outputOptions([
                '-preset ultrafast',
                '-crf 30',
                // Avoid CPU oversubscription when running multiple outputs in one process.
                '-threads 1',
                '-filter_threads 1',
                '-x264-params threads=1:rc-lookahead=0',
                '-tune zerolatency',
                '-movflags +faststart'
            ]);

            if (hasAudio) {
                command.outputOptions(['-c:a aac', '-b:a 96k']);
            }

            const filterChain = [];
            filterChain.push(`[0:v]split=${targets.length}${targets.map((_, i) => `[v${i}]`).join('')}`);
            
            if (hasAudio) {
                filterChain.push(`[0:a]asplit=${targets.length}${targets.map((_, i) => `[a${i}]`).join('')}`);
            }

            targets.forEach((targetRes, i) => {
                const scaleFilter = `[v${i}]scale='if(gt(iw,ih),-2,${targetRes.shortSide})':'if(gt(iw,ih),${targetRes.shortSide},-2)'[outv${i}]`;
                filterChain.push(scaleFilter);
            });

            command.complexFilter(filterChain);

            const outputFiles = [];
            targets.forEach((targetRes, i) => {
                const outDir = path.join(outputDir, targetRes.label);
                fs.mkdirSync(outDir, { recursive: true });
                const m3u8Path = path.join(outDir, `playlist.m3u8`);
                const tsPattern = path.join(outDir, `segment_%03d.ts`);

                outputFiles.push({ label: targetRes.label, dir: outDir, path: m3u8Path, shortSide: targetRes.shortSide });
                
                command
                    .output(m3u8Path)
                    .map(`[outv${i}]`)
                    .videoCodec('libx264')
                    .videoBitrate(targetRes.bitrate)
                    .outputOptions([
                        '-f hls',
                        '-hls_time 6',
                        '-hls_playlist_type vod',
                        `-hls_segment_filename ${tsPattern}`
                    ]);
                
                if (hasAudio) {
                    command.map(`[a${i}]`);
                }
                
                command.on('start', () => console.log(`Started output for ${targetRes.label}`));
            });

            command
                .on('start', (cmd) => console.log('FFmpeg Multi-Output Command:', cmd))
                .on('error', (err) => {
                    console.error('Multi-transcoding error:', err.message);
                    reject(err);
                })
                .on('end', () => {
                    console.log('Finished all resolutions in one pass!');
                    resolve(outputFiles);
                })
                .run();
        });
    });
};


export const bufferToStream = (buffer) => {
    const stream = new Readable();
    stream.push(buffer);
    stream.push(null);
    return stream;
};
