# Implementation Report: Trades read-model verticalization — Task 1

**Plan**: `.claude/PRPs/plans/trades-read-model-verticalization.plan.md` (Task 1 of 4)
**Date**: 2026-07-25
**Status**: Task 1 complete. Plan NOT archived — Tasks 2–4 outstanding, and Task 2 needs re-scoping against these findings.

## Summary

Task 1 asked for per-MV duration and spill telemetry that survives a rollback, because
the two `source_mvs` failures left no evidence and Task 2 was otherwise guesswork.
Built, validated, and run. The blocker is now named, and three of the plan's working
assumptions turn out to be wrong.

## Assessment vs reality

| Metric | Plan | Actual |
|---|---|---|
| Complexity | Large (whole plan) | Task 1 alone: Medium |
| Files changed | not estimated | 2 created |
| Confidence | 6/10 single-pass | Task 1 landed first pass; Task 2 now needs re-scoping |

## What was built

| File | Action |
|---|---|
| `apps/registry/supabase/migrations/20260728010000_source_mv_refresh_probe.sql` | CREATED (+118) |
| `apps/registry/scripts/profile-source-mv-refresh.mjs` | CREATED (+385, then +61) |

Registry `daa154a6`, `89eda199` on `codex/otn-app-extraction`; cherry-picked to
`release/trades-staging` as `d6365aa5`, `8180d718`. Probe table applied live to
`arbmeioglflvzoffgtii` with **zero non-owner grants** — the Insights seam is untouched.

## Validation — the Task 1 gate

Plan's gate: *"one deliberate failing run leaves a committed per-phase record."*

`--fail-probe` forced a refresh to be cancelled (`57014`, work transaction rolled back).
The telemetry row was still committed and readable **from a third independent session**,
carrying SQLSTATE, error text, duration and a `forcedFailure` marker. This is precisely
what the production path destroys. **PASS.**

## The measurement

Full run, per-MV, each in its own transaction:

| # | MV | sec | spill MB | rows |
|---|---|---:|---:|---|
| 1 | gym_profile_metrics | 16.9 | 255 | 26,934 → **75,901** |
| 2 | registry_analytics | 8.5 | 93 | 3,108 → 5,475 |
| 3 | region_labels | 16.6 | 0 | 3,108 → 5,475 |
| 4 | region_metric_overlays | 0.7 | 0 | 3,108 → 5,475 |
| 5 | gym_program_tags | 7.7 | 139 | 51,689 → 149,523 |
| 6 | program_directory_analytics | 7.5 | 58 | 14,878 → 20,877 |
| 7 | program_market_analytics | 7.1 | 41 | 10,890 → 14,515 |
| 8 | region_comparators | 55.0 | 280 | 3,108 → 5,475 |
| 9 | program_region_comparators | 181.7 | 344 | 10,890 → 14,515 |
| 10 | **gym_market_comparators** | **1200.2 ✗ 57014** | 332 | unchanged |

**Nine of ten complete in 302 seconds. The tenth alone ran 1,200s and never finished** —
80% of runtime, and the sole blocker.

## Findings that revise the plan

**1. It is one MV, not a systemic read-model problem.** The plan framed this as the
BJJ read-model architecture failing at trades density. Nine of ten models handle
75,901 contractors in five minutes. Only `registry_gym_market_comparators_v1` does not.
That is a much narrower problem than "rebuild the materialized view process for trades".

**2. It is duration, not disk.** The plan's central evidence was ">1.65 GB spilled" and
"spilling 1.65 GB on a 2.4 GB database is not a query-tuning problem." Per-MV, no single
MV spilled more than 344 MB and the database peaked at 2,543 MB. The 1.65 GB was the
*cumulative* total across all ten, which is why it looked like disk exhaustion. The
2026-07-25 failure was a timeout. Separately, the one `failed` queue row from
2026-07-05 — the originally recorded OTN-14 — has scope `state:WA` and error
`could not write to file "base/pgsql_tmp/pgsql_tmp84182.3": No space left on device`.
**That failure was real, was disk, and was fixed by the comparator caps.** The
`source_mvs` failure is a distinct, later problem that inherited its name.

**3. All ten refresh `CONCURRENTLY`, and it does not matter.** Undocumented in the plan:
every source MV carries a unique index and is refreshed `REFRESH MATERIALIZED VIEW
CONCURRENTLY`, which materialises a second full copy into a temp table, full-outer-joins
it against the live MV, and applies deltas. That looked like a cheap win — stop
refreshing MV 10 concurrently. It is not: `EXPLAIN ANALYZE` of the defining query
**alone timed out at 25 minutes**, before any diff cost. The build is the cost. This
closes off the cheapest available fix, which is worth knowing before Task 2 spends a
20-minute round trip discovering it.

**4. The atomic wrapper turned a survivable failure into a total loss.** In production
all ten refreshes share one transaction, so MV 10's failure discarded the nine
successful rebuilds ahead of it. That is why `profile_metrics` stayed at 26,934 through
two attempts despite refreshing correctly in 17 seconds both times. Driving one
transaction per MV was enough to bank 9 of 10 permanently.

## Production state changed

`registry_gym_profile_metrics_v1` now holds **75,901 rows** (was 26,934, stale since
2026-07-05), along with eight other models. This is the desired end state and is now
durable. `gym_market_comparators_v1` remains stale at 26,934.

Verified this partial state degrades gracefully: `gymMarketComparison.ts` returns
`{ gymData: null, compareOptions: [] }` for a gym with no comparator row
(`src/lib/gymMarketComparison.ts:229,277,288,295`), so newly visible contractors render
without a comparison panel rather than erroring.

Cron unchanged and still in the plan's required safe state: job 1 paused, jobs 2–3 active.

## Deviations from plan

**Telemetry written from a second connection, not from inside the SQL function.** The
plan suggested instrumenting `refresh_registry_source_materialized_views()` via dblink.
dblink is available on this instance but not installed. Since the probe script has to
exist anyway to drive a per-MV run, writing telemetry over its logging connection is a
smaller and less permanent footprint than installing an extension to instrument one
function. The shared skeleton functions were **not modified** — consistent with the
plan's own architecture constraint.

**Added `--explain`, beyond the stated scope.** Task 1 asked only for duration and spill.
Separating build cost from diff cost was worth one extra measurement because it
eliminates an entire candidate fix for Task 2.

## Root cause: the build is quadratic

`EXPLAIN` (no ANALYZE, instant) gives total cost **172,969,298**. The shape:

```
Nested Loop Left Join  (cost=24097.94..172969298.48 rows=75901 width=312)
  CTE gym_base -> Seq Scan on registry_gym_profile_metrics_v1 (rows=75901)
  ...
  ->  Aggregate  (cost=2277.10..2277.11 rows=1)          <- once per gym
        ->  Sort   Sort Key: CASE city_token/county_token match, sponsor_sort DESC, rating DESC, gym_name
              ->  Limit
                    ->  Sort
                          ->  CTE Scan on gym_base p_1  (cost=0.00..2277.03)
                                Filter: tenant_id <> g.tenant_id AND state_code = g.state_code AND (...)
```

For **each** gym it rescans the entire `gym_base` CTE to select peer gyms, then sorts
and limits. 75,901 × 75,901 ≈ **5.76 billion row visits**; at 26,934 gyms it was 725
million. A 2.8× row increase produced an 8× work increase — which is exactly why this
MV used to finish slowly and now does not finish at all. Per-iteration cost 2,277 ×
75,901 ≈ 172.8M, accounting for essentially the entire plan cost.

`gym_base` is a CTE, so it is materialised and rescanned with no index available.

**This is pre-existing BJJ heritage, not caused by the comparator caps.** The cap
applied on 2026-07-25 appears as `SubPlan 3` (`jsonb_array_elements … Filter: ord <= 6`)
at cost **1.34** — three orders of magnitude below the quadratic join, and correctly
placed.

The fix is well-defined and does not require changing the object type: replace the
per-gym correlated peer subquery with a single windowed pass over `gym_base` —
`ROW_NUMBER() OVER (PARTITION BY <locality bucket> ORDER BY sponsor_sort DESC,
rating DESC NULLS LAST, gym_name)` — computed once and joined. That is O(n log n) once
instead of O(n) sorts over O(n) rows. This is the same class of rewrite as the
correlated top-N used in `cap-region-comparator-peers.mjs`, applied in the opposite
direction.

## What this means for Task 2

Task 2 as written — *"convert the dominant source MV to an incrementally maintained
table… delete+insert scoped to tenants whose `updated_at` exceeds a high-water mark"* —
now has a named target but a questionable mechanism:

- The dominant MV is `registry_gym_market_comparators_v1`, confirmed.
- **Incremental scoping by `updated_at` has poor locality here.** This MV is one row per
  gym, but its content derives from *region-level* aggregates. One changed contractor
  changes its region's aggregate, which changes every gym in that region. On a quiet day
  nothing changes and any incremental scheme is a no-op — but on a bulk-ingest day
  (the only day writes happen) essentially every region changes, so incremental
  maintenance rebuilds nearly everything anyway.
- The plan's decisive "steady-state change rate is zero" finding therefore argues for
  **not rebuilding on a schedule at all** more than it argues for incremental deltas.
- Since the build alone exceeds 25 minutes, the real lever is reducing *what is
  computed* — which is Task 3's trades-native skin, not Task 2's skeleton change.

**Recommendation: replace Task 2 with a query rewrite, not an object-type change.**
The root cause is a quadratic correlated subquery inside one MV's definition. Converting
that MV to an incrementally maintained table would carry the quadratic build into the
delta path and inherit it on every bulk-ingest day, when every region changes anyway.
Fixing the join is both cheaper and sufficient: it targets the actual 173M-cost node,
needs no change to the shared refresh function, and is verifiable in isolation with the
`--explain` mode already committed.

This also resolves the plan's architecture-constraint tension cleanly. The plan asked
whether a skeleton change was "absolutely required". On this evidence it is **not**: the
shared refresh machinery moves 75,901 contractors through nine models in five minutes.
One MV's defining query is quadratic. That is a skin defect, and fixing it in the skin
is exactly what the owner's principle prescribes.

The one skeleton change still worth arguing for is unrelated to performance: **one
transaction per MV instead of one for all ten.** It is what banked 9 of 10 rebuilds
today, it is strictly better for BJJ as well (a late failure should not discard earlier
successes anywhere), and it converts a total loss into partial progress. That meets the
plan's bar for a justified skeleton change on correctness grounds rather than speed.

## Next steps

- [x] Capture the plan shape for MV 10 — done, quadratic peer join identified
- [ ] Re-scope Task 2 as a query rewrite (windowed peer selection) per above
- [ ] Consider the per-MV-transaction change to the shared refresh function
- [ ] Task 4 gate unchanged and still unmet: job 1 stays paused
