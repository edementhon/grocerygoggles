# Grocery Goggles 🔎

Point your phone's camera at a packaged-food label and get each ingredient
color-coded: **🟢 green** (fine), **🟡 yellow** (in moderation), **🔴 red**
(best avoided), with a one-line reason for the flags. It also reads the
**Nutrition Facts** and normalizes them to **per 100 g / 100 ml** so you can
compare products with different serving sizes side by side (EU-label style).

It's a **Progressive Web App**: one codebase that installs to the home screen on
both iOS and Android, no app store, no servers. A single multimodal LLM call does
the OCR *and* the classification *and* the nutrition transcription, so it's robust
on glossy, curved, and small-print labels where traditional OCR struggles, and the
heavy lifting happens in the cloud (your phone stays cool).

> ⚠️ Verdicts are an **opinionated heuristic** to help you read labels faster, not
> medical or nutritional advice. The default rubric reflects one point of view; you
> can override it in Settings.

## How it works

```
camera photo(s) → downscale on-device → Gemini (verdicts + nutrition, JSON)
                → normalize to per-100g in JS → color-coded list + nutrition table
```

- **Capture** uses the native camera via `<input type="file" capture>`, which avoids
  a long-standing iOS bug where installed PWAs lose camera permission between sessions.
  Snap a **burst of photos** into the tray, then **Analyze once**: photos of the same
  product are merged, and if you shot **two different products** the model groups them
  and you get a comparison, all from one API call (the round-trip is the slow part, so
  it's one, not several).
- **Classification + nutrition** use Google's Gemini API, which returns structured JSON.
  The model only *transcribes* nutrition and *judges* ingredient quality; the per-100g/ml
  **math is done in JavaScript** (see `nutrition.js`) so it's deterministic and unit-tested.
- **Compare** (one product per photo set → automatic, or pick saved products in the
  Compare tab) puts items side by side per 100 g / 100 ml with the better value per row
  highlighted, plus a **flagged-additive count** and a one-line "cleaner pick" verdict.
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

**Speed vs. quality** (Settings) picks the model, since a slow scan in the aisle
just won't get used:

| Mode | Model | When |
|------|-------|------|
| **Fast** (default) | `gemini-2.5-flash` (thinking off) | Quick; strong OCR on printed labels. |
| **Best quality** | `gemini-3.5-flash` | Bump to this if a tricky/glossy/tiny label won't read. |

Both IDs live in the `MODELS` constant at the top of [`app.js`](./app.js); swap in
`gemini-2.5-flash-lite` there if you want the fastest/cheapest option.

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

```bash
cd tests
npm install && npx playwright install chromium
node nutrition.test.mjs   # unit: per-100g/ml normalization math
npm test                  # integration: real UI, stubbed Gemini
```

The integration test (headless Chromium, stubbed API) covers setup, the
multi-photo capture tray, ingredient + nutrition rendering, per-100g
normalization, XSS hardening, history, the compare view, and both error paths.
The app itself stays dependency-free; tooling lives only under `tests/`.

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
