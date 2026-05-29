# Grocery Goggles — Spec

A phone-based PWA that points the camera at a packaged-food ingredient list and highlights each ingredient in red (avoid), yellow (caution), or green (fine).

## Original brief

> I'd like to make something for phones that lets people point the phone's camera at an ingredients list and have it highlight ingredients that aren't great in red, ingredients that are good in green, and ingredients that are maybe in the middle in yellow. I'd probably be running this on iOS, but my friend wants to run it on his Android phone, so he was asking if I could make it a progressive web app. I'm not really sure. Personally, I'd prefer not to run any infrastructure to enable this, but it seems like I might need to in order to make it a progressive web app, right? His point was, though, that he doesn't want his phone to heat up while he's in the grocery store running a bunch of, like, local inference, anything like that. Fair enough, maybe. Do you have any thoughts on ways to approach this in a way that's very robust? I think I'd like to use local language models, but he suggested maybe just using open router and having the user put in a key, and then, you know, having that serve the heavyweight classification. Are there any models that would be particularly good for this that are great at picking out text on ingredients lists while being fast and cheap?

## Goals

- Works on iOS and Android from one codebase.
- No infrastructure beyond static hosting (andromeda, nginx).
- Open source from day one at https://github.com/edementhon/grocerygoggles
- BYOK (bring your own key) in the first pass.
- Robust OCR on a variety of label/container types using a multimodal LLM.
- Doesn't cook the user's phone in the grocery aisle.

## Architecture decisions

**PWA, static-hosted on andromeda (nginx).** Zero new services. A PWA is just HTML/CSS/JS, so "no infrastructure" is achievable on standard static hosting.

**BYOK (Bring Your Own Key).** Each user pastes their own Google AI Studio key on first run, stored in `localStorage`. Free tier on Gemini 2.5 Flash-Lite (~1,500 req/day) covers personal use entirely. Rationale: the project owner doesn't want to fund or rate-limit a public API.

**Single Gemini call per scan.** Handles OCR + per-ingredient verdict + short reason in one shot. Multimodal LLMs have leapfrogged classical OCR (Tesseract, PaddleOCR) for glare-on-curved-plastic photos, and bundling classification into the same call is essentially free. This was the key insight that killed the "local OCR + database lookup" branch — OCR quality is the hard part, and an LLM does it better.

**Image capture via `<input type="file" accept="image/*" capture="environment">`.** Invokes the native camera app on both iOS and Android. Sidesteps the [iOS PWA standalone-mode getUserMedia bug](https://bugs.webkit.org/show_bug.cgi?id=185448) where camera permission isn't persisted across sessions. Loses live preview overlay, gains rock-solid reliability. For a snap-and-classify flow, live preview isn't needed.

**List-view results** for v1 (photo at top, color-coded ingredient list below with tap-to-expand reasons). Overlay-on-image is a v2 nice-to-have because it requires bounding-box detection.

**Custom rubric in v1.** Settings has a freeform textarea ("Personal preferences") that gets injected into the system prompt. Lets the user nudge verdicts ("I'm vegan, flag dairy red"; "I'm fine with cane sugar"; "I avoid seed oils").

**Scan history in v1.** Last 50 scans stored in IndexedDB (thumbnail + timestamp + verdict summary + full ingredient list). Separate "History" view with tap-to-expand. Per-device, no cross-device sync.

## Stack

- **Vanilla HTML/CSS/JS**, single page, no build step. Keeps bundle tiny, deploys instantly, no framework to maintain.
- **PWA manifest + service worker** so it installs to home screen and the app shell works offline (scans themselves need network).
- **Gemini 2.5 Flash-Lite** via the Google Generative Language REST API (`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent`). Pricing: $0.10/$0.40 per 1M tokens. A scan is ~2k tokens total, so ~$0.0005/scan, but free tier covers personal use.
- **Structured JSON output** via `responseMimeType: application/json` + a response schema, so we can parse reliably without regex.

## Files

All at repo root:

| File | Purpose |
|------|---------|
| `index.html` | Single page: capture button, photo preview, result list, history view, settings drawer |
| `app.js` | State, capture, Gemini API call, render, key + rubric management, history read/write |
| `db.js` | Small IndexedDB wrapper (one object store: `scans`) |
| `style.css` | Mobile-first, large tap targets, traffic-light palette |
| `manifest.webmanifest` | PWA manifest: name, icons, `display: standalone`, theme color |
| `sw.js` | Service worker, caches the app shell, network-only for API calls |
| `icons/icon-192.png` | 192x192 maskable, generated from SVG |
| `icons/icon-512.png` | 512x512 maskable, generated from SVG |
| `icons/apple-touch-icon.png` | 180x180, iOS home-screen icon |
| `deploy.sh` | Bumps `CACHE_VERSION` in `sw.js`, commits, pushes, ssh's to andromeda to pull and reload nginx |
| `README.md` | Setup: get a Gemini key, install to home screen on iOS/Android |

## Capture flow (`app.js`)

1. User taps "Scan." `<input type="file" accept="image/*" capture="environment">` opens native camera.
2. On selection, read as base64, downscale to max 1024px wide on a `<canvas>` (keeps the request payload small, fine for OCR).
3. Show photo immediately. Show a spinner over the result area.
4. POST to Gemini with the image + prompt + response schema.
5. Parse JSON, render the ingredient list, write to history.

## Prompt

Sent as the text part of the user turn, alongside the image.

**Base instructions:**
> You are reading a packaged food ingredient label. Extract every ingredient in order. For each, classify as `red` (avoid: artificial colors, HFCS, BHA/BHT, partially hydrogenated oils, artificial sweeteners, etc.), `yellow` (use sparingly: refined sugars, seed oils, common preservatives, natural flavors), or `green` (whole foods, recognized nutrients, generally-safe additives). Give a ≤12-word reason for each non-green verdict. Also return a 2-4 word `productGuess` describing what kind of product this looks like.

**Custom rubric injection:** if the user has saved a "Personal preferences" string, append under a heading like:
> Additional user preferences (these override the defaults above): ...

**Response schema:**
```json
{
  "ingredients": [
    { "name": "string", "verdict": "red|yellow|green", "reason": "string" }
  ],
  "productGuess": "string"
}
```

If the model can't read the label, return `{ "ingredients": [], "error": "<reason>" }`.

## Key + rubric management

- On first load, if no key in `localStorage`, show a setup card with link to https://aistudio.google.com/apikey, paste field, save.
- Settings drawer: API key field (with reset), Personal Preferences textarea (autosaves on blur), Clear history button.
- Key is never sent anywhere except directly to Google's API from the user's browser.

## History (`db.js` + `app.js`)

- IndexedDB store `scans` with: `id` (auto), `timestamp`, `productGuess`, `thumbnail` (Blob, ~200px JPEG), `ingredients` (full array).
- Cap at 50 entries. When adding, delete oldest if `count > 50`.
- History view: reverse-chronological list of cards (thumbnail, product guess, timestamp, verdict tally like "3🔴 5🟡 12🟢"). Tap to expand the full ingredient list (same renderer as the live result).
- Bottom nav: two tabs, "Scan" and "History."

## Error UX

| Condition | Message |
|-----------|---------|
| Invalid key (401) | Bounce back to setup card with error message |
| Rate limited (429) | "Slow down. Gemini free tier is rate-limited; wait a minute." |
| Network error | "No connection. Try again." |
| Empty/unreadable image | "Couldn't read the label. Try better lighting or closer." |

## PWA niceties

- `theme-color` meta matches header color so iOS status bar blends in.
- `apple-touch-icon` linked separately (iOS ignores manifest icons for home-screen).
- Service worker caches `index.html`, `app.js`, `db.js`, `style.css`, `manifest.webmanifest`, icons. Versioned via a `CACHE_VERSION` const at the top, bumped automatically by `deploy.sh`.

## Hosting (andromeda)

Hosted on andromeda (192.168.50.9, accessed via `ssh andromeda` from Blackwell) alongside the other sites (dementhon.com, tophatmonkey.com, etc.). Pure static site, no Python/uwsgi, just nginx.

Deploy flow:
1. `ssh andromeda` once to set up: pick a deploy directory (likely `/opt/grocerygoggles/`) and a domain.
2. New nginx server block (TLS via certbot like the others) with `root /opt/grocerygoggles;` and `try_files $uri $uri/ /index.html;`.
3. `git clone` the repo into `/opt/grocerygoggles/` on andromeda.
4. From Blackwell, `./deploy.sh` runs: bump `CACHE_VERSION` in `sw.js`, commit, push, then `ssh andromeda 'cd /opt/grocerygoggles && git pull && nginx -t && sudo systemctl reload nginx'`.

Domain TBD, pending user decision.

## Verification

1. Local dev: `python3 -m http.server 8000` in the repo root. Service workers need HTTPS *or* `localhost`, so cross-device testing should go through andromeda.
2. Deploy to andromeda, open the URL on iPhone Safari, "Add to Home Screen."
3. Open the installed icon, paste Gemini API key.
4. Scan five real labels with varied difficulty:
   - Easy: cereal box (flat, large text)
   - Medium: bottled drink (curved, smaller text)
   - Hard: candy bar (glossy, tiny text, lots of additives)
   - Foreign: imported product with non-English label
   - Edge: blurry/dark photo on purpose, verify friendly error
5. Confirm verdicts are reasonable, reasons are short, UI is readable in supermarket lighting.
6. Open History tab, confirm all 5 scans appear with thumbnails, taps expand correctly.
7. Add a custom rubric ("I'm vegan, flag dairy red") and re-scan a dairy product. Confirm dairy gets red.
8. Repeat the core flow on Android Chrome, "Install app."
9. Confirm phone stays cool through ~20 scans.

## Out of scope (v1)

- Bounding-box overlay on the photo (v2).
- Barcode scanning + Open Food Facts lookup for known products (v2). Would cut API calls and give instant results for common items.
- Cross-device history sync (would require a backend).
- Export / share a scan result.

## Nutrition normalization & comparison (v1.1)

Added so two products with different serving sizes can be compared fairly (EU-label style, per 100 g / 100 ml).

- **Multi-photo capture.** A scan can include more than one photo (ingredients on one panel, Nutrition Facts on another). "Scan" now collects photos into a tray, then "Analyze" sends them all in one Gemini call; the model merges them into one product. If it finds ingredients but no nutrition (or vice-versa), the UI nudges the user to add the missing photo and Analyze again (which updates the same history record via `updateScan`, no duplicate).
- **Model transcribes, code computes.** The model only reads the label (serving size in g/ml + per-serving values, and any printed per-100 column). All normalization arithmetic lives in `nutrition.js` (pure, no DOM), so it's deterministic, auditable, and unit-tested (`tests/nutrition.test.mjs`). If the label already prints a per-100 column, that is trusted over recomputation.
- **Basis.** Per 100 g for solids, per 100 ml for liquids, auto-detected from the serving unit. If the serving has no weight/volume (e.g. only "1 cup"), per-100 is impossible, so we show per-serving only with a note rather than guessing density.
- **Compare view.** A third bottom-nav tab. Pick 2+ saved products (only those with a per-100 basis), see a side-by-side per-100 table with the better value per row highlighted (lower calories/sugar/sat-fat/sodium greener; higher protein/fiber greener; carbs uncolored). Warns when mixing g and ml products.
- **Storage.** Records gain `nutrition` (normalized) and `thumbnails[]`; no IndexedDB version bump needed (schemaless records; old scans render as "no nutrition captured").

## Decision log

These are decisions made during planning, with the reasoning, so we don't re-debate them later.

- **PWA, not native.** Two users on different OSes (iOS + Android). PWA covers both with one codebase, no app stores, no developer accounts.
- **BYOK, not centrally-funded.** Owner doesn't want to fund or rate-limit a public API. Friction (~3 min Google AI Studio signup) is acceptable for personal use.
- **LLM-only OCR, not Tesseract/PaddleOCR.** Classical OCR is genuinely bad on real-world ingredient photos (curved, glossy, small text). Multimodal LLMs are a step-change. Bundling classification into the same call is essentially free.
- **Gemini, not GPT-4o-mini or Claude Haiku.** Generous free tier and strong multimodal/OCR. Default is `gemini-3.5-flash` (best vision; chosen because robust OCR is the stated priority and cost is ~nil under BYOK free tier), a one-line switchable constant in `app.js`; `gemini-2.5-flash` is the cheaper higher-rate-limit fallback. The API surface matches OpenRouter if the user ever wants to switch.
- **`<input type="file" capture>`, not `getUserMedia`.** [iOS PWA standalone-mode bug](https://bugs.webkit.org/show_bug.cgi?id=185448) means camera permission isn't persisted across sessions for installed PWAs. `<input type="file">` invokes the native camera app and avoids that path entirely. Loses live preview, but for snap-and-classify that's fine.
- **LLM judgment, not curated rule list.** Faster to ship, captures context (e.g. "organic cane sugar" vs. "high-fructose corn syrup"). Custom rubric textarea lets the user nudge it without maintaining a giant lookup table.
- **Vanilla HTML/JS, not React/Svelte.** Single page, no build step, deploys instantly. Tiny bundle. No framework to maintain.
- **andromeda + nginx, not Cloudflare Pages or GitHub Pages.** User already runs andromeda. One less place to manage.

## Useful references

- Original plan file (Claude planning artifact): `~/.claude/plans/i-d-like-to-make-replicated-haven.md`
- Gemini API: https://ai.google.dev/gemini-api/docs
- Gemini API key creation: https://aistudio.google.com/apikey
- iOS PWA camera bug context: https://bugs.webkit.org/show_bug.cgi?id=185448
- Open Food Facts (for v2 barcode lookup): https://world.openfoodfacts.org/data
