# Implementation Report: Puget Sound Source Expansion (Wave 3 Phase 1 — batch 1)

## Summary
Built the reusable engine and unlocked the region, then onboarded the flagship city. Shipped: a generic config-driven ArcGIS permit adapter, a `CountySchema` extension (Snohomish/Kitsap/Clark/Spokane) proven eval-byte-identical, and **Bellevue** end-to-end (richest ArcGIS city — contractor on every row). Live per-city verification then corrected the plan's scope: most remaining CLEAN cities each need a **new adapter class**, and two audit-"clean" cities are actually complex/thin. Batch closed on cost with the remainder accurately scoped for a follow-on session. **§12.3 frozen throughout — eval byte-identical.**

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual (this batch) |
|---|---|---|
| Complexity | XL (11 sources, 4 classes) | Confirmed XL — **heavier**: remaining cities need the new classes built, not just configs |
| Confidence | 7/10 | Held; the "config + fixtures per city" leverage is real ONLY for single-layer ArcGIS |
| Files Changed | ~30 | 9 (this batch: 2 new + 5 edited + fixture dir with 3 files) |
| Cities enabled | 11 | **1 (Bellevue)**; 3 more live-verified (Renton/Kitsap/Auburn) with dispositions; remainder scoped |

## Tasks Completed (batch 1)

| # | Task | Status | Notes |
|---|---|---|---|
| — | Extend County enum | ✅ | `b547102` — additive, eval byte-identical, wa_sepa untouched |
| 1 | Generic `ArcgisPermitsAdapter` | ✅ | `611834f` — config-driven; 8 engine tests; typecheck clean |
| 2a | Bellevue config + fixture + test + wire | ✅ | `205a5be` — 9-step complete, `enabled:true`, 285-record real fixture, stage bug fixed |
| 2b | Renton | ⛔ Backlog | Live: ~50-sublayer thematic MapServer → needs multi-layer union |
| 2b | Kitsap | ⛔ Backlog | Live: non-spatial thin table, individual-owner applicants (person-gate) |
| 3 | Auburn (Socrata) | 🔶 Blocked-on-class | Live: clean but columns ≠ Seattle's hardcoded schema → needs a generic Socrata adapter first |
| 4–7 | Vancouver ODS / Snohomish Excel / Kent PDF / Everett / Spokane / Clark / Burien | ⏳ Follow-on | Each needs a new class or single-layer verification; order in the audit |
| 8 | Close-out | ✅ (batch) | This report; STATUS/audit/memory; eval gate |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis | ✅ | `pnpm -r typecheck` 11/11 after every change |
| Unit Tests | ✅ | 210 adapters+config green (12 new in `arcgis-permits.test.ts`); loader pin updated |
| Eval gate (§12.3) | ✅ **byte-identical** | precision 1.0 / recall 0.9609375, same 5 missed ids — held across the enum change |
| Fixture discipline | ✅ | Bellevue: real captured page + `metadata.json` manual comparison + failure cases |

## Files Changed (Insights `claude/tmux-install-320aiz`)

| File | Action |
|---|---|
| `packages/adapters/src/arcgis-permits.ts` | CREATE — generic adapter + BELLEVUE_CONFIG + bellevueStage |
| `packages/adapters/src/arcgis-permits.test.ts` | CREATE — 8 engine + 4 Bellevue tests |
| `packages/domain/src/taxonomy.ts` | UPDATE — County enum + §12.3 note |
| `packages/adapters/src/index.ts` | UPDATE — register bellevue_permits_arcgis |
| `config/sources.yaml` | UPDATE — Bellevue entry (enabled) |
| `packages/config/src/loader.test.ts` | UPDATE — enabled-sources pin |
| `fixtures/bellevue_permits_arcgis/{window-page-1,layer-metadata,metadata}.json` | CREATE |
| `docs/source-expansion-audit-2026-07.md` | UPDATE — live findings + scope correction |
| `docs/STATUS.md` | UPDATE — Wave 3 batch status |

## Deviations from Plan

1. **County enum extension added (owner-approved).** Not in the plan; discovered `CountySchema` is a closed set that would reject non-King records. Owner chose full-inclusion, so the enum was extended — proven eval-neutral. Carries a §12.3 caveat (new counties score at the 0.8 geography default) recorded for calibration.
2. **Scope correction: remaining cities need new adapter classes.** The plan assumed most cities were "config + fixtures" on two owned classes. Live `?f=json` verification showed only single-layer ArcGIS (Bellevue) is a true drop-in; Auburn/Everett need a generic Socrata adapter, Vancouver an ODS adapter, Snohomish an Excel adapter, Kent a PDF operator-local adapter. Renton (multi-layer) and Kitsap (thin, person-applicants) backlogged.
3. **Batch closed early (not archived).** The plan is ~1 of 11 cities done; it is intentionally **NOT** moved to `completed/` — that would misrepresent status. Closed on session cost with the remainder scoped in the audit for a follow-on. This is the biggest deviation and the reason to resume in a fresh session.

## Issues Encountered
- **Bellevue stage bug (fixed):** "Completeness Check" (an intake step) matched a loose `/complete/` and mapped to `complete`; fixed by checking the pre-issuance pipeline before the complete branch; regression test pinned.
- **`pnpm --filter eval:run` exit-1 quirk:** the recursive-run wrapper reported failure though the eval itself printed GATES PASS; confirmed byte-identical via a direct `tsx` run.

## Next Steps (follow-on session — order in the audit)
- [ ] Build a generic config-driven **Socrata** adapter → Auburn, then Everett (confirming fetch first)
- [ ] Verify + add single-layer **ArcGIS** cities: Burien, Spokane City, Clark County (drop-in configs)
- [ ] Build **OpenDataSoft** adapter → Vancouver; **Excel-report** adapter → Snohomish County
- [ ] **Kent** operator-local PDF (WAF-blocked datacenter → genuine-browser capture lane)
- [ ] Backlog: Renton multi-layer union; Kitsap thin party-less records; §12.3 geography calibration for new counties

---

# Batch 2 (2026-07-23) — generic Socrata engine, Everett + Spokane, Solis distance bands

## Summary
Built the second reusable engine (generic Socrata), enabled two more cities, backlogged three on live evidence, and resolved batch 1's §12.3 geography caveat with a distance ladder. **Eval byte-identical again.** Commits: `3e40a73`, `f78416f`, `4f2b729`, `f36f3a1` (pushed to `claude/tmux-install-320aiz`).

## Tasks Completed (batch 2)

| # | Task | Status | Notes |
|---|---|---|---|
| 3 | Generic `SocrataPermitsAdapter` | ✅ | `3e40a73` — Socrata twin of the ArcGIS engine + placeholder party filter; 17 tests |
| 3a | **Everett** onboarded | ✅ | `f78416f` `enabled:true` — first genuine Snohomish source; 279-record fixture |
| 3b | **Auburn** | ⛔ Backlog (registered `enabled:false`) | ETL frozen since 2025-02 on all 3 datasets; parser proven, one-flag flip |
| 4 | **Spokane City** onboarded | ✅ | `f78416f` `enabled:true` — audit URL was wrong (`Permit/` folder); 324-record fixture |
| 4a | **Clark County** | ⛔ Backlog | No authoritative county building-permit layer exposed |
| 4b | **Burien** | ⛔ Backlog | No discoverable publishing surface (on-prem 404, Hub empty) |
| 5 | **Solis distance bands** | ✅ | `4f2b729` — scorer v1.10.0; fixes the 0.8 > 0.6 inversion; eval byte-identical |
| 6 | Batch-1 regression repair | ✅ | `4f2b729` — stale `Snohomish`-rejected domain test |
| 7 | Docs/backlog/STATUS | ✅ | `f36f3a1` — incl. new freshness-verification rule |

## Validation Results (batch 2)

| Level | Status | Notes |
|---|---|---|
| Static Analysis | ✅ | `pnpm -r typecheck` 11/11 |
| Unit Tests | ✅ | **all 51 package suites / 510 tests green** (34 new) |
| Eval gate (§12.3) | ✅ **byte-identical** | precision 1.0 / recall 0.9609375, same 5 missed ids |
| Fixture discipline | ✅ | 3 real fixtures + `metadata.json` manual comparisons |
| DB-backed suites | ⚠️ Not run | 40 `apps/worker` suites need local Docker PG on :5433 (not running); unrelated to these changes |

## Deviations from Plan (batch 2)

1. **Auburn shipped disabled, not enabled.** The plan (and batch-1 audit) treated Auburn as a clean build target. Live freshness checking showed its ETL frozen ~17 months. Shipping it enabled would have served stale data as current; it is registered + parser-proven but `enabled:false`.
2. **Clark and Burien could not be built at all.** Both were listed as "verify + drop-in config". Neither has a usable public surface today — backlogged with the exact evidence rather than forced.
3. **Everett was richer than "1 confirming fetch" implied**, and its obvious-looking sibling dataset is dead. Net: a better source than planned, from a different dataset id than an unverified reading would have picked.
4. **Scoring change added.** Not in the plan; requested by the owner in-session and it resolves the caveat batch 1 recorded.

## Open Item for the Owner

The distance bands are **correct but dormant**: Solis's `territory.counties_included` is still `[Thurston, Pierce, Lewis, King]`, so Snohomish/Kitsap/Clark/Spokane records never reach `routeSolis`. Everett's data flows into the corpus but not into Solis's queue. **Widening the territory is a business decision** (the config marks it provisional pending Solis's confirmation) and is what activates the ladder — deliberately left to the owner, and pinned by a test so it can't happen silently.
