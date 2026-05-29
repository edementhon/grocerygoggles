// Grocery Goggles - snap a burst of label photos, classify ingredients +
// nutrition for one or more products in ONE call, normalize to per-100g/ml,
// and show a single verdict or a side-by-side comparison.
import { addScan, updateScan, deleteScan, getAllScans, clearScans } from "./db.js";
import { NUTRIENTS, NUTRIENT_KEYS, normalizeNutrition, fmt, basisLabel } from "./nutrition.js";

// --- Config -----------------------------------------------------------------

// Two tiers behind the Settings "Speed vs quality" toggle. Both are switchable
// here; "fast" also disables model "thinking" to cut latency.
const MODELS = { fast: "gemini-2.5-flash", quality: "gemini-3.5-flash" };
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const MAX_DIM = 1280;
const THUMB_DIM = 256;
const JPEG_QUALITY = 0.85;

const LS_KEY = "gg_api_key";
const LS_PREFS = "gg_prefs";
const LS_MODEL = "gg_model"; // "fast" | "quality"

const BASE_PROMPT = `You are analyzing photos of packaged food. The photos may show ONE product or SEVERAL different products (e.g. two cereals the shopper is comparing). Group the photos by product and return one entry in "products" per distinct product. For each product, set "photoIndexes" to the 0-based indexes (in the order the photos were given) of the photos that show it.

For each product:
INGREDIENTS: Extract every ingredient in order. Assign a verdict:
- "red": best avoided (artificial colors, high-fructose corn syrup, BHA/BHT, partially hydrogenated oils, artificial sweeteners, nitrites, etc.)
- "yellow": fine in moderation (refined sugars, seed/vegetable oils, common preservatives, "natural flavors", maltodextrin, etc.)
- "green": whole foods, recognized nutrients, generally-safe additives.
Reason of 12 words or fewer for every red/yellow; empty ("") for green.
NUTRITION: If a Nutrition Facts panel is visible, fill "nutrition". Transcribe EXACTLY as printed; never compute. null for any nutrient not listed. servingAmount + servingUnit = serving size by weight ("g") or volume ("ml"); if only a household measure, leave servingAmount null. Household measure (e.g. "1/2 cup") in servingHousehold. basisHint "solid" or "liquid". If the label prints its own per-100 column, copy it into per100Label. If no panel is visible, nutrition = null.
"productGuess": 2-4 word description.

If there are 2+ products, fill "comparison": a one-sentence "summary" naming the better overall pick and why (weigh ingredient quality first, then nutrition), and 2-4 short "highlights" of the key differences (especially flagged additives one product has that another lacks). If only one product, comparison = null.
If you cannot read anything useful, return empty "products" and a short "error".`;

const nutrientProps = () => Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, { type: "number", nullable: true }]));
const nutritionSchema = {
  type: "object",
  nullable: true,
  properties: {
    servingAmount: { type: "number", nullable: true },
    servingUnit: { type: "string", nullable: true },
    servingHousehold: { type: "string" },
    basisHint: { type: "string", nullable: true },
    perServing: { type: "object", properties: nutrientProps(), propertyOrdering: NUTRIENT_KEYS },
    per100Label: { type: "object", nullable: true, properties: nutrientProps(), propertyOrdering: NUTRIENT_KEYS },
  },
  propertyOrdering: ["servingAmount", "servingUnit", "servingHousehold", "basisHint", "perServing", "per100Label"],
};
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    products: {
      type: "array",
      items: {
        type: "object",
        properties: {
          productGuess: { type: "string" },
          photoIndexes: { type: "array", items: { type: "number" } },
          ingredients: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                verdict: { type: "string", enum: ["red", "yellow", "green"] },
                reason: { type: "string" },
              },
              required: ["name", "verdict", "reason"],
              propertyOrdering: ["name", "verdict", "reason"],
            },
          },
          nutrition: nutritionSchema,
        },
        required: ["productGuess", "ingredients"],
        propertyOrdering: ["productGuess", "photoIndexes", "ingredients", "nutrition"],
      },
    },
    comparison: {
      type: "object",
      nullable: true,
      properties: { summary: { type: "string" }, highlights: { type: "array", items: { type: "string" } } },
      propertyOrdering: ["summary", "highlights"],
    },
    error: { type: "string" },
  },
  propertyOrdering: ["products", "comparison", "error"],
};

// --- DOM ---------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const els = {
  setupCard: $("setup-card"), setupKey: $("setup-key"), setupSave: $("setup-save"), setupError: $("setup-error"),

  scanView: $("scan-view"), scanBtn: $("scan-btn"), fileInput: $("file-input"),
  tray: $("tray"), trayThumbs: $("tray-thumbs"), addPhoto: $("add-photo"), analyzeBtn: $("analyze-btn"),
  scanResult: $("scan-result"), scanStatus: $("scan-status"), resultBody: $("result-body"),
  scanNote: $("scan-note"), newScan: $("new-scan"),

  historyView: $("history-view"), historyList: $("history-list"), historyEmpty: $("history-empty"),

  compareView: $("compare-view"), compareEmpty: $("compare-empty"), compareHint: $("compare-hint"),
  comparePicker: $("compare-picker"), compareTableWrap: $("compare-table-wrap"),

  tabScan: $("tab-scan"), tabHistory: $("tab-history"), tabCompare: $("tab-compare"),

  openSettings: $("open-settings"), closeSettings: $("close-settings"), drawer: $("settings-drawer"),
  backdrop: $("drawer-backdrop"), settingsKey: $("settings-key"), settingsPrefs: $("settings-prefs"), clearHistory: $("clear-history"),
};

// --- State -------------------------------------------------------------------

let photos = [];        // { base64, thumbBlob }
let currentScanIds = []; // db ids written by the last Analyze (replaced on re-analyze)
const compareSelected = new Set();

// --- Key / prefs / model -----------------------------------------------------

const getKey = () => localStorage.getItem(LS_KEY) || "";
const setKey = (k) => localStorage.setItem(LS_KEY, k.trim());
const getPrefs = () => localStorage.getItem(LS_PREFS) || "";
const setPrefs = (p) => localStorage.setItem(LS_PREFS, p);
const getModelMode = () => (localStorage.getItem(LS_MODEL) === "quality" ? "quality" : "fast");
const setModelMode = (m) => localStorage.setItem(LS_MODEL, m);

// --- Init --------------------------------------------------------------------

function init() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
  if (!getKey()) showSetup();

  els.setupSave.addEventListener("click", onSetupSave);
  els.scanBtn.addEventListener("click", () => els.fileInput.click());
  els.addPhoto.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", onFilePicked);
  els.analyzeBtn.addEventListener("click", onAnalyze);
  els.newScan.addEventListener("click", resetScan);

  els.tabScan.addEventListener("click", () => switchView("scan"));
  els.tabHistory.addEventListener("click", () => switchView("history"));
  els.tabCompare.addEventListener("click", () => switchView("compare"));

  els.openSettings.addEventListener("click", openDrawer);
  els.closeSettings.addEventListener("click", closeDrawer);
  els.backdrop.addEventListener("click", closeDrawer);
  els.settingsKey.addEventListener("change", () => { if (els.settingsKey.value.trim()) setKey(els.settingsKey.value); });
  els.settingsPrefs.addEventListener("blur", () => setPrefs(els.settingsPrefs.value));
  els.clearHistory.addEventListener("click", onClearHistory);
  for (const r of document.querySelectorAll('input[name="model"]')) {
    r.addEventListener("change", () => { if (r.checked) setModelMode(r.value); });
  }
}

function showSetup() {
  els.setupCard.classList.remove("hidden");
  els.scanBtn.classList.add("hidden");
}
function hideSetup() {
  els.setupCard.classList.add("hidden");
  if (!photos.length) els.scanBtn.classList.remove("hidden");
}
function onSetupSave() {
  const k = els.setupKey.value.trim();
  if (!k) { els.setupError.textContent = "Paste a key first."; els.setupError.classList.remove("hidden"); return; }
  setKey(k);
  els.setupError.classList.add("hidden");
  hideSetup();
}

// --- Views + drawer ----------------------------------------------------------

function switchView(name) {
  for (const v of ["scan", "history", "compare"]) els[v + "View"].classList.toggle("hidden", v !== name);
  els.tabScan.classList.toggle("active", name === "scan");
  els.tabHistory.classList.toggle("active", name === "history");
  els.tabCompare.classList.toggle("active", name === "compare");
  if (name === "history") renderHistory();
  if (name === "compare") renderCompare();
}

function openDrawer() {
  els.settingsKey.value = getKey();
  els.settingsPrefs.value = getPrefs();
  const mode = getModelMode();
  for (const r of document.querySelectorAll('input[name="model"]')) r.checked = r.value === mode;
  els.drawer.classList.remove("hidden");
  els.backdrop.classList.remove("hidden");
}
function closeDrawer() {
  setPrefs(els.settingsPrefs.value);
  if (els.settingsKey.value.trim()) setKey(els.settingsKey.value);
  els.drawer.classList.add("hidden");
  els.backdrop.classList.add("hidden");
  if (!getKey()) showSetup();
}

async function onClearHistory() {
  await clearScans();
  compareSelected.clear();
  currentScanIds = [];
  renderHistory();
}

// --- Capture tray ------------------------------------------------------------

async function onFilePicked(e) {
  const file = e.target.files && e.target.files[0];
  els.fileInput.value = "";
  if (!file) return;
  if (!getKey()) { showSetup(); return; }
  let img;
  try { img = await loadOriented(file); }
  catch { setStatus("Couldn't open that image. Try again.", true); return; }
  const base64 = drawScaled(img, MAX_DIM).toDataURL("image/jpeg", JPEG_QUALITY).split(",")[1];
  const thumbBlob = await canvasToBlob(drawScaled(img, THUMB_DIM));
  photos.push({ base64, thumbBlob });
  renderTray();
}

function renderTray() {
  els.scanBtn.classList.toggle("hidden", photos.length > 0 || !getKey());
  els.tray.classList.toggle("hidden", photos.length === 0);
  els.analyzeBtn.disabled = photos.length === 0;
  els.analyzeBtn.textContent = photos.length > 1 ? `Analyze ${photos.length} photos` : "Analyze";
  els.trayThumbs.replaceChildren();
  photos.forEach((p, i) => {
    const cell = document.createElement("div");
    cell.className = "tray-thumb";
    const img = document.createElement("img");
    img.alt = "";
    img.src = URL.createObjectURL(p.thumbBlob);
    const rm = document.createElement("button");
    rm.className = "tray-remove";
    rm.setAttribute("aria-label", "Remove photo");
    rm.textContent = "×";
    rm.addEventListener("click", () => { photos.splice(i, 1); if (!photos.length) resetScan(); else renderTray(); });
    cell.append(img, rm);
    els.trayThumbs.appendChild(cell);
  });
}

function resetScan() {
  photos = [];
  currentScanIds = [];
  els.scanResult.classList.add("hidden");
  els.scanNote.classList.add("hidden");
  els.resultBody.replaceChildren();
  clearStatus();
  renderTray(); // clears tray thumbs, hides tray, restores the scan button
}

async function onAnalyze() {
  if (!photos.length) return;
  if (!getKey()) { showSetup(); return; }

  els.scanResult.classList.remove("hidden");
  els.resultBody.replaceChildren();
  els.scanNote.classList.add("hidden");
  setStatus("Reading label...", false, true);

  try {
    const result = await classify(photos.map((p) => p.base64));
    const products = (result.products || []).filter((p) => (p.ingredients && p.ingredients.length) || p.nutrition);
    if (!products.length) {
      setStatus(result.error || "Couldn't read the label. Try better lighting or get closer.", true);
      return;
    }
    clearStatus();
    if (products.length === 1) renderSingle(els.resultBody, products[0]);
    else renderComparison(els.resultBody, products, result.comparison);
    showNudge(products);
    await saveBatch(products);
  } catch (err) {
    handleApiError(err);
  }
}

function showNudge(products) {
  let note = "";
  if (products.length === 1) {
    const p = products[0];
    if (p.ingredients.length && !p.nutrition) note = "No Nutrition Facts found. Add a photo of the nutrition panel, then Analyze again.";
    else if (!p.ingredients.length && p.nutrition) note = "No ingredients list found. Add a photo of the ingredients, then Analyze again.";
  }
  els.scanNote.textContent = note;
  els.scanNote.classList.toggle("hidden", !note);
}

async function saveBatch(products) {
  for (const id of currentScanIds) await deleteScan(id);
  currentScanIds = [];
  for (const p of products) {
    const idxs = Array.isArray(p.photoIndexes) ? p.photoIndexes : [];
    let thumbs = idxs.map((i) => photos[i]?.thumbBlob).filter(Boolean);
    if (!thumbs.length) thumbs = photos.map((ph) => ph.thumbBlob);
    currentScanIds.push(await addScan({
      timestamp: Date.now(),
      productGuess: p.productGuess || "Scan",
      thumbnails: thumbs,
      ingredients: p.ingredients,
      nutrition: p.nutrition,
    }));
  }
}

function setStatus(msg, isError = false, spinner = false) {
  els.scanStatus.className = "status" + (isError ? " status-error" : "");
  els.scanStatus.replaceChildren();
  if (spinner) { const s = document.createElement("span"); s.className = "spinner"; els.scanStatus.appendChild(s); }
  const text = document.createElement("span");
  text.textContent = msg;
  els.scanStatus.appendChild(text);
}
function clearStatus() { els.scanStatus.replaceChildren(); els.scanStatus.className = ""; }

// --- Image helpers -----------------------------------------------------------

async function loadOriented(file) {
  if ("createImageBitmap" in window) {
    try { return await createImageBitmap(file, { imageOrientation: "from-image" }); }
    catch { /* fall through */ }
  }
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => { URL.revokeObjectURL(url); resolve(im); };
    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode")); };
    im.src = url;
  });
}
function drawScaled(img, maxDim) {
  const w = img.width, h = img.height;
  const scale = Math.min(1, maxDim / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}
function canvasToBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", 0.7));
}

// --- Gemini call -------------------------------------------------------------

async function classify(base64Images) {
  const prefs = getPrefs().trim();
  const prompt = prefs
    ? `${BASE_PROMPT}\n\nAdditional user preferences (these override the defaults above):\n${prefs}`
    : BASE_PROMPT;
  const mode = getModelMode();
  const model = MODELS[mode];

  const parts = [{ text: prompt }];
  for (const b64 of base64Images) parts.push({ inlineData: { mimeType: "image/jpeg", data: b64 } });

  const generationConfig = {
    responseMimeType: "application/json",
    responseSchema: RESPONSE_SCHEMA,
    temperature: 0.2,
    maxOutputTokens: 8192,
  };
  if (mode === "fast") generationConfig.thinkingConfig = { thinkingBudget: 0 }; // 2.5-flash: skip thinking for speed

  let res;
  try {
    res = await fetch(`${API_BASE}/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": getKey() },
      body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig }),
    });
  } catch { throw { kind: "network" }; }

  if (!res.ok) {
    if (res.status === 429) throw { kind: "rate" };
    const errBody = await res.json().catch(() => null);
    const detail = (errBody?.error?.status || "") + " " + (errBody?.error?.message || "");
    if (res.status === 401 || res.status === 403 || /API.?key|API_KEY_INVALID|PERMISSION_DENIED|UNAUTHENTICATED/i.test(detail)) throw { kind: "key" };
    throw { kind: "http", status: res.status, detail: detail.trim() };
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  if (!text) return { products: [], comparison: null, error: "The model returned nothing. Try again." };

  let parsed;
  try { parsed = JSON.parse(text); }
  catch { return { products: [], comparison: null, error: "Couldn't read the label. Try better lighting or get closer." }; }

  const products = (Array.isArray(parsed.products) ? parsed.products : []).map((p) => ({
    productGuess: p.productGuess || "",
    photoIndexes: Array.isArray(p.photoIndexes) ? p.photoIndexes : [],
    ingredients: Array.isArray(p.ingredients) ? p.ingredients.filter((i) => i && i.name) : [],
    nutrition: normalizeNutrition(p.nutrition),
  }));
  return { products, comparison: parsed.comparison || null, error: parsed.error || "" };
}

function handleApiError(err) {
  const kind = err && err.kind;
  if (kind === "key") { setStatus("That API key was rejected. Re-enter it below.", true); showSetup(); switchView("scan"); }
  else if (kind === "rate") setStatus("Slow down. The Gemini free tier is rate-limited; wait a minute and retry.", true);
  else if (kind === "network") setStatus("No connection. Check your network and try again.", true);
  else { if (err && err.detail) console.error("Gemini API error:", err.status, err.detail); setStatus("Something went wrong reading the label. Try again.", true); }
}

// --- Rendering (all model output via textContent; never innerHTML) ----------

function counts(ingredients) {
  const c = { red: 0, yellow: 0, green: 0 };
  for (const i of ingredients || []) if (c[i.verdict] != null) c[i.verdict]++;
  return c;
}

function renderSingle(container, p) {
  container.replaceChildren();
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = p.productGuess || "Scan";
  container.appendChild(meta);

  const c = counts(p.ingredients);
  const head = document.createElement("div");
  const tone = c.red ? "bad" : c.yellow ? "warn" : "clean";
  head.className = `verdict-headline vh-${tone}`;
  head.textContent = c.red || c.yellow
    ? [c.red && `${c.red} to avoid`, c.yellow && `${c.yellow} in moderation`].filter(Boolean).join(" · ")
    : "Looks clean ✓";
  container.appendChild(head);

  const nb = document.createElement("div");
  renderNutrition(nb, p.nutrition);
  container.appendChild(nb);

  const list = document.createElement("ul");
  list.className = "plain-list";
  renderIngredientList(list, p.ingredients);
  container.appendChild(list);
}

function renderComparison(container, products, comparison) {
  container.replaceChildren();

  if (comparison?.summary) {
    const v = document.createElement("div");
    v.className = "cmp-verdict";
    v.textContent = comparison.summary;
    container.appendChild(v);
  }
  if (Array.isArray(comparison?.highlights) && comparison.highlights.length) {
    const ul = document.createElement("ul");
    ul.className = "cmp-highlights";
    for (const h of comparison.highlights) {
      const li = document.createElement("li");
      li.textContent = h;
      ul.appendChild(li);
    }
    container.appendChild(ul);
  }

  renderComparisonTable(container, products.map((p) => ({
    label: p.productGuess || "Scan", basis: p.nutrition?.basis, per100: p.nutrition?.per100 || null, ingredients: p.ingredients,
  })));

  // Per-product detail (collapsed) so the comparison stays scannable.
  for (const p of products) {
    const d = document.createElement("details");
    d.className = "cmp-detail";
    const s = document.createElement("summary");
    s.textContent = p.productGuess || "Scan";
    d.appendChild(s);
    const nb = document.createElement("div");
    renderNutrition(nb, p.nutrition);
    const list = document.createElement("ul");
    list.className = "plain-list";
    renderIngredientList(list, p.ingredients);
    d.append(nb, list);
    container.appendChild(d);
  }
}

function renderIngredientList(listEl, ingredients) {
  listEl.replaceChildren();
  for (const ing of ingredients || []) {
    const verdict = ["red", "yellow", "green"].includes(ing.verdict) ? ing.verdict : "yellow";
    const li = document.createElement("li");
    li.className = `ingredient verdict-${verdict}`;
    const dot = document.createElement("span");
    dot.className = "dot";
    const text = document.createElement("div");
    text.className = "ing-text";
    const name = document.createElement("div");
    name.className = "ing-name";
    name.textContent = ing.name;
    text.appendChild(name);
    if (ing.reason) {
      const reason = document.createElement("div");
      reason.className = "ing-reason";
      reason.textContent = ing.reason;
      text.appendChild(reason);
    }
    li.append(dot, text);
    listEl.appendChild(li);
  }
}

function renderNutrition(container, n) {
  container.replaceChildren();
  if (!n) return;
  const wrap = document.createElement("div");
  wrap.className = "nutrition";
  const head = document.createElement("div");
  head.className = "nutri-head";
  head.textContent = "Nutrition";
  wrap.appendChild(head);
  if (n.serving && (n.serving.household || n.serving.amount)) {
    const s = document.createElement("div");
    s.className = "nutri-serving";
    const amt = n.serving.amount ? `${n.serving.amount} ${n.serving.unit || ""}`.trim() : "";
    s.textContent = "Serving: " + [n.serving.household, amt && `(${amt})`].filter(Boolean).join(" ");
    wrap.appendChild(s);
  }
  const showPer100 = !!n.per100;
  const table = document.createElement("table");
  table.className = "nutri-table";
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  hr.appendChild(document.createElement("th"));
  const cPer = document.createElement("th"); cPer.textContent = "Per serving"; hr.appendChild(cPer);
  if (showPer100) { const c100 = document.createElement("th"); c100.textContent = basisLabel(n.basis); hr.appendChild(c100); }
  thead.appendChild(hr); table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const meta of NUTRIENTS) {
    const ps = n.perServing ? n.perServing[meta.key] : null;
    const p1 = n.per100 ? n.per100[meta.key] : null;
    if (ps == null && p1 == null) continue;
    const tr = document.createElement("tr");
    if (meta.sub) tr.className = "sub";
    const th = document.createElement("th"); th.scope = "row"; th.textContent = meta.label;
    const td1 = document.createElement("td"); td1.textContent = fmt(meta.key, ps);
    tr.append(th, td1);
    if (showPer100) { const td2 = document.createElement("td"); td2.textContent = fmt(meta.key, p1); tr.appendChild(td2); }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody); wrap.appendChild(table);
  if (n.note) { const note = document.createElement("div"); note.className = "nutri-note"; note.textContent = n.note; wrap.appendChild(note); }
  container.appendChild(wrap);
}

// Shared comparison table. items: [{ label, basis, per100, ingredients }]
function renderComparisonTable(container, items) {
  const bases = new Set(items.map((i) => i.basis).filter(Boolean));
  if (bases.size > 1) {
    const warn = document.createElement("div");
    warn.className = "nutri-note";
    warn.textContent = "Heads up: mixing per-100 g and per-100 ml products, which aren't directly comparable.";
    container.appendChild(warn);
  }

  const table = document.createElement("table");
  table.className = "cmp-table";
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  hr.appendChild(document.createElement("th"));
  for (const it of items) {
    const th = document.createElement("th");
    const name = document.createElement("div"); name.textContent = it.label;
    th.appendChild(name);
    if (it.basis) { const b = document.createElement("div"); b.className = "cmp-basis"; b.textContent = basisLabel(it.basis); th.appendChild(b); }
    hr.appendChild(th);
  }
  thead.appendChild(hr); table.appendChild(thead);

  const tbody = document.createElement("tbody");

  // Flagged-additives row (fewer red, then fewer yellow, is better).
  const flagScores = items.map((it) => { const c = counts(it.ingredients); return c.red * 100 + c.yellow; });
  const haveFlags = items.some((it) => (it.ingredients || []).length);
  if (haveFlags) {
    const tr = document.createElement("tr");
    const th = document.createElement("th"); th.scope = "row"; th.textContent = "Flagged";
    tr.appendChild(th);
    const min = Math.min(...flagScores), max = Math.max(...flagScores);
    items.forEach((it, i) => {
      const c = counts(it.ingredients);
      const td = document.createElement("td");
      td.textContent = `${c.red}🔴 ${c.yellow}🟡`;
      if (min !== max && flagScores[i] === min) td.classList.add("cmp-better");
      else if (min !== max && flagScores[i] === max) td.classList.add("cmp-worse");
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }

  // Nutrition rows, per 100, with better/worse coloring.
  for (const meta of NUTRIENTS) {
    const vals = items.map((it) => (it.per100 ? it.per100[meta.key] : null));
    if (vals.every((v) => v == null)) continue;
    const present = vals.filter((v) => v != null);
    let best = null, worst = null;
    if (meta.better && present.length >= 2) {
      const min = Math.min(...present), max = Math.max(...present);
      if (min !== max) { best = meta.better === "low" ? min : max; worst = meta.better === "low" ? max : min; }
    }
    const tr = document.createElement("tr");
    if (meta.sub) tr.className = "sub";
    const th = document.createElement("th"); th.scope = "row"; th.textContent = meta.label;
    tr.appendChild(th);
    for (const v of vals) {
      const td = document.createElement("td");
      td.textContent = fmt(meta.key, v);
      if (best != null && v === best) td.classList.add("cmp-better");
      else if (worst != null && v === worst) td.classList.add("cmp-worse");
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

// --- History -----------------------------------------------------------------

const primaryThumb = (scan) => (scan.thumbnails && scan.thumbnails[0]) || scan.thumbnail || null;

async function renderHistory() {
  const scans = await getAllScans();
  els.historyList.replaceChildren();
  els.historyEmpty.classList.toggle("hidden", scans.length > 0);

  for (const scan of scans) {
    const card = document.createElement("div");
    const button = document.createElement("button");
    button.className = "history-card";
    const thumb = document.createElement("img");
    thumb.className = "hc-thumb"; thumb.alt = "";
    const t = primaryThumb(scan);
    if (t) thumb.src = URL.createObjectURL(t);
    const bodyEl = document.createElement("div");
    bodyEl.className = "hc-body";
    const title = document.createElement("div"); title.className = "hc-title"; title.textContent = scan.productGuess || "Scan";
    const time = document.createElement("div"); time.className = "hc-time"; time.textContent = relativeTime(scan.timestamp);
    const tally = document.createElement("div"); tally.className = "hc-tally"; appendTally(tally, scan.ingredients);
    const cal = scan.nutrition?.per100?.calories;
    if (cal != null) { const stat = document.createElement("span"); stat.className = "chip chip-stat"; stat.textContent = `${cal} kcal/${scan.nutrition.basis === "100ml" ? "100ml" : "100g"}`; tally.appendChild(stat); }
    bodyEl.append(title, time, tally);
    button.append(thumb, bodyEl);
    const detail = document.createElement("div");
    detail.className = "hc-detail hidden";
    button.addEventListener("click", () => {
      if (detail.dataset.built !== "1") {
        const nb = document.createElement("div"); renderNutrition(nb, scan.nutrition);
        const list = document.createElement("ul"); list.className = "plain-list"; renderIngredientList(list, scan.ingredients);
        detail.append(nb, list); detail.dataset.built = "1";
      }
      detail.classList.toggle("hidden");
    });
    card.append(button, detail);
    els.historyList.appendChild(card);
  }
}

function appendTally(el, ingredients) {
  const c = counts(ingredients);
  const make = (cls, dot, n) => { const s = document.createElement("span"); s.className = `chip chip-${cls}`; s.textContent = `${dot} ${n}`; return s; };
  el.append(make("red", "🔴", c.red), make("yellow", "🟡", c.yellow), make("green", "🟢", c.green));
}

function relativeTime(ts) {
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day} day${day > 1 ? "s" : ""} ago`;
  return new Date(ts).toLocaleDateString();
}

// --- Compare tab (across saved scans) ---------------------------------------

async function renderCompare() {
  const comparable = (await getAllScans()).filter((s) => (s.ingredients && s.ingredients.length) || s.nutrition?.per100);
  const enough = comparable.length >= 2;
  els.compareEmpty.classList.toggle("hidden", enough);
  els.compareHint.classList.toggle("hidden", !enough);

  const ids = new Set(comparable.map((s) => s.id));
  for (const id of [...compareSelected]) if (!ids.has(id)) compareSelected.delete(id);

  els.comparePicker.replaceChildren();
  if (enough) {
    for (const scan of comparable) {
      const row = document.createElement("label");
      row.className = "cmp-pick";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = compareSelected.has(scan.id);
      cb.addEventListener("change", () => { cb.checked ? compareSelected.add(scan.id) : compareSelected.delete(scan.id); drawCompareTable(comparable); });
      const t = primaryThumb(scan);
      const img = document.createElement("img"); img.className = "cmp-thumb"; img.alt = ""; if (t) img.src = URL.createObjectURL(t);
      const label = document.createElement("span"); label.className = "cmp-label";
      const cal = scan.nutrition?.per100?.calories;
      label.textContent = scan.productGuess || "Scan" + (cal != null ? ` (${cal} kcal/100g)` : "");
      row.append(cb, img, label);
      els.comparePicker.appendChild(row);
    }
  }
  drawCompareTable(comparable);
}

function drawCompareTable(comparable) {
  els.compareTableWrap.replaceChildren();
  const selected = comparable.filter((s) => compareSelected.has(s.id));
  if (selected.length < 2) return;
  renderComparisonTable(els.compareTableWrap, selected.map((s) => ({
    label: s.productGuess || "Scan", basis: s.nutrition?.basis, per100: s.nutrition?.per100 || null, ingredients: s.ingredients || [],
  })));
}

init();
