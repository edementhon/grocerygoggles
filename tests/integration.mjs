// Headless-browser integration test for Grocery Goggles.
//
//   cd tests && npm install && npx playwright install chromium && npm test
//
// Serves the app from a throwaway in-process static server, stubs the Gemini
// API, and drives the real UI: setup, capture -> render, XSS hardening,
// history, and both error paths. Exits non-zero on any failure.

import pw from "playwright";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = pw;
const ROOT = fileURLToPath(new URL("../", import.meta.url)); // repo root
const IMG = fileURLToPath(new URL("./fixtures/label.jpg", import.meta.url));

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".jpg": "image/jpeg",
};

// --- tiny static server (no external dep) -----------------------------------
const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    const fp = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ""));
    const data = await readFile(fp);
    res.writeHead(200, { "content-type": TYPES[extname(fp)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404); res.end("not found");
  }
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}`;

// --- assertions --------------------------------------------------------------
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log("PASS  " + msg); } else { fail++; console.log("FAIL  " + msg); } };

const successText = JSON.stringify({
  productGuess: "tortilla chips",
  ingredients: [
    { name: "Whole corn", verdict: "green", reason: "" },
    { name: "Vegetable oil", verdict: "yellow", reason: "Refined seed oil." },
    { name: "Yellow 5", verdict: "red", reason: "Artificial color." },
  ],
});
const successBody = JSON.stringify({ candidates: [{ content: { parts: [{ text: successText }] } }] });
const badKeyBody = JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT", message: "API key not valid. Please pass a valid API key." } });
const malformedBody = JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT", message: "Unknown name \"responseSchema\": Cannot find field." } });

let scenario = "success";
const route = (r) => {
  if (scenario === "badkey") return r.fulfill({ status: 400, contentType: "application/json", body: badKeyBody });
  if (scenario === "malformed") return r.fulfill({ status: 400, contentType: "application/json", body: malformedBody });
  return r.fulfill({ status: 200, contentType: "application/json", body: successBody });
};

const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  const page = await browser.newPage();
  await page.route("**generativelanguage.googleapis.com**", route);
  await page.goto(BASE, { waitUntil: "networkidle" });

  // 1. First run: setup card, no scan button
  ok(await page.locator("#setup-card").isVisible(), "setup card shown when no key");
  ok(!(await page.locator("#scan-btn").isVisible()), "scan button hidden during setup");

  // 2. Save key via real UI
  await page.fill("#setup-key", "TESTKEY123");
  await page.click("#setup-save");
  ok(!(await page.locator("#setup-card").isVisible()), "setup card hides after saving key");
  ok(await page.locator("#scan-btn").isVisible(), "scan button visible after setup");

  // 3. Happy path
  scenario = "success";
  await page.setInputFiles("#file-input", IMG);
  await page.waitForSelector("#ingredient-list li", { timeout: 15000 });
  const items = page.locator("#ingredient-list li");
  ok((await items.count()) === 3, "renders 3 ingredients");
  ok((await page.locator("#scan-meta").textContent()).trim() === "tortilla chips", "product guess shown in meta");
  ok(await items.nth(0).evaluate((el) => el.classList.contains("verdict-green")), "ingredient 0 is green");
  ok(await items.nth(1).evaluate((el) => el.classList.contains("verdict-yellow")), "ingredient 1 is yellow");
  ok(await items.nth(2).evaluate((el) => el.classList.contains("verdict-red")), "ingredient 2 is red");
  ok((await items.nth(0).locator(".ing-name").textContent()).trim() === "Whole corn", "ingredient 0 name correct");
  ok((await items.nth(0).locator(".ing-reason").count()) === 0, "green ingredient has no reason line");
  ok((await items.nth(2).locator(".ing-reason").textContent()).includes("Artificial color"), "red ingredient shows reason");

  // 4. XSS hardening: model output is text, never HTML
  const injection = JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
    productGuess: "x", ingredients: [{ name: "<img src=x onerror=window.__XSS=1>", verdict: "red", reason: "<b>x</b>" }],
  }) }] } }] });
  await page.unroute("**generativelanguage.googleapis.com**");
  await page.route("**generativelanguage.googleapis.com**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: injection }));
  await page.setInputFiles("#file-input", IMG);
  await page.waitForFunction(() => document.querySelectorAll("#ingredient-list li").length === 1, { timeout: 15000 });
  ok((await page.evaluate(() => window.__XSS)) === undefined, "injected onerror did NOT execute (no XSS)");
  ok((await page.locator("#ingredient-list .ing-name").textContent()).includes("<img"), "injected markup rendered as literal text");
  await page.unroute("**generativelanguage.googleapis.com**");
  await page.route("**generativelanguage.googleapis.com**", route);

  // 5. History
  await page.click("#tab-history");
  await page.waitForSelector(".history-card", { timeout: 5000 });
  ok((await page.locator(".history-card").count()) >= 2, "history has the scans");
  await page.locator(".history-card").first().click();
  await page.waitForSelector(".hc-detail li", { timeout: 5000 });
  ok((await page.locator(".hc-detail").first().locator("li").count()) >= 1, "history card expands to ingredient list");

  // 6. Bad key -> back to setup
  await page.click("#tab-scan");
  scenario = "badkey";
  await page.setInputFiles("#file-input", IMG);
  await page.waitForSelector("#setup-card:not(.hidden)", { timeout: 10000 }).catch(() => {});
  ok(await page.locator("#setup-card").isVisible(), "bad key bounces user back to setup card");

  // 7. Malformed 400 -> generic error, not a key prompt
  await page.fill("#setup-key", "TESTKEY123");
  await page.click("#setup-save");
  scenario = "malformed";
  await page.setInputFiles("#file-input", IMG);
  await page.waitForFunction(
    () => /something went wrong/i.test(document.querySelector("#scan-status")?.textContent || ""),
    { timeout: 10000 }
  );
  ok(!(await page.locator("#setup-card").isVisible()), "malformed 400 does NOT blame the key");
  ok((await page.locator("#scan-status").textContent()).toLowerCase().includes("something went wrong"), "malformed 400 shows generic error");
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
