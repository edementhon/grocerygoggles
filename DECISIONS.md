# Decisions

Architectural and product decisions, with the non-obvious reasoning, so we don't re-debate them.

## 2026-05-29 | Speed is the gating adoption constraint
If a scan or comparison feels slow, the app won't get used in the aisle (user: "if this is slow, it's just not going to be used"). Every feature is now weighed against time-to-result, not just correctness.
Key constraints: the Gemini round-trip dominates latency. Implications: prefer ONE batched API call over several serial calls; minimize taps before the result; optimize *perceived* latency (optimistic UI, streaming) as much as wall-clock.

## 2026-05-29 | Batch capture + single grouped call for comparison
Instead of scan-A → wait → scan-B → wait → open Compare → select, the user snaps a series of photos covering one or more products in one session, then a single "Analyze" fires one Gemini call. The model groups the photos by product and returns an array of products; per-100g nutrition is still computed in JS. One round-trip, not N.
Key constraints: multi-image grouping can mis-assign a photo to the wrong product. Mitigate by showing each product's source thumbnails and allowing a one-tap re-analyze. Reliable for visually distinct packages (the common case).

## 2026-05-29 | Unified result: one product → verdict, many → comparison (proposed)
Rather than a separate "compare mode," the same snap → Analyze flow returns 1..N products; the app shows a single verdict card for one product or a side-by-side comparison for several. The history-based Compare tab stays for comparing against products saved on earlier trips.

## 2026-05-29 | Ingredient-quality comparison is the differentiator, generated in the same call
Per-100g nutrition is commoditized; the LLM's judgment of ingredient *quality* (which additives are flagged, what A has that B doesn't, a one-line "cleaner pick") is the differentiated, decision-changing part. Since we already make one call, the model also returns the quality diff + verdict at ~no extra round-trip cost. Nutrition math stays deterministic in JS; quality judgment stays with the model (handles synonyms/salience).
No single 0-100 score: reductive and contentious, and it fights the "opinionated but transparent, you decide" ethos. Verdict sentence + visible breakdown instead.

## 2026-05-29 | Model: Fast/Quality toggle, default Fast (resolves the open question)
Settings has a "Speed vs quality" toggle. Default **Fast** = gemini-2.5-flash with thinkingBudget:0 (skip model "thinking" to cut latency); **Best quality** = gemini-3.5-flash for the occasional tricky/glossy/tiny label. Both IDs in the `MODELS` constant. Rationale: speed is the gating adoption constraint, so default to the fast tier and let the user opt into quality when a scan fails, rather than paying 3.5-flash latency on every aisle scan.
Key constraints: thinkingBudget:0 is sent only for the 2.5 tier (3.5 may reject it); flash-lite remains a one-line swap for max speed.

## 2026-05-29 | One product per photo set is its own history record
A batch Analyze can yield multiple products; each is saved as its own scan record (not one combined record) so the history-based Compare tab treats today's and past scans uniformly. Re-analyzing a batch deletes the prior batch's records and rewrites them (no duplicates). The inline comparison after a multi-product scan is rendered live from the call's response.
