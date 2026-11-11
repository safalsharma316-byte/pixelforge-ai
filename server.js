/* PixelForge AI backend (Railway). Zero dependencies, needs Node 18+.
   Env vars (Railway > Variables):
     HF_TOKEN         Hugging Face token (required for /api/generate)
     ALLOWED_ORIGINS  comma-separated exact origins, e.g. https://your-site.netlify.app
     PORT             set automatically by Railway
*/
const http = require('http');

const PORT = process.env.PORT || 3000;
const HF_TOKEN = (process.env.HF_TOKEN || '').trim();
const MODEL_URL =
  process.env.HF_MODEL_URL ||
  'https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell';

/* ---- CORS: exact origins only, no wildcard, no trailing slash ---- */
const DEFAULT_ORIGINS = [
  'https://pixalforge-ai.netlify.app',
];
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : DEFAULT_ORIGINS
).map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);

function setCors(req, res) {
  const origin = req.headers.origin;
  res.setHeader('Vary', 'Origin');
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      req.headers['access-control-request-headers'] || 'Content-Type'
    );
    res.setHeader('Access-Control-Max-Age', '86400');
  }
}

function send(req, res, status, obj) {
  setCors(req, res);
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJson(req, limit = 100 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('That request was too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(Object.assign(new Error('Invalid request body.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/* ---- Style + aspect ratio mapping (matches the frontend options) ---- */
const STYLE_HINTS = {
  Realistic: 'photorealistic, highly detailed, natural lighting, sharp focus',
  Anime: 'anime style, vibrant colors, clean line art, detailed illustration',
  '3D': '3D render, octane render, soft studio lighting, high detail',
  Fantasy: 'fantasy art, epic, magical atmosphere, highly detailed',
  Cinematic: 'cinematic still, dramatic lighting, shallow depth of field, film grain',
  'Digital Art': 'digital art, concept art, vivid colors, highly detailed',
};
const SIZES = {
  '1:1': [1024, 1024],
  '16:9': [1024, 576],
  '9:16': [576, 1024],
  '4:3': [1024, 768],
};

/* ---- Simple per-IP rate limit (10 generations / minute) ---- */
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 10;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of hits) {
    if (!arr.some((t) => now - t < 60000)) hits.delete(ip);
  }
}, 60000).unref();

async function handleGenerate(req, res) {
  if (!HF_TOKEN) {
    return send(req, res, 503, {
      error: 'Server is not configured. Add HF_TOKEN in Railway Variables.',
      code: 'missing_token',
    });
  }
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (rateLimited(ip)) {
    return send(req, res, 429, { error: 'Too many requests. Please wait a moment and try again.' });
  }

  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return send(req, res, e.status || 400, { error: e.message });
  }

  const prompt = String(body.prompt || '').trim().slice(0, 1000);
  if (prompt.length < 3) {
    return send(req, res, 400, { error: 'Write a few words describing your image first.' });
  }
  const style = STYLE_HINTS[body.style] ? body.style : 'Realistic';
  const [width, height] = SIZES[body.ratio] || SIZES['1:1'];
  const fullPrompt = prompt + ', ' + STYLE_HINTS[style];

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 110000);
  try {
    const hf = await fetch(MODEL_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + HF_TOKEN,
        'Content-Type': 'application/json',
        Accept: 'image/png',
      },
      body: JSON.stringify({ inputs: fullPrompt, parameters: { width, height } }),
      signal: ctl.signal,
    });

    if (!hf.ok) {
      const text = await hf.text().catch(() => '');
      console.error('HF error', hf.status, text.slice(0, 300));
      if (hf.status === 401 || hf.status === 403) {
        return send(req, res, 502, {
          error: 'The Hugging Face token was rejected. Check HF_TOKEN in Railway.',
          code: 'bad_token',
        });
      }
      if (hf.status === 429) {
        return send(req, res, 429, { error: 'Too many requests. Please wait a moment and try again.' });
      }
      if (hf.status === 503) {
        return send(req, res, 503, { error: 'The model is warming up. Please try again in a few seconds.' });
      }
      return send(req, res, 502, { error: 'The image service had a problem. Please try again.' });
    }

    const type = (hf.headers.get('content-type') || 'image/png').split(';')[0];
    if (!type.startsWith('image/')) {
      return send(req, res, 502, { error: 'The image service returned an unexpected reply. Please try again.' });
    }
    const buf = Buffer.from(await hf.arrayBuffer());
    return send(req, res, 200, { image: 'data:' + type + ';base64,' + buf.toString('base64') });
  } catch (e) {
    console.error('Generate failed:', e.message);
    if (e.name === 'AbortError') {
      return send(req, res, 504, { error: 'The model took too long to respond. Please try again.' });
    }
    return send(req, res, 502, { error: 'Could not reach the image service. Please try again.' });
  } finally {
    clearTimeout(timer);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const path = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';

    // CORS preflight: answer before anything else
    if (req.method === 'OPTIONS') {
      setCors(req, res);
      res.writeHead(204, { 'Content-Length': '0' });
      return res.end();
    }

    if (req.method === 'GET' && path === '/') {
      return send(req, res, 200, { ok: true, service: 'pixelforge-ai' });
    }
    if (req.method === 'GET' && path === '/health') {
      return send(req, res, 200, { ok: true });
    }
    if (req.method === 'GET' && path === '/api/status') {
      return send(req, res, 200, { configured: !!HF_TOKEN });
    }
    if (req.method === 'POST' && path === '/api/generate') {
      return await handleGenerate(req, res);
    }
    return send(req, res, 404, { error: 'Not found.' });
  } catch (e) {
    console.error('Unhandled error:', e);
    if (!res.headersSent) send(req, res, 500, { error: 'Something went wrong. Try again.' });
  }
});

server.requestTimeout = 0;
server.headersTimeout = 65000;
server.keepAliveTimeout = 65000;

server.listen(PORT, '0.0.0.0', () => {
  console.log('PixelForge API listening on', PORT);
  console.log('Allowed origins:', ALLOWED_ORIGINS.join(', ') || '(none)');
  console.log('HF_TOKEN configured:', !!HF_TOKEN);
});
