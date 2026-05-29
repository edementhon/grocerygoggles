// Headless-browser integration test for Grocery Goggles.
//
//   cd tests && npm install && npx playwright install chromium && npm test
//
// Serves the app from a throwaway in-process static server, stubs the Gemini
// API, and drives the real UI: setup, multi-photo capture tray, ingredient +
// nutrition rendering, per-100g normalization, XSS hardening, history, the
// compare view, and both error paths. Exits non-zero on any failure.

import pw from "playwright";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = pw;
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const IMG = fileURLToPath(new URL("./fixtures/label.jpg", import.meta.url));

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".jpg": "image/jpeg",
};

const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    const fp = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ""));
    const data = await readFile(fp);
    res.writeHead(200, { "content-type": TYPES[extname(fp)] || "application/octet-stream" });
    res.end(data);
  } catch { res.writeHead(404); res.end("not found"); }
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}`;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log("PASS  " + msg); } else { fail++; console.log("FAIL  " + msg); } };

// Products the stub will "read" from photos.
const prodA = {
  productGuess: "cereal a",
  ingredients: [
    { name: "Whole grain oats", verdict: "green", reason: "" },
    { name: "Sugar", verdict: "yellow", reason: "Refined sugar." },
    { name: "Yellow 5", verdict: "red", reason: "Artificial color." },
  ],
  nutrition: { servingAmount: 30, servingUnit: "g", servingHousehold: "1/2 cup", basisHint: "solid",
    perServing: { calories: 120, fat_g: 1.5, sugars_g: 12, protein_g: 3, fiber_g: 3, sodium_mg: 190 }, per100Label: null },
};
const prodB = {
  productGuess: "cereal b",
  ingredients: [{ name: "Corn", verdict: "green", reason: "" }],
  nutrition: { servingAmount: 45, servingUnit: "g", servingHousehold: "1 cup", basisHint: "solid",
    perServing: { calories: 200, fat_g: 2, sugars_g: 9, protein_g: 6, fiber_g: 2, sodium_mg: 150 }, per100Label: null },
};
const inject = {
  productGuess: "x",
  ingredients: [{ name: "<img src=x onerror=window.__XSS=1>", verdict: "red", reason: "<b>x</b>" }],
  nutrition: null,
};
const wrap = (obj) => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] });
const badKeyBody = JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT", message: "API key not valid." } });
const malformedBody = JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT", message: "Unknown name \"x\"." } });

let scenario = "prodA";
const route = (r) => {
  if (scenario === "badkey") return r.fulfill({ status: 400, contentType: "application/json", body: badKeyBody });
  if (scenario === "malformed") return r.fulfill({ status: 400, contentType: "application/json", body: malformedBody });
  const obj = scenario === "prodB" ? prodB : scenario === "inject" ? inject : prodA;
  return r.fulfill({ status: 200, contentType: "application/json", body: wrap(obj) });
};

const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  const page = await browser.newPage();
  await page.route("**generativelanguage.googleapis.com**", route);
  await page.goto(BASE, { waitUntil: "networkidle" });

  // Save key
  ok(await page.locator("#setup-card").isVisible(), "setup card shown when no key");
  await page.fill("#setup-key", "TESTKEY");
  await page.click("#setup-save");
  ok(await page.locator("#scan-btn").isVisible(), "scan button visible after setup");

  // --- Capture tray: add two photos, check label, remove one ---
  scenario = "prodA";
  const thumbCount = (n) => page.waitForFunction((c) => document.querySelectorAll(".tray-thumb").length === c, n, { timeout: 10000 });
  await page.setInputFiles("#file-input", IMG);
  await thumbCount(1);
  await page.setInputFiles("#file-input", IMG);
  await thumbCount(2);
  ok((await page.locator(".tray-thumb").count()) === 2, "tray holds two photos");
  ok((await page.locator("#analyze-btn").textContent()).includes("2 photos"), "analyze button counts photos");
  await page.locator(".tray-remove").first().click();
  await thumbCount(1);
  ok((await page.locator(".tray-thumb").count()) === 1, "removing a photo updates the tray");

  // --- Analyze -> ingredients + nutrition ---
  await page.click("#analyze-btn");
  await page.waitForSelector("#ingredient-list li", { timeout: 15000 });
  ok((await page.locator("#ingredient-list li").count()) === 3, "renders 3 ingredients");
  ok((await page.locator("#scan-meta").textContent()).trim() === "cereal a", "product guess shown");
  await page.waitForSelector("#nutrition-block .nutri-table", { timeout: 5000 });
  // per-100g column header + computed values (120 kcal / 30g -> 400; 12g sugar -> 40g)
  ok((await page.locator("#nutrition-block thead").textContent()).includes("per 100 g"), "nutrition shows per-100g column");
  const nutText = await page.locator("#nutrition-block .nutri-table").textContent();
  ok(nutText.includes("400 kcal"), "calories normalized to 400 kcal/100g");
  ok(nutText.includes("40 g"), "sugar normalized to 40 g/100g");

  // --- XSS hardening ---
  await page.click("#new-scan");
  scenario = "inject";
  await page.setInputFiles("#file-input", IMG);
  await page.click("#analyze-btn");
  await page.waitForFunction(() => document.querySelectorAll("#ingredient-list li").length === 1, { timeout: 15000 });
  ok((await page.evaluate(() => window.__XSS)) === undefined, "injected onerror did NOT execute (no XSS)");
  ok((await page.locator("#ingredient-list .ing-name").textContent()).includes("<img"), "injected markup rendered as literal text");
  ok(!(await page.locator("#scan-note").isHidden()) , "nudge shown when nutrition missing");

  // --- Second product (for compare) ---
  await page.click("#new-scan");
  scenario = "prodB";
  await page.setInputFiles("#file-input", IMG);
  await page.click("#analyze-btn");
  await page.waitForFunction(() => /cereal b/.test(document.querySelector("#scan-meta")?.textContent || ""), { timeout: 15000 });

  // --- History: cards + nutrition in detail ---
  await page.click("#tab-history");
  await page.waitForSelector(".history-card", { timeout: 5000 });
  ok((await page.locator(".history-card").count()) >= 3, "history lists all scans");
  ok((await page.locator(".hc-tally").first().textContent()).includes("kcal/100g"), "history card shows kcal/100g stat");
  await page.locator(".history-card").first().click();
  await page.waitForSelector(".hc-detail .nutri-table", { timeout: 5000 });
  ok(true, "history detail includes the nutrition table");

  // --- Compare: select both cereals, check normalized table + better/worse coloring ---
  await page.click("#tab-compare");
  await page.waitForSelector(".cmp-pick", { timeout: 5000 });
  ok((await page.locator(".cmp-pick").count()) === 2, "compare picker lists the 2 products with nutrition");
  for (const cb of await page.locator(".cmp-pick input").all()) await cb.check();
  await page.waitForSelector(".cmp-table", { timeout: 5000 });
  const headerCols = await page.locator(".cmp-table thead th").count();
  ok(headerCols === 3, "compare table has a label column + 2 product columns");
  // Calories row: A=400 (lower=better), B=444 (worse)
  const calRow = page.locator(".cmp-table tbody tr").filter({ hasText: "Calories" }).first();
  const calText = await calRow.textContent();
  ok(calText.includes("400 kcal") && calText.includes("444 kcal"), "compare shows both normalized calorie values");
  ok((await calRow.locator("td.cmp-better").textContent()).includes("400"), "lower calories marked better");
  ok((await calRow.locator("td.cmp-worse").textContent()).includes("444"), "higher calories marked worse");

  // --- Error paths ---
  await page.click("#tab-scan");
  await page.click("#new-scan");
  scenario = "badkey";
  await page.setInputFiles("#file-input", IMG);
  await page.click("#analyze-btn");
  await page.waitForSelector("#setup-card:not(.hidden)", { timeout: 10000 }).catch(() => {});
  ok(await page.locator("#setup-card").isVisible(), "bad key bounces back to setup");

  await page.fill("#setup-key", "TESTKEY");
  await page.click("#setup-save");
  scenario = "malformed";
  await page.setInputFiles("#file-input", IMG);
  await page.click("#analyze-btn");
  await page.waitForFunction(() => /something went wrong/i.test(document.querySelector("#scan-status")?.textContent || ""), { timeout: 10000 });
  ok(!(await page.locator("#setup-card").isVisible()), "malformed 400 does NOT blame the key");
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
