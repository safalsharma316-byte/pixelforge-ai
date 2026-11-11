# PixelForge AI

Text-to-image site using **FLUX.1-schnell** through Hugging Face **Inference Providers**.
Node + Express backend, plain HTML/CSS/JS frontend (no build step).

How it stays secure: the browser only talks to `POST /api/generate` on your server. The server reads `HF_TOKEN` from its environment and calls Hugging Face. The token never appears in `public/index.html`.

## 1. Get a token
1. Go to https://huggingface.co/settings/tokens → **Create new token**.
2. Choose **Fine-grained** and tick **Make calls to Inference Providers** (a classic "Read" token also works).
3. Copy it (starts with `hf_`). Treat it like a password.

## 2. Run locally
```
# put your token in token.env (visible file) or in a new .env file:  HF_TOKEN=hf_yourtoken
npm install
npm start
```
Open http://localhost:3000. The status badge turns green when the token is found.

## 3. Deploy (Render example)
1. Push this folder to a GitHub repo (`.env` is git-ignored, so the token is not uploaded).
2. Render → **New** → **Web Service** → pick the repo.
3. Runtime **Node**, Build command `npm install`, Start command `npm start`.
4. Open **Environment** → **Add Environment Variable** → Key `HF_TOKEN`, Value your token → Save.
5. Deploy. Your site gets an HTTPS URL (this also enables "Save to phone" sharing on Android).

Other hosts, same idea:
- **Railway**: project → service → **Variables** → New Variable `HF_TOKEN`.
- **Fly.io**: `fly secrets set HF_TOKEN=hf_xxx`
- **Vercel/Netlify**: this is a long-running Express server, so use Render, Railway, Fly.io or a VPS instead.

Add or change the variable any time, then redeploy/restart.

## Troubleshooting
- Yellow "Setup needed": `HF_TOKEN` isn't set on the server, or the server wasn't restarted.
- "token rejected" / "doesn't have permission": create a new token with Inference Providers permission.
- "credits used up": check billing at https://huggingface.co/settings/billing.
- "not available from the selected provider": set env var `HF_PROVIDER=fal-ai` (or `together`, `replicate`, `nebius`).

## Files
- `server.js` – API (`POST /api/generate`, `GET /api/status`), rate limit
- `moderation.js` – the one place that checks prompts; replace `check()` with your own moderation
- `public/index.html` – the whole interface (unchanged)

The default moderation in `moderation.js` is a basic keyword check. Replace it with your own moderation before opening this to the public.
