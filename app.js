// Grocery Goggles - capture a label, classify ingredients, render + remember.
import { addScan, getAllScans, clearScans } from "./db.js";

// --- Config -----------------------------------------------------------------

// Model is a single switchable constant. Cheaper/faster: "gemini-2.5-flash" or
// "gemini-2.5-flash-lite". Newest/best vision (default): "gemini-3.5-flash".
// Any multimodal Gemini model that supports JSON output works here.
const MODEL = "gemini-3.5-flash";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const MAX_DIM = 1280;   // longest edge sent to the model; bigger == better OCR, larger payload
const THUMB_DIM = 256;  // history thumbnail longest edge
const JPEG_QUALITY = 0.85;

const LS_KEY = "gg_api_key";
const LS_PREFS = "gg_prefs";

// The default rubric is an opinionated heuristic, not settled nutrition science.
// Users override it via the "Personal preferences" box in Settings.
const BASE_PROMPT = `You are reading a photo of a packaged-food ingredient label.
Extract every ingredient in the order listed. For each, assign a verdict:
- "red": best avoided (artificial colors, high-fructose corn syrup, BHA/BHT, partially hydrogenated oils, artificial sweeteners, nitrites, etc.)
- "yellow": fine in moderation (refined sugars, seed/vegetable oils, common preservatives, "natural flavors", maltodextrin, etc.)
- "green": whole foods, recognized nutrients, and generally-safe additives.
Give a reason of 12 words or fewer for every red and yellow verdict; leave reason empty ("") for green.
Also return "productGuess": a 2-4 word description of what the product appears to be.
If you cannot read any ingredients, return an empty "ingredients" array and set "error" to a short explanation.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    productGuess: { type: "string" },
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
    error: { type: "string" },
  },
  propertyOrdering: ["productGuess", "ingredients", "error"],
};

// --- DOM ---------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const els = {
  setupCard: $("setup-card"),
  setupKey: $("setup-key"),
  setupSave: $("setup-save"),
  setupError: $("setup-error"),

  scanView: $("scan-view"),
  scanBtn: $("scan-btn"),
  fileInput: $("file-input"),
  scanResult: $("scan-result"),
  scanPhoto: $("scan-photo"),
  scanStatus: $("scan-status"),
  scanMeta: $("scan-meta"),
  ingredientList: $("ingredient-list"),

  historyView: $("history-view"),
  historyList: $("history-list"),
  historyEmpty: $("history-empty"),

  tabScan: $("tab-scan"),
  tabHistory: $("tab-history"),

  openSettings: $("open-settings"),
  closeSettings: $("close-settings"),
  drawer: $("settings-drawer"),
  backdrop: $("drawer-backdrop"),
  settingsKey: $("settings-key"),
  settingsPrefs: $("settings-prefs"),
  clearHistory: $("clear-history"),
};

// --- Key + prefs -------------------------------------------------------------

const getKey = () => localStorage.getItem(LS_KEY) || "";
const setKey = (k) => localStorage.setItem(LS_KEY, k.trim());
const getPrefs = () => localStorage.getItem(LS_PREFS) || "";
const setPrefs = (p) => localStorage.setItem(LS_PREFS, p);

// --- Init --------------------------------------------------------------------

function init() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }

  if (!getKey()) showSetup();

  els.setupSave.addEventListener("click", onSetupSave);
  els.scanBtn.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", onFilePicked);

  els.tabScan.addEventListener("click", () => switchView("scan"));
  els.tabHistory.addEventListener("click", () => switchView("history"));

  els.openSettings.addEventListener("click", openDrawer);
  els.closeSettings.addEventListener("click", closeDrawer);
  els.backdrop.addEventListener("click", closeDrawer);
  els.settingsKey.addEventListener("change", () => {
    if (els.settingsKey.value.trim()) setKey(els.settingsKey.value);
  });
  els.settingsPrefs.addEventListener("blur", () => setPrefs(els.settingsPrefs.value));
  els.clearHistory.addEventListener("click", onClearHistory);
}

function showSetup() {
  els.setupCard.classList.remove("hidden");
  els.scanView.querySelector("#scan-btn").classList.add("hidden");
}
function hideSetup() {
  els.setupCard.classList.add("hidden");
  els.scanView.querySelector("#scan-btn").classList.remove("hidden");
}

function onSetupSave() {
  const k = els.setupKey.value.trim();
  if (!k) {
    els.setupError.textContent = "Paste a key first.";
    els.setupError.classList.remove("hidden");
    return;
  }
  setKey(k);
  els.setupError.classList.add("hidden");
  hideSetup();
}

// --- Views + drawer ----------------------------------------------------------

function switchView(name) {
  const scan = name === "scan";
  els.scanView.classList.toggle("hidden", !scan);
  els.historyView.classList.toggle("hidden", scan);
  els.tabScan.classList.toggle("active", scan);
  els.tabHistory.classList.toggle("active", !scan);
  if (!scan) renderHistory();
}

function openDrawer() {
  els.settingsKey.value = getKey();
  els.settingsPrefs.value = getPrefs();
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
  renderHistory();
}

// --- Capture flow ------------------------------------------------------------

async function onFilePicked(e) {
  const file = e.target.files && e.target.files[0];
  els.fileInput.value = ""; // allow re-picking the same file
  if (!file) return;

  if (!getKey()) { showSetup(); return; }

  let img;
  try {
    img = await loadOriented(file);
  } catch {
    setStatus("Couldn't open that image. Try again.", true);
    return;
  }

  const fullDataUrl = drawScaled(img, MAX_DIM).toDataURL("image/jpeg", JPEG_QUALITY);
  const thumbBlob = await canvasToBlob(drawScaled(img, THUMB_DIM));

  els.scanResult.classList.remove("hidden");
  els.scanPhoto.src = fullDataUrl;
  els.scanMeta.textContent = "";
  els.ingredientList.replaceChildren();
  setStatus("Reading label...", false, true);

  try {
    const result = await classify(fullDataUrl.split(",")[1]);
    if (result.error || !result.ingredients.length) {
      setStatus(result.error || "Couldn't read the label. Try better lighting or get closer.", true);
      return;
    }
    clearStatus();
    renderIngredients(els.scanMeta, els.ingredientList, result);
    await addScan({
      timestamp: Date.now(),
      productGuess: result.productGuess || "Scan",
      thumbnail: thumbBlob,
      ingredients: result.ingredients,
    });
  } catch (err) {
    handleApiError(err);
  }
}

function setStatus(msg, isError = false, spinner = false) {
  els.scanStatus.className = "status" + (isError ? " status-error" : "");
  els.scanStatus.replaceChildren();
  if (spinner) {
    const s = document.createElement("span");
    s.className = "spinner";
    els.scanStatus.appendChild(s);
  }
  const text = document.createElement("span");
  text.textContent = msg;
  els.scanStatus.appendChild(text);
}
function clearStatus() { els.scanStatus.replaceChildren(); els.scanStatus.className = ""; }

// --- Image helpers -----------------------------------------------------------

// Decode the file honoring EXIF orientation so we never send a sideways photo.
async function loadOriented(file) {
  if ("createImageBitmap" in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch { /* fall through */ }
  }
  // Fallback: modern browsers auto-orient <img> by default (image-orientation: from-image).
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
  return new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/jpeg", 0.7)
  );
}

// --- Gemini call -------------------------------------------------------------

async function classify(base64Jpeg) {
  const prefs = getPrefs().trim();
  const prompt = prefs
    ? `${BASE_PROMPT}\n\nAdditional user preferences (these override the defaults above):\n${prefs}`
    : BASE_PROMPT;

  const body = {
    contents: [{
      role: "user",
      parts: [
        { text: prompt },
        { inlineData: { mimeType: "image/jpeg", data: base64Jpeg } },
      ],
    }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.2,
      maxOutputTokens: 8192, // headroom for long labels (+ any model "thinking")
    },
  };

  let res;
  try {
    res = await fetch(`${API_BASE}/${MODEL}:generateContent`, {
      method: "POST",
      // Key goes in a header, never the URL, so it can't leak via logs/referrers.
      headers: { "Content-Type": "application/json", "x-goog-api-key": getKey() },
      body: JSON.stringify(body),
    });
  } catch {
    throw { kind: "network" };
  }

  if (!res.ok) {
    if (res.status === 429) throw { kind: "rate" };
    // 400 can mean a bad key OR a malformed request; only blame the key when the
    // body actually says so, otherwise we'd send the user to re-enter a fine key.
    const errBody = await res.json().catch(() => null);
    const detail = (errBody?.error?.status || "") + " " + (errBody?.error?.message || "");
    if (res.status === 401 || res.status === 403 || /API.?key|API_KEY_INVALID|PERMISSION_DENIED|UNAUTHENTICATED/i.test(detail)) {
      throw { kind: "key" };
    }
    throw { kind: "http", status: res.status, detail: detail.trim() };
  }

  const data = await res.json();
  const cand = data.candidates && data.candidates[0];
  const text = cand?.content?.parts?.map((p) => p.text || "").join("") || "";
  if (!text) return { ingredients: [], error: "The model returned nothing. Try again." };

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ingredients: [], error: "Couldn't read the label. Try better lighting or get closer." };
  }
  const ingredients = Array.isArray(parsed.ingredients)
    ? parsed.ingredients.filter((i) => i && i.name)
    : [];
  return { ingredients, productGuess: parsed.productGuess || "", error: parsed.error || "" };
}

function handleApiError(err) {
  const kind = err && err.kind;
  if (kind === "key") {
    setStatus("That API key was rejected. Re-enter it below.", true);
    showSetup();
    switchView("scan");
  } else if (kind === "rate") {
    setStatus("Slow down. The Gemini free tier is rate-limited; wait a minute and retry.", true);
  } else if (kind === "network") {
    setStatus("No connection. Check your network and try again.", true);
  } else {
    if (err && err.detail) console.error("Gemini API error:", err.status, err.detail);
    setStatus("Something went wrong reading the label. Try again.", true);
  }
}

// --- Rendering (all model output via textContent; never innerHTML) ----------

function renderIngredients(metaEl, listEl, data) {
  metaEl.textContent = data.productGuess || "";
  listEl.replaceChildren();
  for (const ing of data.ingredients) {
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

// --- History -----------------------------------------------------------------

async function renderHistory() {
  const scans = await getAllScans();
  els.historyList.replaceChildren();
  els.historyEmpty.classList.toggle("hidden", scans.length > 0);

  for (const scan of scans) {
    const card = document.createElement("div");

    const button = document.createElement("button");
    button.className = "history-card";

    const thumb = document.createElement("img");
    thumb.className = "hc-thumb";
    thumb.alt = "";
    if (scan.thumbnail) thumb.src = URL.createObjectURL(scan.thumbnail);

    const bodyEl = document.createElement("div");
    bodyEl.className = "hc-body";
    const title = document.createElement("div");
    title.className = "hc-title";
    title.textContent = scan.productGuess || "Scan";
    const time = document.createElement("div");
    time.className = "hc-time";
    time.textContent = relativeTime(scan.timestamp);
    const tally = document.createElement("div");
    tally.className = "hc-tally";
    appendTally(tally, scan.ingredients);
    bodyEl.append(title, time, tally);

    button.append(thumb, bodyEl);

    const detail = document.createElement("div");
    detail.className = "hc-detail hidden";
    button.addEventListener("click", () => {
      if (detail.dataset.built !== "1") {
        const meta = document.createElement("div");
        meta.className = "meta";
        const list = document.createElement("ul");
        list.id = "";
        list.style.listStyle = "none";
        list.style.padding = "0";
        renderIngredients(meta, list, { productGuess: "", ingredients: scan.ingredients });
        detail.append(list);
        detail.dataset.built = "1";
      }
      detail.classList.toggle("hidden");
    });

    card.append(button, detail);
    els.historyList.appendChild(card);
  }
}

function appendTally(el, ingredients) {
  const counts = { red: 0, yellow: 0, green: 0 };
  for (const i of ingredients || []) if (counts[i.verdict] != null) counts[i.verdict]++;
  const make = (cls, dot, n) => {
    const s = document.createElement("span");
    s.className = `chip chip-${cls}`;
    s.textContent = `${dot} ${n}`;
    return s;
  };
  el.append(make("red", "🔴", counts.red), make("yellow", "🟡", counts.yellow), make("green", "🟢", counts.green));
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

init();
