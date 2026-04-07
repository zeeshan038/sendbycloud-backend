// services/zipService.js
const inProgress = new Set();

export const triggerWorkerZip = async (transferId, files, shortId) => {
    if (inProgress.has(shortId)) {
        console.log(`[ZIP] Already triggered for ${shortId}, skipping`);
        return;
    }
    inProgress.add(shortId);

    try {
        const response = await fetch(`${process.env.CLOUDFLARE_WORKER_URL}/create-zip`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Worker-Secret': process.env.WORKER_SECRET
            },
            body: JSON.stringify({ transferId, files, shortId })
        });

        const data = await response.json();
        console.log(`[ZIP] Worker triggered for ${shortId}:`, data.status);
        return data;
    } catch (err) {
        console.error(`[ZIP] Failed to trigger worker for ${shortId}:`, err);
    } finally {
        inProgress.delete(shortId);
    }
};

export const checkZipStatus = async (shortId) => {
    try {
        const response = await fetch(
            `${process.env.CLOUDFLARE_WORKER_URL}/zip-status/${shortId}`,
            {
                headers: { 'X-Worker-Secret': process.env.WORKER_SECRET }
            }
        );
        return await response.json();
    } catch (err) {
        console.error(`[ZIP] Status check failed for ${shortId}:`, err);
        return { status: 'unknown' };
    }
};
