import { ZipDurableObject } from './ZipDurableObject.js';

export { ZipDurableObject };

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // Only allow requests from your backend
        const authHeader = request.headers.get('X-Worker-Secret');
        if (authHeader !== env.WORKER_SECRET) {
            return new Response('Unauthorized', { status: 401 });
        }

        if (request.method === 'POST' && url.pathname === '/create-zip') {
            const body = await request.json();
            const { files, shortId, transferId } = body;

            if (!files || !shortId) {
                return new Response(JSON.stringify({ error: 'Missing files or shortId' }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            // Route to Durable Object — one instance per transfer
            const id = env.ZIP_DO.idFromName(shortId);
            const stub = env.ZIP_DO.get(id);

            // Forward request to Durable Object
            return stub.fetch(request.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ files, shortId, transferId })
            });
        }

        if (request.method === 'GET' && url.pathname.startsWith('/zip-status/')) {
            const shortId = url.pathname.split('/zip-status/')[1];
            const id = env.ZIP_DO.idFromName(shortId);
            const stub = env.ZIP_DO.get(id);
            return stub.fetch(request.url, { method: 'GET' });
        }

        return new Response('Not Found', { status: 404 });
    }
};
