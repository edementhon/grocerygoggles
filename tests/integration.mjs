// Headless-browser integration test for Grocery Goggles.
//   cd tests && npm install && npx playwright install chromium && npm test
//
// Serves the app from a throwaway static server, stubs the Gemini API, and
// drives the real UI: setup, multi-photo tray, single-product verdict, the
// one-call multi-product comparison, per-100g normalization, the Fast/Quality
// model toggle, XSS hardening, history, the Compare tab, and error paths.

import pw from "playwright";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = pw;
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const IMG = fileURLToPath(new URL("./fixtures/label.jpg", import.meta.url));
const TYPES = { ".html":"text/html",".js":"text/javascript",".css":"text/css",".json":"application/json",".webmanifest":"application/manifest+json",".png":"image/png",".jpg":"image/jpeg" };

const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split("?")[0]); if (p === "/") p = "/index.html";
    const fp = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ""));
    const data = await readFile(fp);
    res.writeHead(200, { "content-type": TYPES[extname(fp)] || "application/octet-stream" }); res.end(data);
  } catch { res.writeHead(404); res.end("not found"); }
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}`;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS  " + m); } else { fail++; console.log("FAIL  " + m); } };

const prodA = { productGuess: "cereal a", photoIndexes: [0],
  ingredients: [{ name: "Whole grain oats", verdict: "green", reason: "" }, { name: "Sugar", verdict: "yellow", reason: "Refined." }, { name: "Yellow 5", verdict: "red", reason: "Artificial color." }],
  nutrition: { servingAmount: 30, servingUnit: "g", servingHousehold: "1/2 cup", basisHint: "solid", perServing: { calories: 120, sugars_g: 12, protein_g: 3, fiber_g: 3, sodium_mg: 190 }, per100Label: null } };
const prodB = { productGuess: "cereal b", photoIndexes: [1],
  ingredients: [{ name: "Corn", verdict: "green", reason: "" }],
  nutrition: { servingAmount: 45, servingUnit: "g", servingHousehold: "1 cup", basisHint: "solid", perServing: { calories: 200, sugars_g: 9, protein_g: 6, fiber_g: 8, sodium_mg: 150 }, per100Label: null } };
const inject = { productGuess: "x", photoIndexes: [0], ingredients: [{ name: "<img src=x onerror=window.__XSS=1>", verdict: "red", reason: "<b>x</b>" }], nutrition: null };
const cmp = { summary: "Cereal B is the cleaner pick.", highlights: ["Cereal A has Yellow 5 (flagged); B has none.", "B has more fiber per 100 g."] };

const wrap = (o) => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(o) }] } }] });
const badKeyBody = JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT", message: "API key not valid." } });
const malformedBody = JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT", message: "Unknown name x." } });

let scenario = "single", lastUrl = "";
const route = (r) => {
  lastUrl = r.request().url();
  if (scenario === "badkey") return r.fulfill({ status: 400, contentType: "application/json", body: badKeyBody });
  if (scenario === "malformed") return r.fulfill({ status: 400, contentType: "application/json", body: malformedBody });
  const body = scenario === "multi" ? wrap({ products: [prodA, prodB], comparison: cmp })
    : scenario === "inject" ? wrap({ products: [inject], comparison: null })
    : wrap({ products: [prodA], comparison: null });
  return r.fulfill({ status: 200, contentType: "application/json", body });
};

async function addPhotos(page, n) {
  for (let i = 0; i < n; i++) {
    const c = await page.locator(".tray-thumb").count();
    await page.setInputFiles("#file-input", IMG);
    await page.waitForFunction((prev) => document.querySelectorAll(".tray-thumb").length > prev, c, { timeout: 10000 });
  }
}

const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  const page = await browser.newPage();
  await page.route("**generativelanguage.googleapis.com**", route);
  await page.goto(BASE, { waitUntil: "networkidle" });

  await page.fill("#setup-key", "TESTKEY"); await page.click("#setup-save");
  ok(await page.locator("#scan-btn").isVisible(), "scan button visible after setup");

  // --- Single product: verdict headline + nutrition + ingredients ---
  scenario = "single";
  await addPhotos(page, 1);
  await page.click("#analyze-btn");
  await page.waitForSelector("#result-body .nutri-table", { timeout: 15000 });
  ok((await page.locator("#result-body .meta").textContent()).trim() === "cereal a", "single: product name shown");
  ok((await page.locator("#result-body .verdict-headline").textContent()).includes("to avoid"), "single: headline summarizes flags");
  ok((await page.locator("#result-body .ingredient").count()) === 3, "single: 3 ingredients");
  ok((await page.locator("#result-body .nutri-table").textContent()).includes("400 kcal"), "single: calories normalized to 400/100g");
  ok(lastUrl.includes("gemini-2.5-flash"), "default model is fast (2.5-flash)");

  // --- Model toggle -> quality hits 3.5-flash ---
  await page.click("#open-settings");
  await page.locator(".seg-opt", { hasText: "Best quality" }).click();
  await page.click("#close-settings");
  await page.click("#new-scan");
  scenario = "single";
  await addPhotos(page, 1);
  await page.click("#analyze-btn");
  await page.waitForSelector("#result-body .nutri-table", { timeout: 15000 });
  ok(lastUrl.includes("gemini-3.5-flash"), "quality toggle switches model to 3.5-flash");
  await page.click("#open-settings"); await page.locator(".seg-opt", { hasText: "Fast" }).click(); await page.click("#close-settings");

  // --- Multi-product comparison from ONE analyze ---
  await page.click("#new-scan");
  scenario = "multi";
  await addPhotos(page, 2);
  await page.click("#analyze-btn");
  await page.waitForSelector("#result-body .cmp-table", { timeout: 15000 });
  ok((await page.locator("#result-body .cmp-verdict").textContent()).includes("cleaner"), "compare: verdict summary shown");
  ok((await page.locator("#result-body .cmp-table thead th").count()) === 3, "compare: label + 2 product columns");
  const calRow = page.locator("#result-body .cmp-table tbody tr").filter({ hasText: "Calories" }).first();
  const calText = await calRow.textContent();
  ok(calText.includes("400 kcal") && calText.includes("444 kcal"), "compare: both calorie values normalized");
  ok((await calRow.locator("td.cmp-better").textContent()).includes("400"), "compare: lower calories marked better");
  ok((await page.locator("#result-body .cmp-detail").count()) === 2, "compare: per-product detail sections");

  // --- XSS hardening + missing-nutrition nudge ---
  await page.click("#new-scan");
  scenario = "inject";
  await addPhotos(page, 1);
  await page.click("#analyze-btn");
  await page.waitForFunction(() => document.querySelectorAll("#result-body .ingredient").length === 1, { timeout: 15000 });
  ok((await page.evaluate(() => window.__XSS)) === undefined, "injected onerror did NOT execute (no XSS)");
  ok((await page.locator("#result-body .ing-name").textContent()).includes("<img"), "injected markup rendered as literal text");
  ok(!(await page.locator("#scan-note").isHidden()), "nudge shown when nutrition missing");

  // --- History ---
  await page.click("#tab-history");
  await page.waitForSelector(".history-card", { timeout: 5000 });
  ok((await page.locator(".history-card").count()) >= 4, "history lists products from all scans");
  const cb = page.locator(".history-card").filter({ hasText: "cereal b" }).first();
  await cb.click();
  await page.waitForSelector(".hc-detail .nutri-table", { timeout: 5000 });
  ok(true, "history detail includes the nutrition table");

  // --- Compare tab (across saved scans) ---
  await page.click("#tab-compare");
  await page.waitForSelector(".cmp-pick", { timeout: 5000 });
  ok((await page.locator(".cmp-pick").count()) >= 2, "compare picker lists saved products");
  const boxes = await page.locator(".cmp-pick input").all();
  await boxes[0].check(); await boxes[1].check();
  await page.waitForSelector("#compare-table-wrap .cmp-table", { timeout: 5000 });
  ok(true, "compare tab renders a table for 2 selected");

  // --- Error paths ---
  await page.click("#tab-scan"); await page.click("#new-scan");
  scenario = "badkey";
  await addPhotos(page, 1); await page.click("#analyze-btn");
  await page.waitForSelector("#setup-card:not(.hidden)", { timeout: 10000 }).catch(() => {});
  ok(await page.locator("#setup-card").isVisible(), "bad key bounces back to setup");

  await page.fill("#setup-key", "TESTKEY"); await page.click("#setup-save");
  scenario = "malformed";
  await addPhotos(page, 1); await page.click("#analyze-btn");
  await page.waitForFunction(() => /something went wrong/i.test(document.querySelector("#scan-status")?.textContent || ""), { timeout: 10000 });
  ok(!(await page.locator("#setup-card").isVisible()), "malformed 400 does NOT blame the key");
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
