// Unit tests for the pure nutrition math. Run: node nutrition.test.mjs
import { normalizeNutrition, fmt, basisLabel } from "../nutrition.js";

let pass = 0, fail = 0;
const eq = (got, want, msg) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log("PASS  " + msg); }
  else { fail++; console.log(`FAIL  ${msg}\n        got  ${g}\n        want ${w}`); }
};

// 1. Solid, compute per-100g from a 30g serving.
{
  const n = normalizeNutrition({
    servingAmount: 30, servingUnit: "g", servingHousehold: "1/2 cup", basisHint: "solid",
    perServing: { calories: 120, fat_g: 1.5, sugars_g: 12, protein_g: 3, sodium_mg: 190, fiber_g: 3 },
  });
  eq(n.basis, "100g", "solid -> basis 100g");
  eq(n.per100.calories, 400, "120 kcal /30g -> 400 kcal/100g");
  eq(n.per100.sugars_g, 40, "12g sugar /30g -> 40g/100g");
  eq(n.per100.sodium_mg, 633, "190mg /30g -> 633mg/100g (rounded)");
  eq(n.per100.protein_g, 10, "3g protein /30g -> 10g/100g");
  eq(n.serving.household, "1/2 cup", "household preserved");
}

// 2. Same nutrients, different serving (45g) -> different per-100g (the whole point).
{
  const a = normalizeNutrition({ servingAmount: 30, servingUnit: "g", perServing: { sugars_g: 12 } });
  const b = normalizeNutrition({ servingAmount: 45, servingUnit: "g", perServing: { sugars_g: 12 } });
  eq(a.per100.sugars_g, 40, "30g serving -> 40g sugar/100g");
  eq(b.per100.sugars_g, 26.7, "45g serving -> 26.7g sugar/100g");
}

// 3. Liquid -> per 100 ml.
{
  const n = normalizeNutrition({
    servingAmount: 240, servingUnit: "ml", basisHint: "liquid",
    perServing: { calories: 60, sugars_g: 12 },
  });
  eq(n.basis, "100ml", "ml serving -> basis 100ml");
  eq(n.per100.calories, 25, "60 kcal /240ml -> 25 kcal/100ml");
  eq(n.per100.sugars_g, 5, "12g /240ml -> 5g/100ml");
}

// 4. Label already prints per-100 -> trust it, don't recompute.
{
  const n = normalizeNutrition({
    servingAmount: 30, servingUnit: "g",
    perServing: { calories: 120, sugars_g: 12 },
    per100Label: { calories: 377, sugars_g: 41 },
  });
  eq(n.per100.calories, 377, "uses label's per-100 value, not computed 400");
  eq(n.per100.sugars_g, 41, "uses label's per-100 sugar");
}

// 5. No gram/ml weight -> can't normalize; note set, per100 null, per-serving kept.
{
  const n = normalizeNutrition({
    servingAmount: null, servingUnit: null, servingHousehold: "1 cup",
    perServing: { calories: 200, sugars_g: 10 },
  });
  eq(n.per100, null, "no weight -> per100 null");
  eq(n.perServing.calories, 200, "per-serving preserved");
  eq(n.note.length > 0, true, "explanatory note present");
}

// 6. Missing nutrients stay null (not zero-filled).
{
  const n = normalizeNutrition({ servingAmount: 50, servingUnit: "g", perServing: { calories: 100 } });
  eq(n.per100.calories, 200, "present nutrient scaled");
  eq(n.per100.sugars_g, null, "absent nutrient stays null, not 0");
}

// 7. No nutrition at all -> null.
{
  eq(normalizeNutrition(null), null, "null in -> null out");
  eq(normalizeNutrition({ perServing: {} }), null, "empty perServing -> null");
}

// 8. fmt + basisLabel
eq(fmt("calories", 400), "400 kcal", "fmt calories");
eq(fmt("sugars_g", 40), "40 g", "fmt grams");
eq(fmt("sodium_mg", 633), "633 mg", "fmt mg");
eq(fmt("sugars_g", null), "", "fmt null -> empty");
eq(basisLabel("100ml"), "per 100 ml", "basisLabel ml");

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
