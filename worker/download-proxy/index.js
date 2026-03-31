export default {
    async fetch(request, env) {
        const allowedOrigins = [
            'https://app.sendbycloud.com',
            'http://localhost:5173'
        ];

        const origin = request.headers.get('Origin') || '';
        const allowedOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

        const corsHeaders = {
            'Access-Control-Allow-Origin': allowedOrigin,
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
            'Access-Control-Allow-Headers': 'Range, Content-Type',
            'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
            'Access-Control-Max-Age': '86400',
        };

        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders });
        }

        const url = new URL(request.url);
        const key = url.searchParams.get('key');
        const start = url.searchParams.get('start');
        const end = url.searchParams.get('end');

        if (!key || start === null || end === null) {
            return new Response('Missing key, start, or end', { status: 400, headers: corsHeaders });
        }

        try {
            const object = await env.R2_BUCKET.get(key, {
                range: {
                    offset: Number(start),
                    length: Number(end) - Number(start) + 1
                }
            });

            if (!object) {
                return new Response('Not found', { status: 404, headers: corsHeaders });
            }

            return new Response(object.body, {
                status: 206,
                headers: {
                    ...corsHeaders,
                    'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
                    'Content-Range': `bytes ${start}-${end}/*`,
                    'Content-Length': String(Number(end) - Number(start) + 1),
                    'Accept-Ranges': 'bytes',
                    'Cache-Control': 'private, no-cache',
                }
            });

        } catch (err) {
            return new Response('Error: ' + err.message, { status: 500, headers: corsHeaders });
        }
    }
};