import ffmpeg from 'fluent-ffmpeg';
import ffprobe from '@ffprobe-installer/ffprobe';
import ffmpegStatic from '@ffmpeg-installer/ffmpeg';
import { Readable, PassThrough } from 'stream';

import { execSync } from 'child_process';

// Helper to determine the best binary path (System vs NPM Package)
const getBinaryPath = (npmPath, name) => {
    try {
        execSync(`which ${name}`, { stdio: 'ignore' });
        console.log(`Using system ${name}`);
        return name;
    } catch (e) {
        console.log(`Using NPM package for ${name}`);
        return npmPath;
    }
};

ffmpeg.setFfprobePath(getBinaryPath(ffprobe.path, 'ffprobe'));
ffmpeg.setFfmpegPath(getBinaryPath(ffmpegStatic.path, 'ffmpeg'));

// Standard quality heights (based on the shorter dimension)
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
        let command = ffmpeg(source);

        command.ffprobe((err, metadata) => {
            if (err) {
                return reject(err);
            }
 
            const videoStream = metadata.streams.find(s => s.codec_type === 'video');
            if (!videoStream) {
                return resolve(null);
            }

            const { width, height, duration } = videoStream;
            
            const shortSide = Math.min(width, height);
            
            let resolution = 'SD';
            if (shortSide >= 2160) resolution = '4K';
            else if (shortSide >= 1440) resolution = '2K';
            else if (shortSide >= 1080) resolution = '1080p';
            else if (shortSide >= 720) resolution = '720p';
            else if (shortSide >= 480) resolution = '480p';
            else if (shortSide >= 360) resolution = '360p';
            else resolution = `${shortSide}p`;

            resolve({
                width,
                height,
                shortSide,
                resolution,
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

    const command = ffmpeg(source)
        .videoFilters(scaleFilter)
        .videoBitrate(targetRes.bitrate)
        .format('mp4')
        .on('start', (cmd) => console.log('FFmpeg command:', cmd))
        .on('error', (err) => {
            if (err.message.includes('Output stream closed')) {
                console.log(`Note: Stream closed normally for ${targetRes.label}`);
            } else {
                console.error('Transcoding error:', err.message);
                passThrough.destroy(err);
            }
        })
        .on('end', () => console.log('Transcoding finished for', targetRes.label));

    command.outputOptions([
        '-movflags frag_keyframe+empty_moov+default_base_moof',
        '-preset veryfast',
        '-c:a copy' 
    ]).pipe(passThrough);

    return passThrough;
};

export const bufferToStream = (buffer) => {
    const stream = new Readable();
    stream.push(buffer);
    stream.push(null);
    return stream;
};
