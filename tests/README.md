# Tests

A single headless-Chromium integration test that drives the real app with a
stubbed Gemini API. It covers the setup flow, capture → render (with correct
red/yellow/green classes), XSS hardening (model output must never execute as
HTML), scan history, and both API error paths.

The app itself has **no build step and no dependencies**; this folder is the
only place Node tooling lives.

## Run

```bash
cd tests
npm install
npx playwright install chromium   # one-time: download the browser
npm test
```

Expected tail:

```
ALL PASS: 19 passed, 0 failed
```

The test starts its own throwaway static server and picks a free port, so
nothing else needs to be running.
