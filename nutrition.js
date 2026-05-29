// Pure nutrition helpers: normalization to per-100g / per-100ml.
// No DOM, no globals, so this is unit-testable directly in Node.
//
// Design rule: the LLM only transcribes the label. ALL arithmetic happens here,
// in code, so it's deterministic, auditable, and testable.

// Canonical nutrient set: order, labels, units, and which direction is "better"
// for the compare view ("low" = less is better, "high" = more is better).
export const NUTRIENTS = [
  { key: "calories",      label: "Calories",      unit: "kcal", better: "low"  },
  { key: "fat_g",         label: "Fat",           unit: "g",    better: "low"  },
  { key: "satFat_g",      label: "Saturated fat", unit: "g",    better: "low",  sub: true },
  { key: "carbs_g",       label: "Carbohydrate",  unit: "g",    better: null   },
  { key: "sugars_g",      label: "Sugars",        unit: "g",    better: "low",  sub: true },
  { key: "addedSugars_g", label: "Added sugars",  unit: "g",    better: "low",  sub: true },
  { key: "fiber_g",       label: "Fiber",         unit: "g",    better: "high" },
  { key: "protein_g",     label: "Protein",       unit: "g",    better: "high" },
  { key: "sodium_mg",     label: "Sodium",        unit: "mg",   better: "low"  },
];

export const NUTRIENT_KEYS = NUTRIENTS.map((n) => n.key);

const isNum = (v) => typeof v === "number" && isFinite(v);

function roundFor(key, v) {
  if (!isNum(v)) return null;
  if (key === "calories" || key === "sodium_mg") return Math.round(v);
  return Math.round(v * 10) / 10; // 1 decimal for grams
}

function pick(obj) {
  const out = {};
  for (const k of NUTRIENT_KEYS) out[k] = isNum(obj?.[k]) ? obj[k] : null;
  return out;
}

export function hasAnyValue(obj) {
  return !!obj && NUTRIENT_KEYS.some((k) => isNum(obj[k]));
}

// Normalize the model's raw nutrition object into a stored record (or null).
// raw: { servingAmount, servingUnit, servingHousehold, basisHint, perServing, per100Label }
export function normalizeNutrition(raw) {
  if (!raw) return null;

  const unit = raw.servingUnit === "ml" ? "ml" : raw.servingUnit === "g" ? "g" : null;
  const basis =
    unit === "ml" || raw.basisHint === "liquid" ? "100ml" :
    unit === "g"  || raw.basisHint === "solid"  ? "100g"  : null;

  const perServing = pick(raw.perServing);
  let per100 = null;
  let note = "";

  if (hasAnyValue(raw.per100Label)) {
    // Label already prints a per-100 column. Trust it (just round for display).
    const labelled = pick(raw.per100Label);
    per100 = {};
    for (const k of NUTRIENT_KEYS) per100[k] = roundFor(k, labelled[k]);
  } else if (isNum(raw.servingAmount) && raw.servingAmount > 0 && unit) {
    const factor = 100 / raw.servingAmount;
    per100 = {};
    for (const k of NUTRIENT_KEYS) per100[k] = perServing[k] == null ? null : roundFor(k, perServing[k] * factor);
  } else if (hasAnyValue(perServing)) {
    note = "Serving size has no weight or volume, so per-100 comparison isn't possible. Showing per serving only.";
  }

  // Nothing usable at all -> treat as no nutrition captured.
  if (!hasAnyValue(perServing) && !per100) return null;

  return {
    basis,
    serving: {
      amount: isNum(raw.servingAmount) && raw.servingAmount > 0 ? raw.servingAmount : null,
      unit,
      household: typeof raw.servingHousehold === "string" ? raw.servingHousehold : "",
    },
    perServing,
    per100,
    note,
  };
}

// Format a numeric value with its unit. Returns "" for null/missing.
export function fmt(key, v) {
  if (!isNum(v)) return "";
  const meta = NUTRIENTS.find((n) => n.key === key);
  const u = meta ? meta.unit : "";
  return u === "kcal" ? `${v} kcal` : `${v} ${u}`;
}

// Human label for a basis ("100g" -> "per 100 g").
export function basisLabel(basis) {
  if (basis === "100ml") return "per 100 ml";
  if (basis === "100g") return "per 100 g";
  return "per 100";
}
