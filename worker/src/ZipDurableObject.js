export class ZipDurableObject {
    constructor(state, env) {
        this.state = state;
        this.env = env;
    }

    async fetch(request) {
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
            const isStuck   = status === 'processing' && (Date.now() - startedAt) > 15 * 60 * 1000;

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

            // ZIP64 size calculation
            let totalZipSize = 0;
            for (const { nameBytes, fileSize } of validFiles) totalZipSize += 30 + nameBytes.length + 20 + fileSize;
            for (const { nameBytes } of validFiles) totalZipSize += 46 + nameBytes.length + 32;
            totalZipSize += 56 + 20 + 22;
            console.log(`[ZIP DO] ZIP size: ${(totalZipSize / 1024 / 1024 / 1024).toFixed(3)}GB (${this.elapsed(startTime)}s)`);

            const USE_MULTIPART_THRESHOLD = 10 * 1024 * 1024;

            if (totalZipSize < USE_MULTIPART_THRESHOLD) {
                // ── Small ZIP: single put() ───────────────────────────────
                console.log(`[ZIP DO] Small ZIP — using single put()`);
                const zipData = new Uint8Array(totalZipSize);
                let writePos = 0;
                const write = (data) => { zipData.set(data, writePos); writePos += data.length; };
                const centralDir = [];
                let zipOffset = 0n;

                for (let i = 0; i < validFiles.length; i++) {
                    const { objectKey, fileName, fileSize, nameBytes } = validFiles[i];
                    write(this.buildLocalFileHeader(nameBytes, fileSize));
                    centralDir.push({ nameBytes, fileSize, offset: zipOffset });
                    zipOffset += BigInt(30 + nameBytes.length + 20 + fileSize);

                    const obj = await this.fetchWithRetry(objectKey, fileName);
                    if (obj) {
                        const reader = obj.body.getReader();
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            write(value);
                        }
                    }
                    await this.state.storage.put('progress', Math.round(((i + 1) / validFiles.length) * 90));
                }

                write(this.buildCentralDirectory(centralDir, zipOffset));
                await this.env.MY_BUCKET.put(zipKey, zipData, { httpMetadata: { contentType: 'application/zip' } });
                console.log(`[ZIP DO] Single put() complete (${this.elapsed(startTime)}s)`);

            } else {
                // ── Large ZIP: multipart upload ───────────────────────────
                multipartUpload = await this.env.MY_BUCKET.createMultipartUpload(zipKey, {
                    httpMetadata: { contentType: 'application/zip' }
                });
                console.log(`[ZIP DO] Multipart upload created (${this.elapsed(startTime)}s)`);

                // ✅ 50MB parts — fewer parts = faster complete() call
                // R2 supports up to 10,000 parts × 5GB each
                // 50MB × 10,000 = 500GB max ZIP size
                const PART_SIZE      = 50 * 1024 * 1024;
                const MAX_CONCURRENT = 1; // ✅ reduced to 2 — prevents CPU spike on large files

                const parts       = [];
                let partNumber    = 1;
                let currentBuffer = new Uint8Array(PART_SIZE);
                let currentOffset = 0;
                const centralDir  = [];
                let zipOffset     = 0n;
                const inFlight    = [];

                const uploadPart = async (partNum, data) => {
                    console.log(`[ZIP DO] Part ${partNum} uploading (${(data.length / 1024 / 1024).toFixed(1)}MB) (${this.elapsed(startTime)}s)`);
                    const uploaded = await multipartUpload.uploadPart(partNum, data);
                    console.log(`[ZIP DO] Part ${partNum} done (${this.elapsed(startTime)}s)`);
                    return { partNumber: partNum, etag: uploaded.etag };
                };

                const flushBuffer = async (force = false) => {
                    if (currentOffset === 0) return;
                    if (!force && currentOffset < PART_SIZE) return;

                    // ✅ Drain oldest in-flight before adding new one
                    if (inFlight.length >= MAX_CONCURRENT) {
                        const result = await inFlight.shift();
                        parts.push(result);
                    }

                    const bufferToUpload = currentOffset === PART_SIZE
                        ? currentBuffer
                        : currentBuffer.slice(0, currentOffset);

                    const partNum = partNumber++;
                    inFlight.push(uploadPart(partNum, bufferToUpload));

                    currentBuffer = new Uint8Array(PART_SIZE);
                    currentOffset = 0;
                };

                const append = async (data) => {
                    let dataOffset = 0;
                    while (dataOffset < data.length) {
                        const spaceLeft   = PART_SIZE - currentOffset;
                        const bytesToTake = Math.min(spaceLeft, data.length - dataOffset);

                        currentBuffer.set(data.subarray(dataOffset, dataOffset + bytesToTake), currentOffset);
                        currentOffset += bytesToTake;
                        dataOffset    += bytesToTake;

                        if (currentOffset === PART_SIZE) await flushBuffer();
                    }
                };

                for (let i = 0; i < validFiles.length; i++) {
                    const { objectKey, fileName, fileSize, nameBytes } = validFiles[i];

                    await append(this.buildLocalFileHeader(nameBytes, fileSize));
                    centralDir.push({ nameBytes, fileSize, offset: zipOffset });
                    zipOffset += BigInt(30 + nameBytes.length + 20 + fileSize);

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
                        let remaining = fileSize;
                        while (remaining > 0) {
                            const size = Math.min(4 * 1024 * 1024, remaining);
                            await append(new Uint8Array(size));
                            remaining -= size;
                        }
                    }

                    await this.state.storage.put('progress', Math.round(((i + 1) / validFiles.length) * 90));
                }

                // Flush central directory + final part
                await append(this.buildCentralDirectory(centralDir, zipOffset));
                await flushBuffer(true);

                // ✅ Wait for ALL in-flight parts sequentially to avoid memory spike
                console.log(`[ZIP DO] Waiting for ${inFlight.length} in-flight parts (${this.elapsed(startTime)}s)`);
                for (const promise of inFlight) {
                    const result = await promise;
                    parts.push(result);
                }

                // ✅ Sort parts by partNumber before completing
                parts.sort((a, b) => a.partNumber - b.partNumber);

                const totalParts = parts.length;
                console.log(`[ZIP DO] Completing multipart with ${totalParts} parts (${this.elapsed(startTime)}s)`);

                // ✅ Complete with retry — large ZIPs can timeout on first attempt
                let completeSuccess = false;
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                        await multipartUpload.complete(parts);
                        completeSuccess = true;
                        console.log(`[ZIP DO] Multipart complete (${totalParts} parts) (${this.elapsed(startTime)}s)`);
                        break;
                    } catch (err) {
                        console.error(`[ZIP DO] Complete attempt ${attempt} failed: ${err.message}`);
                        if (attempt < 3) {
                            await new Promise(r => setTimeout(r, 2000 * attempt));
                        }
                    }
                }

                if (!completeSuccess) {
                    throw new Error('Failed to complete multipart upload after 3 attempts');
                }
            }

            await this.notifyBackend(transferId, zipKey, shortId);
            await this.state.storage.put('status',   'completed');
            await this.state.storage.put('progress', 100);
            await this.state.storage.put('zipKey',   zipKey);
            console.log(`[ZIP DO] ✅ SUCCESS ${shortId} in ${this.elapsed(startTime)}s`);

        } catch (error) {
            console.error(`[ZIP DO] ❌ FAILED ${shortId} after ${this.elapsed(startTime)}s: ${error.message}`);
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
        const zip64ExtraSize = 20;
        const buf  = new ArrayBuffer(30 + nameBytes.length + zip64ExtraSize);
        const view = new DataView(buf);
        view.setUint32(0,  0x04034b50, true);
        view.setUint16(4,  45,         true);
        view.setUint16(6,  0x0000,     true);
        view.setUint16(8,  0,          true);
        view.setUint16(10, 0,          true);
        view.setUint16(12, 0,          true);
        view.setUint32(14, 0,          true);
        view.setUint32(18, 0xFFFFFFFF, true);
        view.setUint32(22, 0xFFFFFFFF, true);
        view.setUint16(26, nameBytes.length, true);
        view.setUint16(28, zip64ExtraSize,   true);
        new Uint8Array(buf).set(nameBytes, 30);
        const extraOffset = 30 + nameBytes.length;
        view.setUint16(extraOffset,      0x0001,              true);
        view.setUint16(extraOffset + 2,  16,                  true);
        view.setBigUint64(extraOffset + 4,  BigInt(fileSize), true);
        view.setBigUint64(extraOffset + 12, BigInt(fileSize), true);
        return new Uint8Array(buf);
    }

    buildCentralDirectory(entries, cdOffset) {
        const records = [];
        let cdSize = 0n;
        const cdOffsetBig = BigInt(cdOffset);

        for (const entry of entries) {
            const zip64ExtraSize = 32;
            const recSize = 46 + entry.nameBytes.length + zip64ExtraSize;
            const buf     = new ArrayBuffer(recSize);
            const view    = new DataView(buf);
            view.setUint32(0,  0x02014b50,  true);
            view.setUint16(4,  45,          true);
            view.setUint16(6,  45,          true);
            view.setUint16(8,  0x0000,      true);
            view.setUint16(10, 0,           true);
            view.setUint16(12, 0,           true);
            view.setUint16(14, 0,           true);
            view.setUint32(16, 0,           true);
            view.setUint32(20, 0xFFFFFFFF,  true);
            view.setUint32(24, 0xFFFFFFFF,  true);
            view.setUint16(28, entry.nameBytes.length, true);
            view.setUint16(30, zip64ExtraSize,         true);
            view.setUint16(32, 0,           true);
            view.setUint16(34, 0xFFFF,      true);
            view.setUint16(36, 0,           true);
            view.setUint32(38, 0,           true);
            view.setUint32(42, 0xFFFFFFFF,  true);
            new Uint8Array(buf).set(entry.nameBytes, 46);
            const extraOffset = 46 + entry.nameBytes.length;
            view.setUint16(extraOffset,      0x0001,                    true);
            view.setUint16(extraOffset + 2,  28,                        true);
            view.setBigUint64(extraOffset + 4,  BigInt(entry.fileSize), true);
            view.setBigUint64(extraOffset + 12, BigInt(entry.fileSize), true);
            view.setBigUint64(extraOffset + 20, entry.offset,           true);
            view.setUint32(extraOffset + 28, 0,                         true);
            records.push(new Uint8Array(buf));
            cdSize += BigInt(recSize);
        }

        const zip64Eocd = new ArrayBuffer(56);
        const z64v = new DataView(zip64Eocd);
        z64v.setUint32(0,  0x06064b50,                true);
        z64v.setBigUint64(4,  44n,                    true);
        z64v.setUint16(12, 45,                        true);
        z64v.setUint16(14, 45,                        true);
        z64v.setUint32(16, 0,                         true);
        z64v.setUint32(20, 0,                         true);
        z64v.setBigUint64(24, BigInt(entries.length), true);
        z64v.setBigUint64(32, BigInt(entries.length), true);
        z64v.setBigUint64(40, cdSize,                 true);
        z64v.setBigUint64(48, cdOffsetBig,            true);
        records.push(new Uint8Array(zip64Eocd));

        const zip64Locator = new ArrayBuffer(20);
        const z64lv = new DataView(zip64Locator);
        z64lv.setUint32(0,  0x07064b50,                 true);
        z64lv.setUint32(4,  0,                           true);
        z64lv.setBigUint64(8, cdOffsetBig + cdSize,      true);
        z64lv.setUint32(16, 1,                           true);
        records.push(new Uint8Array(zip64Locator));

        const eocd = new ArrayBuffer(22);
        const ev   = new DataView(eocd);
        ev.setUint32(0,  0x06054b50, true);
        ev.setUint16(4,  0,          true);
        ev.setUint16(6,  0,          true);
        ev.setUint16(8,  entries.length > 0xFFFF ? 0xFFFF : entries.length, true);
        ev.setUint16(10, entries.length > 0xFFFF ? 0xFFFF : entries.length, true);
        ev.setUint32(12, 0xFFFFFFFF, true);
        ev.setUint32(16, 0xFFFFFFFF, true);
        ev.setUint16(20, 0,          true);
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