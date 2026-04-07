export class ZipDurableObject {
    constructor(state, env) {
        this.state = state;
        this.env = env;
    }

    async fetch(request) {
        const url = new URL(request.url);

        if (request.method === 'GET') {
            const status   = await this.state.storage.get('status')   || 'not_started';
            const progress = await this.state.storage.get('progress') || 0;
            const error    = await this.state.storage.get('error')    || null;
            const zipKey   = await this.state.storage.get('zipKey')   || null;
            return new Response(JSON.stringify({ status, progress, error, zipKey }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        if (request.method === 'POST') {
            const { files, shortId, transferId } = await request.json();

            const status    = await this.state.storage.get('status');
            const startedAt = await this.state.storage.get('startedAt') || 0;
            const isStuck   = status === 'processing' && (Date.now() - startedAt) > 10 * 60 * 1000;

            if (status === 'processing' && !isStuck) {
                return new Response(JSON.stringify({ status: 'already_processing' }), {
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            await this.state.storage.put('status', 'processing');
            await this.state.storage.put('progress', 0);
            await this.state.storage.put('startedAt', Date.now());
            await this.state.storage.delete('zipKey');
            await this.state.storage.delete('error');

            this.state.waitUntil(this.processZip(files, shortId, transferId));

            return new Response(JSON.stringify({
                status: 'started',
                message: 'ZIP creation started in background',
                shortId
            }), { headers: { 'Content-Type': 'application/json' } });
        }

        return new Response('Method not allowed', { status: 405 });
    }

    async processZip(files, shortId, transferId) {
        const startTime = Date.now();
        const folderPrefix = this.env.R2_FOLDER ? `${this.env.R2_FOLDER}/` : '';
        const zipKey = `${folderPrefix}transfers/sendbycloud-${shortId}.zip`;
        let multipartUpload = null;

        try {
            console.log(`[ZIP DO] processZip entered for ${shortId}`);

            const nameEncoder = new TextEncoder();
            const fileEntries = await Promise.all(files.map(async (fileData) => {
                const objectKey = typeof fileData === 'string' ? fileData : fileData.key;
                const fileName  = (typeof fileData === 'object' && fileData.name)
                    ? fileData.name
                    : objectKey.split('/').pop().replace(/^[^_]+_/, '') || objectKey;

                const head = await this.env.MY_BUCKET.head(objectKey);
                if (!head) {
                    console.warn(`[ZIP DO] File not found: ${objectKey}`);
                    return null;
                }
                return { objectKey, fileName, fileSize: head.size, nameBytes: nameEncoder.encode(fileName) };
            }));

            const validFiles = fileEntries.filter(Boolean);
            console.log(`[ZIP DO] ${validFiles.length}/${files.length} files found (${this.elapsed(startTime)}s)`);

            if (validFiles.length === 0) throw new Error('No valid files found in R2');

            let totalZipSize = 0;
            for (const { nameBytes, fileSize } of validFiles) totalZipSize += 30 + nameBytes.length + fileSize;
            for (const { nameBytes } of validFiles) totalZipSize += 46 + nameBytes.length;
            totalZipSize += 22;
            console.log(`[ZIP DO] ZIP size: ${(totalZipSize / 1024 / 1024 / 1024).toFixed(3)}GB (${this.elapsed(startTime)}s)`);

            multipartUpload = await this.env.MY_BUCKET.createMultipartUpload(zipKey, {
                httpMetadata: { contentType: 'application/zip' }
            });
            console.log(`[ZIP DO] Multipart upload created (${this.elapsed(startTime)}s)`);

            const PART_SIZE  = 128 * 1024 * 1024;
            const parts      = [];
            let   partNumber = 1;
            let   buffer     = new Uint8Array(0);
            const centralDir = [];
            let   zipOffset  = 0;

            const flush = async (force = false) => {
                while (buffer.length >= PART_SIZE || (force && buffer.length > 0)) {
                    const size  = force ? buffer.length : PART_SIZE;
                    const chunk = buffer.slice(0, size);
                    buffer      = buffer.slice(size);
                    console.log(`[ZIP DO] Uploading part ${partNumber} (${(chunk.length / 1024 / 1024).toFixed(0)}MB) (${this.elapsed(startTime)}s)`);
                    const uploaded = await multipartUpload.uploadPart(partNumber, chunk);
                    parts.push({ partNumber, etag: uploaded.etag });
                    partNumber++;
                }
            };

            const append = async (data) => {
                const merged = new Uint8Array(buffer.length + data.length);
                merged.set(buffer);
                merged.set(data, buffer.length);
                buffer = merged;
                await flush();
            };

            for (let i = 0; i < validFiles.length; i++) {
                const { objectKey, fileName, fileSize, nameBytes } = validFiles[i];

                await append(this.buildLocalFileHeader(nameBytes, fileSize));
                centralDir.push({ nameBytes, fileSize, offset: zipOffset });
                zipOffset += 30 + nameBytes.length + fileSize;

                const obj = await this.fetchWithRetry(objectKey, fileName);

                if (obj) {
                    const reader = obj.body.getReader();
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        await append(value);
                    }
                    console.log(`[ZIP DO] File ${i + 1}/${validFiles.length}: ${fileName} (${this.elapsed(startTime)}s)`);
                } else {
                    console.error(`[ZIP DO] Failed: ${fileName} — writing zeros`);
                    const chunkSize = 4 * 1024 * 1024;
                    let remaining = fileSize;
                    while (remaining > 0) {
                        const size = Math.min(chunkSize, remaining);
                        await append(new Uint8Array(size));
                        remaining -= size;
                    }
                }

                await this.state.storage.put('progress', Math.round(((i + 1) / validFiles.length) * 90));
            }

            await append(this.buildCentralDirectory(centralDir, zipOffset));
            await flush(true);

            console.log(`[ZIP DO] Completing multipart (${parts.length} parts) (${this.elapsed(startTime)}s)`);
            await multipartUpload.complete(parts);

            await this.notifyBackend(transferId, zipKey, shortId);
            await this.state.storage.put('status',   'completed');
            await this.state.storage.put('progress', 100);
            await this.state.storage.put('zipKey',   zipKey);

            console.log(`[ZIP DO] SUCCESS ${shortId} in ${this.elapsed(startTime)}s`);

        } catch (error) {
            console.error(`[ZIP DO] FAILED ${shortId} after ${this.elapsed(startTime)}s: ${error.message}`);
            if (multipartUpload) {
                try { await multipartUpload.abort(); } catch (e) {}
            }
            await this.state.storage.put('status', 'failed');
            await this.state.storage.put('error',  error.message);
            await this.notifyBackend(transferId, null, shortId, error.message);
        }
    }

    async fetchWithRetry(objectKey, fileName, maxAttempts = 3) {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const obj = await this.env.MY_BUCKET.get(objectKey);
                if (obj) return obj;
            } catch (err) {
                console.warn(`[ZIP DO] ${fileName} attempt ${attempt} failed: ${err.message}`);
            }
            if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 1000 * attempt));
        }
        return null;
    }

    elapsed(startTime) {
        return ((Date.now() - startTime) / 1000).toFixed(1);
    }

    buildLocalFileHeader(nameBytes, fileSize) {
        const buf  = new ArrayBuffer(30 + nameBytes.length);
        const view = new DataView(buf);
        view.setUint32(0,  0x04034b50,            true);
        view.setUint16(4,  20,                    true);
        view.setUint16(6,  0x0808,                true);
        view.setUint16(8,  0,                     true);
        view.setUint16(10, 0,                     true);
        view.setUint16(12, 0,                     true);
        view.setUint32(14, 0,                     true);
        view.setUint32(18, fileSize & 0xFFFFFFFF, true);
        view.setUint32(22, fileSize & 0xFFFFFFFF, true);
        view.setUint16(26, nameBytes.length,      true);
        view.setUint16(28, 0,                     true);
        new Uint8Array(buf).set(nameBytes, 30);
        return new Uint8Array(buf);
    }

    buildCentralDirectory(entries, cdOffset) {
        const records = [];
        let cdSize = 0;

        for (const entry of entries) {
            const recSize = 46 + entry.nameBytes.length;
            const buf     = new ArrayBuffer(recSize);
            const view    = new DataView(buf);
            view.setUint32(0,  0x02014b50,                 true);
            view.setUint16(4,  20,                          true);
            view.setUint16(6,  20,                          true);
            view.setUint16(8,  0x0808,                      true);
            view.setUint16(10, 0,                           true);
            view.setUint16(12, 0,                           true);
            view.setUint16(14, 0,                           true);
            view.setUint32(16, 0,                           true);
            view.setUint32(20, entry.fileSize & 0xFFFFFFFF, true);
            view.setUint32(24, entry.fileSize & 0xFFFFFFFF, true);
            view.setUint16(28, entry.nameBytes.length,      true);
            view.setUint16(30, 0,                           true);
            view.setUint16(32, 0,                           true);
            view.setUint16(34, 0,                           true);
            view.setUint16(36, 0,                           true);
            view.setUint32(38, 0,                           true);
            view.setUint32(42, entry.offset & 0xFFFFFFFF,   true);
            new Uint8Array(buf).set(entry.nameBytes, 46);
            records.push(new Uint8Array(buf));
            cdSize += recSize;
        }

        const eocd = new ArrayBuffer(22);
        const ev   = new DataView(eocd);
        ev.setUint32(0,  0x06054b50,              true);
        ev.setUint16(4,  0,                        true);
        ev.setUint16(6,  0,                        true);
        ev.setUint16(8,  entries.length,           true);
        ev.setUint16(10, entries.length,           true);
        ev.setUint32(12, cdSize,                   true);
        ev.setUint32(16, cdOffset & 0xFFFFFFFF,    true);
        ev.setUint16(20, 0,                        true);
        records.push(new Uint8Array(eocd));

        const total  = records.reduce((s, r) => s + r.length, 0);
        const merged = new Uint8Array(total);
        let pos = 0;
        for (const r of records) { merged.set(r, pos); pos += r.length; }
        return merged;
    }

    async notifyBackend(transferId, zipKey, shortId, error = null) {
        if (!this.env.BACKEND_URL) return;
        try {
            await fetch(`${this.env.BACKEND_URL}/api/transfer/zip-complete`, {
                method: 'POST',
                headers: {
                    'Content-Type':    'application/json',
                    'X-Worker-Secret': this.env.WORKER_SECRET
                },
                body: JSON.stringify({ transferId, zipKey, shortId, error })
            });
        } catch (err) {
            console.error('[ZIP DO] Notify backend failed:', err.message);
        }
    }
}
