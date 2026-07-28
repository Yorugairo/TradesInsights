# Implementation Report: Valuation truth, orphan regression guard, plan close-out

**Plan**: `.claude/PRPs/plans/completed/valuation-truth-orphan-guard-and-plan-closeout.plan.md`
**Branch**: `claude/tmux-install-320aiz`
**Date**: 2026-07-28
**Baseline artifact**: `docs/data-quality-audit-2026-07-28.md` (regenerated from a live hosted run)

## Summary

The audit stopped ranking absence as failure, the healed split-permit defect became a hard
invariant, Bellevue's valuation question was answered without touching ingestion, and the plans
directory now tells the truth. **Zero adapter changes, zero migrations, zero scoring inputs.**

## Assessment vs reality

| Metric | Predicted (plan) | Actual |
|---|---|---|
| Complexity | Medium, ~9 files, 6 tasks, 0 migrations | 6 tasks, 0 migrations, **13 files** (5 renames + 5 annotations + 3 edits) |
| Confidence | 9/10 | Single pass; one deviation, in the close-out count |
| Tests | +6 planned | **1,295 → 1,300** |

## Tasks completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Valuation stated/notPublished/DROPPED | Complete | Hosted: `DROPPED = 0` on all 26 sources |
| 2 | Pierce 59-row residue | Complete | **All 59 are `"0"`** — the zero rule, exactly as predicted |
| 3 | Bellevue count-only coverage probe | Complete | Field stopped being published ~2025-11-21 |
| 4 | Split-permit invariant | Complete | Grouped `(source_id, external_id)`; hosted reads 0 |
| 5 | Plan close-out | Complete | **Deviated — 5 archived, not 9** |
| 6 | Close-out | Complete | All gates green |

## Validation results

| Level | Status | Notes |
|---|---|---|
| Type check | Pass | zero errors |
| Lint | Pass | zero errors |
| Unit + integration | Pass | **1,300/1,300** across 125 files |
| E2E | Pass | 33/33 Playwright |
| Eval gate | **Byte-identical** | precision 1, recall 0.9609375 |
| Hosted audit | **INVARIANTS OK** | 4 invariants now, all clean |

## The measurements that carried the round

**Valuation — `DROPPED = 0` across all 26 public sources.** The plan's central gate. Every
"missing" valuation in the graph is the source publishing nothing, an empty string, a permit
fee, or a jurisdiction-assigned `0`. The five sources I had ranked as parser targets that
morning:

| Source | records | stated | not published | DROPPED |
|---|---|---|---|---|
| `pierce_permits_arcgis` | 6,423 | 1,596 | 4,827 | **0** |
| `bellevue_permits_arcgis` | 4,018 | 0 | 4,018 | **0** |
| `king_permit_reports` | 1,920 | 469 | 1,451 | **0** |
| `puyallup_permits_arcgis` | 1,228 | 0 | 1,228 | **0** |
| `olympia_smartgov_reports` | 1,023 | 0 | 1,023 | **0** |

**Pierce's 59-row residue is entirely `"0"`** — one value, 59 rows. The plan made this a STOP
gate (if they were not all ≤0, "no adapter changes" was a false premise). They were.

**Bellevue stopped publishing `VALUATION` around 2025-11-21.** Count-only probes: 440,444 rows
all-time; 35,468 with `VALUATION > 0` (8.1%, matching the config's figure exactly); 5,901 in the
adapter's 120-day window; **0 of those carrying a valuation**. By `ISSUEDDATE`: 6,503 since
2020 → 3,171 since 2023 → 996 since 2025 → **0 since 2026-01-01**. Widening the window would
recover history, not leads. Recorded in `config/sources.yaml`; nothing ingested.

**Split permits: 0.** All 46 PALS records converged onto their ArcGIS twin's project. Now an
invariant that names offenders, so a relapse announces itself.

## Deviations from plan

**D1 — plan close-out archived 5, not 9.** The plan predicted nine archives and flagged only
`trades-read-model-verticalization` as a trap. The three-check rule it mandated found four more
plans with real engineering outstanding:

| Plan | Verdict | What remains |
|---|---|---|
| `cockpit-seam-performance-and-degradation` | **Archived** | — (report found by content; prefix matching misses it) |
| `cockpit-ui-first-class-product` | **Archived** | all four phases reported |
| `registry-insights-golive-taxonomy-warmnet-sources` | **Archived** | only WS-S, deferred by governance |
| `source-fleet-flow-verification` | **Archived** | code complete; blocked on owner secrets |
| `webs-omwbe-solicitation-ingestion` | **Archived** | phase 3 deferred **on evidence** |
| `queue-cockpit` | Annotated | **Tasks A1–A6 and E1–E2** |
| `trades-read-model-verticalization` | Annotated | **Tasks 3–4** (task 2 abandoned by measurement) |
| `gym-market-comparator-windowed-peers` | Annotated | **Task 5 NOT STARTED** (blocked on 2D000) |
| `puget-sound-source-expansion` | Annotated | **Auburn / Clark / Burien** |
| `registry-insights-dataflow-solis-inference` | Annotated | **WS-D, WS-E.2/3/4, WS-C.2/3** |

The distinction applied: a **decision** (deferred on evidence, gated on governance, blocked on
owner credentials) closes a plan; **unstarted engineering** does not.

**D2 — a test-fixture helper was added.** `withInvariants()` in `data-audit.test.ts`. Adding a
fifth invariant forced four call sites to restate all of them; a fixture that makes you re-list
unrelated fields is one that will be wrong next time.

**D3 — the "DROPPED is not fatal" assertion is per-failure, not on an empty list.** It runs
against whatever corpus the machine has, and a scratch DB may legitimately have other invariants
failing. The claim is "no valuation bucket can produce a failure", not "this DB is clean".

## Issues encountered

- **The plan's Bellevue branch (b) was never reachable** — it said a non-zero `dropped` would
  contradict Task 1's validation and force a re-plan. `dropped` was 0, so branch (a) applied and
  the deferral stands on evidence rather than assumption.
- No SQL or type failures this round; the `::numeric` regex guard and the `(source_id,
  external_id)` grouping were both pre-empted in the plan and worked first time.

## Files changed

| File | Action |
|---|---|
| `apps/worker/src/data-audit.ts` | UPDATED — three-bucket valuation, split-permit invariant |
| `apps/worker/test/data-audit.test.ts` | UPDATED — +5 tests, `withInvariants` helper, DB fixtures |
| `config/sources.yaml` | UPDATED — dated Bellevue coverage measurement |
| `docs/data-quality-audit-2026-07-28.md` | UPDATED — regenerated + Correction + Round-4 seeds |
| `docs/STATUS.md` | UPDATED — round recorded; orphan item CLOSED with evidence |
| 5 plans | MOVED to `completed/` |
| 5 plans | UPDATED — dated status annotation naming what remains |

## Tests written

| Test file | Tests | Area |
|---|---|---|
| `apps/worker/test/data-audit.test.ts` | +5 (9 → 14) | Fee/zero/empty bucket placement (DB fixtures); a positive raw value counts DROPPED; DROPPED is a metric; split permit fails and names the id; split-permit-free passes |

## Next steps

- **Owner: the ten GitHub Actions secrets.** The fleet fires and dies in ~10s; nothing has
  ingested on a schedule. Pair with the workflow's step-gating bug.
- Narrow the junk-name digit rule (16 named false positives) — owner call.
- Strict `name_quality = 'business'` view predicate.
- Re-probe Bellevue periodically; a resumed field is invisible unless someone looks.
