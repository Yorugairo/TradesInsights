# Implementation Report: Identifier graph + scoring calibration

## Summary
Every independent Registry and Insights source now meets on a shared identifier,
the confidence bands are computed from evidence that varies, and the human queues
are worked by pattern instead of by row.

Shipped across both repos in four commits:

| Repo | Commit | Scope |
|---|---|---|
| Registry | `7356247b` | Phase 0 + Phase 1 (Tasks 1.1–1.3) — identifier promotion |
| Registry | `7a59c5f2` | Task 1.4 — `trades_identifiers_v1` contract view |
| Insights | `a6c5b72` | Phase 2 — confidence rewire |
| Insights | `9f4514c` | Phase 3 — queue navigability |

## Assessment vs Reality

| Metric | Predicted (plan) | Actual |
|---|---|---|
| Complexity | XL (both repos + live DB) | XL — accurate |
| Files | ~16 | 17 |
| Distinct trust values, 254-row bulk | ">> 9" | **11 → 29** |
| Tier mix | "non-degenerate" | **68 / 144 / 66** |

## Acceptance criteria

| Criterion | Result |
|---|---|
| Identifiers include address/phone/domain/place_id with `is_strong` damping | 52,584 → **109,931**; 615 shared values link 1,237 entities |
| Distinct trust values on the bulk rule rise well above 9 | **29** (range 0.653–0.825 → 0.672–0.906) |
| No rule scores on `ruleHistory` without human decisions | `ruleHistory` is NULL on all 278 pending rows |
| Tiers evidence-defined and non-degenerate | 68 / 144 / 66 across 278 |
| Review defaults to clusters with a 50%/80% indicator | 66 clusters clear half, 195 clear 80% |
| `evaluateStrictBind` unchanged; no new auto-binding | `strict-bind:preview` → 0 candidates |
| `anon` still has no USAGE on `registry_public` | `has_schema_privilege('anon', …)` = false |

## Deviations from plan

**Task 2.2 — graded locality is not metre bands.** The plan specified distance
bands from `geo_distance_meters`. That column is the registry's INTERNAL
Google-listing-versus-L&I distance for a single entity; it says nothing about how
far an org's projects are from an entity. Insights `projects` carry `city`,
`county` and `address_normalized` and **no coordinates at all**, so an org↔entity
distance in metres cannot be computed today. Implemented four bands from the
geography both systems actually hold: same city 1.0, same county 0.6, unknown 0.3
(the plan's floor), known-different county 0.15.

**Task 2.3 — the `identifier` component could not be pure agreement.** The plan
assumed org↔entity identifier agreement would move the queue. Measured: **252 of
the 254 pending rows carry no org-side identifier at all** (117 of 3,777 unbound
orgs have an address, 55 have a phone). Agreement alone would have moved two rows.
Agreement is still computed and now graded strong/weak; when the org offers
nothing to compare, the component falls back to the matched ENTITY's identifier
footprint — which is exactly what Phase 1 built, and which varies across 12
distinct shapes in the bulk.

**Task 2.4 — tiers were recalibrated after the first cut.** Counting every
corroborator equally put 186 of 278 rows (67%) in tier1. Replaced with a points
model weighted by how much each fact narrows identity. Two pre-existing tests
asserting "exact name alone = tier2" were updated to tier3, per the plan's
explicit "tier3 = name only".

**Unplanned fix: the generator never rescored.** `ON CONFLICT (dedupe_key) DO
NOTHING` meant a row scored once kept that score forever, so none of Phase 2
could have reached the 254 rows already queued. Changed to `DO UPDATE`, guarded
to rows still `pending` with `decided_at IS NULL` — a decision freezes its
evidence. `xmax = 0` keeps "new candidates" counting only genuine inserts.

## Issues encountered

| Issue | Resolution |
|---|---|
| `is_strong` is schema-enforced UNIQUE (Phase 1, two rejected runs) | Policy rewritten to `is_strong = (bucketSize === 1)`; shared values stored weak |
| Bucket size must include rows already in the table | Existing rows merged into buckets; `demoteNewlySharedStrong()` added |
| Existing tier tests broke under the points model | 6 changed; 2 were deliberate plan-directed reassignments, 4 were mine to correct |
| My `clustersToCover` test asserted 1 where the true answer was 162 | Test was wrong, function was right — rewritten to assert the real behaviour |

## Tests

| File | Tests | Area |
|---|---|---|
| `registry-identifiers.test.ts` | 18 | identifier graph, grading, skip-safe read |
| `registry-trust.test.ts` | 26 | null-component renormalization, locality bands, tiers |
| `review-triage.test.ts` | 11 | fail-closed review state, cluster coverage |
| existing suites | 325 | unchanged and passing |

380 green. Typecheck, build and lint on touched packages clean (99 pre-existing
lint errors in `scripts/*.mjs`, `.worktrees/` and `apps/worker/test/` are
unchanged — verified identical with and without this work).

## Not done / backlogged

- **Insights-side enrichment (Phase A)** stays backlogged. It is what would make
  the `identifier` component's agreement path matter: today it moves 2 rows.
- **`MIN_HUMAN_DECISIONS = 10`** is a starting point, not a measured constant. It
  becomes live the first time a rule accumulates ten human decisions — worth
  revisiting then.
- **The 1,518 evidence-blocked rows** now have a name and a place in the UI, but
  nothing yet gathers the parcel/org evidence that would unblock them.
