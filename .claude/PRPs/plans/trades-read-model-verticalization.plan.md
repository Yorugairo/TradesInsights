# Plan: Trades read-model verticalization (source_mvs rebuild)

> **STATUS 2026-07-28 — TASK 1 ONLY, NOT CLOSEABLE.** The single report (`…-task1-report.md`) covers the refresh profiling. **Task 2 is struck through in the plan itself (abandoned by measurement); Tasks 3 and 4 — trades-native pSEO read models and re-enabling job 1 behind evidence — have no report.** The blocker recorded elsewhere still binds: plpgsql cannot COMMIT under pg_cron or the pooler (2D000), so per-MV commits need an out-of-DB driver.


## Summary

The registry's read-model layer was built for BJJ — ~4,000 gyms nationally — and
trades inherited it byte-identically. Trades now has **75,901 licences in one
state**. The `source_mvs` refresh phase no longer completes: measured 2026-07-25
it ran **~45 minutes, spilled >1.65 GB of temp, and rolled back**, leaving the
directory read models stale at 26,934 of 75,901 contractors. This plan replaces
whole-table MV rebuilds with incremental maintenance, in the skin rather than the
skeleton wherever possible.

## User Story

As the operator, I want the trades directory read models to refresh without
exhausting disk, so that pSEO pages describe all 75,901 contractors instead of a
third of them — and so the design survives going multi-state.

## Problem → Solution

| Current | Desired |
|---|---|
| `source_mvs` rebuilds 75,901 rows weekly, fails at >1.65 GB spill | Incremental: rebuild only what changed |
| Trades rides `registry_gym_*` read models wholesale | Trades-native skin over an unchanged skeleton |
| Job 1 paused indefinitely; read models durably stale | Job 1 re-enabled, refresh bounded and routine |

## Metadata
- **Complexity**: Large
- **Skeleton change**: MANDATORY (see Architecture Constraint)
- **Blocking**: job 1 (weekly `source_mvs`) stays paused until this ships

---

## ARCHITECTURE CONSTRAINT — read before designing

Owner principle, verbatim: *"everything stays standard in the skeleton, then we
work off the skin; only changing the skeleton when it is absolutely required,
which helps with future technical debt."*

This verticalization was **byte-identical** — trades reuses the BJJ read-model
machinery unchanged. That was correct and should stay correct wherever it still
works. Two consequences bind this plan:

1. **Skeleton changes must be mandatory AND serve every vertical.** Incremental
   refresh is not a trades hack; it is strictly better for BJJ too (4,000 static
   rows also do not need weekly full rebuilds). Do NOT fork the refresh function
   per vertical — that is the technical debt this principle exists to prevent.
2. **Anything expressible in the skin stays in the skin.** Trade-specific column
   sets, labels and page shapes belong in trades-native views, not in edits to
   shared functions.

A change that cannot be justified as "better for BJJ as well" belongs in the skin.

---

## Measured evidence (2026-07-25 — verify, do NOT re-derive)

### The failure
| Measure | Value |
|---|---|
| `source_mvs` duration before rollback | ~45 min |
| Temp spilled (partial — excludes first 10 min) | **>1,651.7 MB** |
| `source_mvs` audit rows committed | 0 (rolled back) |
| `registry_gym_profile_metrics_v1` after | 26,934 (unchanged; should be ~72,952) |
| Database size | 2,400 MB |

Spilling 1.65 GB on a 2.4 GB database is not a query-tuning problem.

### Change rate — the finding that decides the design
| Window | Tenants changed |
|---|---|
| 1 day | 48,967 (tonight's bulk ingest) |
| 7 days | 48,967 (same event) |
| 30 days | 75,901 (all — oldest row 2026-07-05) |
| **Between the two bulk loads (Jul 5 → Jul 25)** | **0** |

**Steady-state change rate is zero.** The only writes are bulk ingests. A weekly
full rebuild recomputes 75,901 static rows to produce a byte-identical result.
Incremental maintenance makes the weekly job a near no-op and confines real cost
to pull days.

### Why per-state batching was rejected
The obvious fix — batch the refresh by state — saves nothing: the data is WA-only,
so `state` has cardinality 1 and one batch is the whole table. County (39 in WA,
~1,900 rows each) would partition, but it tunes a design that is wrong for the
vertical and moves the cliff rather than removing it when trades goes multi-state.

### Density is the root cause, not volume alone
| | BJJ | Trades |
|---|---|---|
| Rows | ~4,000 nationally | 75,901 in one state |
| Comparator options (pre-cap) | 7.9 / 3.9 avg | 140.7 / 63.5 avg |
| Comparator total (pre-cap) | 165 MB | 2,329 MB |

Same code, opposite behaviour. The peer join's `>= 5 gyms` threshold is a natural
limiter at BJJ density and stops limiting anything at trades density.

### The alternative is already running
`registry_public.trades_identity_v1`, `trades_identifiers_v1`,
`trades_activity_v1` and `trades_taxonomy_v1` are **plain views** (verified via
`pg_class.relkind`). They served 72,952 entities all night at zero refresh cost.
The trades-native pattern is already in production; only the pSEO read-model layer
is MV-bound.

---

## Mandatory Reading

| Priority | File | Why |
|---|---|---|
| P0 | `registry_internal.refresh_registry_source_materialized_views()` | The failing phase; read before changing anything |
| P0 | `registry_internal.refresh_registry_read_models(scope text)` | Phase/scope/advisory-lock structure to preserve |
| P0 | `<registry>/apps/registry/scripts/cap-*-comparator-peers.mjs` (3) | The transactional drop/recreate + splice pattern proven 3x on 2026-07-25 |
| P1 | `apps/registry/src/lib/public-pages/{directoryPageData,gymProfilePageData}.ts` | What the read models must still deliver |
| P1 | `apps/registry/src/lib/gymMarketComparison.ts` | Consumer of `compare_options`; no slicing today |
| P2 | `artifacts/comparator-cap/rollback-baseline.sql` | Pre-cap definitions of all three comparators |

---

## Step-by-Step Tasks

### Task 1: Profile the refresh, phase by phase
- **ACTION**: Instrument `refresh_registry_source_materialized_views()` to record
  per-MV duration and temp spill into the existing phase-audit table.
- **WHY**: >1.65 GB is a total, not a culprit. Which MV dominates is unmeasured,
  and the incremental design should target it first.
- **GOTCHA**: The audit INSERT is inside the function's transaction, so a failure
  rolls it away — which is exactly why the 2026-07-05 and 2026-07-25 failures left
  no trace. Write phase telemetry through a mechanism that survives rollback
  (autonomous transaction via dblink, or a table written before the work begins).
  Without this, a failed run is unmeasurable and Task 2 is guesswork.
- **VALIDATE**: one deliberate failing run leaves a committed per-phase record.

### Task 2: ~~Convert the dominant source MV to an incrementally maintained table~~
> **SUPERSEDED 2026-07-25** by
> `.claude/PRPs/plans/gym-market-comparator-windowed-peers.plan.md`.
>
> Task 1's profiling disproved this task's premise. The dominant MV is
> `registry_gym_market_comparators_v1`, and its cost is a **quadratic correlated
> LATERAL** in the view definition (plan cost 172,969,298; 5.76 billion row
> visits) — not the refresh mechanism. Converting it to an incrementally
> maintained table would carry that quadratic build into the delta path and
> inherit it on every bulk-ingest day, which is the only day writes happen.
>
> The replacement plan rewrites the peer selection as a bounded windowed
> pre-pass, which stays in the SKIN and needs no change to the shared refresh
> function. The one skeleton change still worth making — one transaction per MV,
> justified on correctness rather than speed — is carried forward as Task 5 of
> that plan.
>
> Original text preserved below for provenance.

- **ACTION**: Replace `REFRESH MATERIALIZED VIEW` with delete+insert scoped to
  tenants whose `updated_at` exceeds a stored high-water mark.
- **MIRROR**: the transactional drop/recreate + `SET LOCAL statement_timeout`
  pattern from the three capping scripts (all three succeeded; the first attempt
  proved the transaction boundary works when a pooled session times out).
- **SKELETON JUSTIFICATION**: incremental refresh is better for BJJ too — 4,000
  static rows equally do not need weekly full rebuilds. Implement once, in the
  shared function, parameterised by vertical. Do NOT fork.
- **GOTCHA**: `REFRESH MATERIALIZED VIEW` is atomic and cannot be partial — that
  is why the object type must change. A table, not an MV.
- **GOTCHA**: bulk ingests move ~49k rows at once, so the incremental path must
  stay bounded on pull days, not just quiet days. Chunk within the delta.
- **VALIDATE**: a no-change run touches 0 rows and spills <10 MB; a 49k-row
  ingest completes without exceeding the `state:WA` baseline of 255 MB.

### Task 3: Trades-native read models for the pSEO surface
- **ACTION**: Introduce trades-shaped read models scoped to what contractor pages
  actually render, replacing inherited gym-profile semantics.
- **SKIN, NOT SKELETON**: new views in the trades namespace; the shared refresh
  machinery is untouched by this task.
- **GOTCHA**: `registry_gym_profile_metrics_v1` is 100% WA L&I contractors — there
  is no BJJ data in this project. "Gym" here is not legacy cosmetics; the columns
  carry gym semantics contractors do not need. Verify each column has a trades
  meaning before porting it.
- **VALIDATE**: directory and profile pages render from the new models with no
  visual regression.

### Task 4: Re-enable job 1 behind evidence
- **ACTION**: Re-enable the weekly `source_mvs` job only after a manual run
  completes with committed telemetry.
- **GOTCHA**: Do NOT re-enable on the strength of `state:WA` succeeding. That
  inference was made on 2026-07-25 and was wrong — `state:WA` ran 164s/255 MB
  while `source_mvs` ran 45 min/>1.65 GB and rolled back. They are different
  phases with different cost drivers.
- **VALIDATE**: `registry_gym_profile_metrics_v1` reaches ~72,952 rows; a
  committed `source_mvs` audit row with status `success`.

---

## NOT Building

- **Per-state batching.** Cardinality 1 today; moves the cliff rather than
  removing it.
- **Read-time joins to deduplicate comparator payloads.** Owner ruled this out;
  duplication was checked and cleared as legitimate (1,911 geo keys → 8,414
  payloads, varying by program-tag membership, not duplicated source rows).
- **Undoing the comparator caps.** They fixed `state:WA` and carry into any new
  design.
- **A forked refresh function per vertical.** Explicitly against the skeleton/skin
  principle.

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Incremental drifts from full-rebuild output | Medium | High | Periodic full rebuild in a maintenance window, diffed against incremental |
| Telemetry still lost on rollback, leaving Task 2 blind | Medium | High | Task 1 explicitly requires rollback-surviving writes |
| Trades-native models miss a column a page depends on | Medium | Medium | Task 3 validates against real page renders, not schema equality |
| Skeleton change regresses BJJ | Low | High | Change must be justified as better for BJJ; test on `wlckwafwytkuxqtzxayi` staging first |
| 45-min round trip per failed attempt | High | Medium | Profile first (Task 1); never iterate blind |

---

## Notes

Current safe state: job 1 paused, jobs 2–3 active, seam and Insights unaffected
(plain views), pSEO stale at 26,934. Nothing degrades further while this is built.

The three comparator caps shipped 2026-07-25 (2,329 MB → 493 MB) are complete and
independent of this plan.
