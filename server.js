// PixelForge AI backend: serves the website and generates images through
// Hugging Face Inference Providers (FLUX.1-schnell).
// The token lives only in the HF_TOKEN environment variable and never reaches the browser.
require('dotenv').config({ path: ['.env', 'token.env'] }); // loads HF_TOKEN from .env or token.env (hosts set it in their own dashboard)

// Reads the token from the environment. The placeholder from .env.example counts as "not set".
function getToken() {
  const t = (process.env.HF_TOKEN || '').trim();
  return !t || t === 'your_token_here' ? '' : t;
}
const express = require('express');
const path = require('path');

const app = express();
app.set('trust proxy', 1); // correct client IP behind Render/Railway/Fly proxies
const PORT = process.env.PORT || 3000;
const MODEL = 'black-forest-labs/FLUX.1-schnell';
const PROVIDER = process.env.HF_PROVIDER || 'auto';

// The official client is created once, the first time it is needed.
let client = null;
async function getClient() {
  if (!client) {
    const { InferenceClient } = await import('@huggingface/inference');
    client = new InferenceClient(getToken());
  }
  return client;
}

// Sizes are multiples of 8, as FLUX requires.
const RATIOS = {
  '1:1': [1024, 1024],
  '16:9': [1024, 576],
  '9:16': [576, 1024],
  '4:3': [1024, 768],
};
const STYLES = {
  Realistic: 'photorealistic, natural lighting, sharp focus, high detail',
  Anime: 'anime style, vibrant colors, clean line art, studio quality illustration',
  '3D': '3D render, soft studio lighting, smooth materials, octane render',
  Fantasy: 'fantasy art, magical atmosphere, epic, richly detailed, painterly',
  Cinematic: 'cinematic still, dramatic lighting, shallow depth of field, film grain, wide color grading',
  'Digital Art': 'digital art, concept art, polished, trending on artstation',
};

const moderation = require('./moderation');

// Tiny in-memory rate limit: 8 requests per minute per IP.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < 60000)) hits.delete(k);
  return recent.length > 8;
}

app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (req, res) => {
  res.json({ configured: Boolean(getToken()) });
});

app.post('/api/generate', async (req, res) => {
  const token = getToken();
  if (!token) {
    return res.status(503).json({
      code: 'missing_token',
      error: 'Server setup needed: add your Hugging Face token as HF_TOKEN in the server environment, then restart.',
    });
  }
  if (rateLimited(req.ip)) {
    return res.status(429).json({ error: 'You’re generating too fast. Wait a minute and try again.' });
  }

  const { prompt, style, ratio } = req.body || {};
  if (typeof prompt !== 'string' || prompt.trim().length < 3) {
    return res.status(400).json({ error: 'Write a few words describing your image.' });
  }
  if (prompt.length > 500) {
    return res.status(400).json({ error: 'Keep the description under 500 characters.' });
  }
  if (!STYLES[style] || !RATIOS[ratio]) {
    return res.status(400).json({ error: 'Choose a valid style and aspect ratio.' });
  }
  try {
    const verdict = await moderation.check(prompt, { ip: req.ip });
    if (!verdict.allowed) {
      return res.status(400).json({ error: verdict.reason || 'That description isn’t allowed.' });
    }
  } catch (e) {
    console.error('Moderation check failed:', e.message);
    return res.status(500).json({ error: 'The safety check failed. Try again in a moment.' });
  }

  const [width, height] = RATIOS[ratio];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);

  try {
    const hf = await getClient();
    const blob = await hf.textToImage(
      {
        provider: PROVIDER,
        model: MODEL,
        inputs: `${prompt.trim()}, ${STYLES[style]}`,
        parameters: { width, height, num_inference_steps: 4 },
      },
      { signal: controller.signal }
    );
    const type = blob.type && blob.type.startsWith('image/') ? blob.type : 'image/png';
    const buf = Buffer.from(await blob.arrayBuffer());
    res.json({ image: `data:${type};base64,${buf.toString('base64')}`, width, height });
  } catch (err) {
    const timedOut = err.name === 'AbortError' || controller.signal.aborted;
    const msg = String((err && err.message) || err || '');
    const status = err?.httpResponse?.status || Number((msg.match(/\b(401|402|403|404|422|429|503)\b/) || [])[1]) || 0;
    console.error('Generate failed:', status || '', msg.slice(0, 300));
    if (timedOut) return res.status(504).json({ error: 'Generation took too long. Try again or simplify the prompt.' });
    const map = {
      401: 'Your Hugging Face token was rejected. Check HF_TOKEN on the server.',
      403: 'Your token doesn’t have the “Make calls to Inference Providers” permission. Create a new token with it.',
      402: 'Your Hugging Face credits are used up. Add credits or try again later.',
      400: 'The provider rejected these image settings. Try the 1:1 ratio or set HF_PROVIDER to another provider.',
      422: 'The provider rejected these image settings. Try the 1:1 ratio or set HF_PROVIDER to another provider.',
      404: 'FLUX.1-schnell isn’t available from the selected provider. Set HF_PROVIDER to another provider, such as fal-ai.',
      429: 'Hugging Face is rate limiting requests. Wait a moment and try again.',
      503: 'The model is starting up. Try again in about 30 seconds.',
    };
    res.status(status === 503 ? 503 : 502).json({ error: map[status] || 'The image service had a problem. Try again in a moment.' });
  } finally {
    clearTimeout(timer);
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API route.' }));
app.use((err, req, res, next) => {
  const bad = err && (err.type === 'entity.parse.failed' || err.status === 400);
  res.status(bad ? 400 : 500).json({ error: bad ? 'The request was not valid.' : 'Unexpected server error.' });
});

app.listen(PORT, () => {
  console.log(`PixelForge AI running at http://localhost:${PORT}`);
  if (!getToken()) console.warn('HF_TOKEN is not set. Copy .env.example to .env and add your token.');
});
