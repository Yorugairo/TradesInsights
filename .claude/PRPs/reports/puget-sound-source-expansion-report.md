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
