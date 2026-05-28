# Grocery Goggles 🔎

Point your phone's camera at a packaged-food ingredient label and get each
ingredient color-coded: **🟢 green** (fine), **🟡 yellow** (in moderation),
**🔴 red** (best avoided), with a one-line reason for the flags.

It's a **Progressive Web App**: one codebase that installs to the home screen on
both iOS and Android, no app store, no servers. A single multimodal LLM call does
both the OCR *and* the classification, so it's robust on glossy, curved, and
small-print labels where traditional OCR struggles, and the heavy lifting happens
in the cloud (your phone stays cool).

> ⚠️ Verdicts are an **opinionated heuristic** to help you read labels faster, not
> medical or nutritional advice. The default rubric reflects one point of view; you
> can override it in Settings.

## How it works

```
camera photo → downscale on-device → Gemini (OCR + verdicts, JSON) → color-coded list
```

- **Capture** uses the native camera via `<input type="file" capture>`, which avoids
  a long-standing iOS bug where installed PWAs lose camera permission between sessions.
- **Classification** uses Google's Gemini API. The model returns structured JSON
  (ingredient, verdict, reason) that the app renders directly.
- **History** (last 50 scans) and your settings live in the browser
  (IndexedDB + localStorage). Nothing is sent anywhere except directly from your
  phone to Google's API.

## Setup (one time, ~3 minutes)

You bring your own free Google AI Studio API key (BYOK), so there's no shared
backend to fund or rate-limit.

1. Open **https://aistudio.google.com/apikey** and click **Create API key**.
   (A key on a dedicated/free project is recommended so it's easy to revoke.)
2. Open the app in your phone's browser.
3. Paste the key when prompted. It's stored only on your device.

### Install to the home screen

- **iOS (Safari):** Share → **Add to Home Screen**.
- **Android (Chrome):** menu → **Install app** / **Add to Home screen**.

## Configuration

The model is a single constant at the top of [`app.js`](./app.js):

```js
const MODEL = "gemini-3.5-flash";
```

| Model | Trade-off |
|-------|-----------|
| `gemini-3.5-flash` | **Default.** Best OCR/vision quality. Newest model, so free-tier rate limits are tighter. |
| `gemini-2.5-flash` | Slightly weaker, very cheap, higher free-tier limits. Great fallback. |
| `gemini-2.5-flash-lite` | Cheapest/fastest. Fine for clean labels, weaker on hard ones. |

If you scan a lot and hit free-tier limits on `gemini-3.5-flash`, switch to
`gemini-2.5-flash`.

**Personal preferences** (Settings): a free-form box injected into the prompt to
nudge verdicts, e.g. *"I'm vegan, flag dairy as red. I'm fine with cane sugar. I
avoid seed oils."*

## Develop locally

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Service workers require `https://` **or** `localhost`, so to test from a phone on
your LAN, deploy to a real HTTPS host (below) rather than hitting the dev box's IP.

### Tests

A headless-browser integration test drives the real UI with a stubbed Gemini
API (setup, capture → render, XSS hardening, history, error paths):

```bash
cd tests && npm install && npx playwright install chromium && npm test
```

See [`tests/`](./tests/). The app itself stays dependency-free; tooling lives
only under `tests/`.

## Deploy (andromeda)

Static files behind nginx. One-time setup on the server:

```bash
# on andromeda
sudo git clone https://github.com/edementhon/grocerygoggles.git /opt/grocerygoggles
# add an nginx server block: root /opt/grocerygoggles; try_files $uri $uri/ /index.html;
# then issue TLS with certbot for the chosen domain
```

Thereafter, from your dev machine:

```bash
./deploy.sh
```

which bumps the service-worker cache version (so clients pick up changes), pushes
to GitHub, and pulls + reloads nginx on andromeda. See [`deploy.sh`](./deploy.sh).

## Roadmap

- Bounding-box overlay drawn on the photo itself.
- Barcode scan + [Open Food Facts](https://world.openfoodfacts.org/) lookup for
  known products (instant, no API call).
- Optional shared backend (e.g. a Cloudflare Worker holding one key) if BYOK
  onboarding proves too much friction.

## License

MIT. See [LICENSE](./LICENSE).
