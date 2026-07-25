# Implementation Report: Windowed peer selection for gym_market_comparators

**Plan**: `.claude/PRPs/plans/gym-market-comparator-windowed-peers.plan.md`
**Date**: 2026-07-25
**Status**: Tasks 1–4 complete. Task 5 (per-MV transaction) not started. Task 6 gate run in progress.

## Summary

Replaced the quadratic correlated LATERAL in `registry_gym_market_comparators_v1` with
a bounded windowed pre-pass. The MV that would not complete now builds in 172.8s and
holds 75,901 rows — full parity with `public.tenants`. Equivalence against the old
definition was proven on a 104-gym sample before the change was made.

## Assessment vs reality

| Metric | Plan | Actual |
|---|---|---|
| Complexity | Medium | Medium |
| Confidence | 8/10 | Held — no rework of the core design |
| Files | 3 | 3 created |

## Result

| Measure | Before | After |
|---|---|---|
| Build (EXPLAIN ANALYZE) | **>1,500s, never completed** | **172.8s** |
| Planner cost | 172,969,298 | (plan shape now hash joins + 3 window sorts) |
| Rows | 26,934 (stale since 2026-07-05) | **75,901** |
| CONCURRENTLY refresh | 1200s → cancelled | **219.5s, success** |
| Options per row | avg 8.8 / max 9 | avg 8.8 / max 9 (unchanged) |
| Rows with zero options | — | 0 |

## Tasks

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Equivalence baseline | Complete | 104 gyms, 4 cohorts — one cohort deviated, see below |
| 2 | Windowed rewrite | Complete | Deviated from plan's join shape, see below |
| 3 | Prove equivalence + measure | Complete | **82 identical, 22 tie-permuted, 0 failures** |
| 4 | Refresh + verify | Complete | 75,901 rows, 3 indexes, 0 non-owner grants |
| 5 | Per-MV transaction (skeleton) | NOT STARTED | Deliberately deferred — see Next Steps |
| 6 | Re-enable job 1 | Gate run in progress | Job 1 remains **paused** |

## Validation

| Level | Status | Notes |
|---|---|---|
| Equivalence | **Pass** | 0 failures across 104 gyms |
| Build measurement | **Pass** | 172.8s, 75,901 rows built |
| CONCURRENTLY refresh | **Pass** | 219.5s, success, telemetry committed |
| Acceptance SQL | **Pass** | parity 75,901 = 75,901; max 9 options; 0 empty; 3 indexes; 0 non-owner grants |
| Lint (`npm run lint:src`) | **Pre-existing failure** | 62 errors / 303 warnings — **not caused by this change**; the five changed files are all `scripts/` and `supabase/migrations/`, which `eslint src` does not scan |
| Build (`npm run build`) | Not run | No `src/` file changed; see Honest Gaps |

## Deviations from plan

**1. One planned cohort does not exist.** The plan specified "40 in a county-only bucket
(`city_token IS NULL`)". Measured: 75,897 gyms carry a `city_token`, exactly 4 carry
neither token, and **zero** carry a `county_token` at all. A county-only cohort is
unsampleable — absent from the data, not skipped for convenience. Sample became 40 dense
city / 40 mid city / 4 both-null / 20 singleton = 104. Consequence: **tier 1 never fires
today.** The county branch is retained anyway, because a NULL `county_token` is a data
gap rather than a schema truth, and populating it later must not silently change peer
semantics.

**2. Three equality joins instead of the plan's single OR-join.** The plan's design had
one join with `(city-match OR county-match OR state-fallback)`. That form cannot hash-join
on the bucket key, and since `state_code` is effectively constant ('WA' for every row),
it would degenerate toward a 75,901 × ~16,000 cross product before filtering — replacing
one quadratic with another. Split into three `UNION ALL` branches, each with an equality
condition the planner can hash.

**3. The fat column is joined after the cut.** Not in the plan. `data` is ~908 B/gym;
carrying it through the candidate stage would materialise ~531k wide rows (~480 MB) to
discard most. Candidates carry only ordering fields; `gym_base` is re-joined for
`slug`/`data` after the `ord <= 6` filter.

**4. The equivalence tool needed to accept both definition endings.** It scopes the live
definition by appending a `WHERE` to the outer query, guarded by a check on how the
definition ends. The rewrite changed that ending (`peer_options ON true` →
`LEFT JOIN peer_options ON peer_options.gym_tenant_id = g.tenant_id`), so the guard was
widened to accept both — it must run against both sides of the change.

## Issues encountered

- **`UNION ALL` branch with `ORDER BY`/`LIMIT` needs parentheses** in Postgres. Cohort
  sampling failed with `42601` on first run; fixed by wrapping each branch.
- **ESM ignores `NODE_PATH`.** The migration generator could not resolve `pg` from the
  scratchpad; fixed with `createRequire` pointed at the registry app.

## The finding that matters most for what comes next

**CONCURRENTLY now costs more than the build.** The refresh spilled **2,657 MB** against
a 172.8s build — and it was a *no-op* diff (75,901 → 75,901, content identical, since the
`CREATE` had just populated it). CONCURRENTLY full-outer-joins the entire old and new
contents to find changes, so a run that changes nothing still pays the maximum diff cost.

For this MV specifically, a plain `REFRESH MATERIALIZED VIEW` would rebuild in ~173s and
swap, with no diff and no 2.6 GB spill — at the cost of an `AccessExclusiveLock` for the
duration. Whether that trade is right is an **operational decision about locking, not a
performance one**, so it is flagged rather than taken. Worth noting the plan's original
instinct to drop CONCURRENTLY was not worthless; it simply was not the *build* fix, and
the build had to be fixed first for the question to even be reachable.

## Honest gaps

- **Task 5 not attempted.** The per-MV transaction change to the shared refresh function
  is the remaining skeleton item. Its plan gotcha stands unresolved: plpgsql cannot
  `COMMIT` inside a function invoked via `SELECT`, so this likely means the caller drives
  the loop. That shape decision should be made explicitly, not discovered mid-edit.
- **No page render check.** The plan's Task 4 asked for a directory and profile page
  rendering a populated comparison panel. Not done — the MV feeds `_current` tables via
  `hydrate_registry_current_bundle_comparators`, which runs on the `state:WA` scope
  (jobs 2–3), so pages will not reflect this until that next runs. Verified instead at
  the data layer (0 rows with empty options) and via the previously-confirmed graceful
  degradation path in `gymMarketComparison.ts`.
- **`npm run build` not run.** No `src/` file changed, so it cannot regress from this
  diff. Stated rather than claimed as passing.
- **Pre-existing lint debt (62 errors, 303 warnings) left alone.** Real, unrelated, and
  too large to fold into this change without obscuring it.

## Files changed

| File | Action | Lines |
|---|---|---|
| `apps/registry/scripts/rewrite-gym-market-comparator-peers.mjs` | CREATED | +236 |
| `apps/registry/scripts/compare-gym-market-peer-equivalence.mjs` | CREATED | +216 |
| `apps/registry/supabase/migrations/20260728020000_gym_market_comparator_windowed_peers.sql` | CREATED | generated from live definition |

Registry `35f7ce31` on `codex/otn-app-extraction`; cherry-picked to `release/trades-staging`.

## Next steps

- [ ] Task 6: complete the full ten-MV gate run; re-enable job 1 only on all-ten success
- [ ] Task 5: decide caller-driven vs function-driven per-MV commit, then implement
- [ ] Decide CONCURRENTLY vs plain refresh for this MV (locking trade-off, owner call)
- [ ] Confirm pages render comparison panels after the next `state:WA` cycle
