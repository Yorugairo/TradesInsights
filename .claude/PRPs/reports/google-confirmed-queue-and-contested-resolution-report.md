# Implementation Report: Google-confirmed queue + contested resolution

**Date**: 2026-07-25
**Plan**: `.claude/PRPs/plans/completed/google-confirmed-queue-and-contested-resolution.plan.md`
**Branches**: Insights `claude/tmux-install-320aiz` (`4d79c93`, `4b5c761`, `850504b`, plus baseline `5b6db95`) · Registry `codex/otn-app-extraction` (`a4f20124`)

## Summary

All five tasks complete. The headline outcome is not the one the plan predicted:
the "143 contested listings needing human resolution" turned out to be **2 real
conflicts and 139 rows mislabelled by a scorer defect**, which the plan's own
clustering assumption had hidden. That defect is fixed, and the surface built to
present conflicts now also separates the mislabels rather than inflating the
queue by ~70x.

## Assessment vs Reality

| Metric | Predicted | Actual |
|---|---|---|
| Complexity | Medium | Medium, +1 unplanned defect fix |
| Confidence | 8/10 | Held — no rework, no failed validation |
| Files changed | ~10 (2 registry, 8 Insights) | 12 (1 registry, 11 Insights) |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Refresh stale payloads | Complete | `rescored: 278`, `strictAutoBound: 0` |
| 2 | Surface contested listings | Complete, **scope grew** | Found + fixed the licence-vs-entity defect |
| 3 | Primary-contractor lane | Complete | Button shows exactly 46, as predicted |
| 4 | Binding diagnostic | Complete | Buckets sum to exactly 169 |
| 5 | ROI unsupported-facts mislabel | Complete | Semantics verified on a synthetic set |

## Measured Outcomes

**Task 1 — the refresh delivered less than the ceiling, as warned.**

| | Before | After |
|---|---|---|
| Pending | 278 | 278 |
| Google-confirmed (tier 1) | 49 | **84** |
| Stale payloads | 178 | 143 |

+35 achieved against a 47 eligible ceiling. The other 12 scored `phone_only` or
`name_only`, not `phone_and_name`. **47 was never a promise** and is not reported
as an achievement.

**Task 2 — the plan's central premise was wrong, and measurement caught it.**

The plan asserted "143 links do NOT mean 143 decisions — they cluster onto far
fewer place ids." Measured: 143 links → **141 distinct place ids**, essentially
1:1. Investigating why a contested place had one claimant found the real cause:

`scoreGooglePlaceObservations` keyed the contested set by **licence number**
(`google-place-scrape.ts:190`), so one company holding several L&I licences on
its own listing counted as several rival claimants. Anderson Drilling LLC holding
`ANDERDL789CQ` + `ANDERDL789TQ` is one company, not two.

| | Value |
|---|---|
| Contested links written | 143 |
| With a genuine rival entity | **4 links / 2 places** |
| No rival at all (mislabelled) | **139** |
| Contested places after fix (live re-score) | ~141 → **3** |

Each of the 139 was written to the registry as `not_public_pending_review` —
a legitimate Google confirmation withheld from the public surface over a conflict
that did not exist.

**Task 4 — the bucket split.**

| Bucket | Count |
|---|---|
| `no_registry_name_match` | 145 |
| `person_shaped` | 18 (upper bound — see below) |
| `unique_key_no_candidate` | 3 |
| `prefix_noise` | 3 |
| `generic` | 0 |
| **Total** | **169** ✓ |

Two honesty guards built into the output:
- `person_shaped` **overcounts**: `isPersonShapedOrgName` inherits the known
  `BUSINESS_TOKENS` gaps, so "OLYMPIA FIREPLACE & SPA" and "GENESIS BUILDINGS"
  land there. Same gap that keeps the person-shape refusal gated on roadmap P6.
- `unique_key_no_candidate` got its own bucket rather than being folded into
  ambiguity. GROUNDWORKS / AIRX LLC / ENTEK LLC match a **unique** registry key
  yet produced no candidate, and were verified to carry **no observation of any
  status** — so it is not a rejected-candidate artifact. Cause unmodelled; this
  bucket is the pointer.

No bucket is framed as enrichment-addressable, per the plan's carried-forward
correction: `google_name` is not a match key.

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Type check | Pass | `pnpm typecheck`, all 11 projects, zero errors |
| Unit tests | Pass | 758 passed across `packages/` (67 files); +10 new |
| Build | Pass | `pnpm --filter @otn/web build` exit 0 |
| Lint | **Pre-existing failure** | 99 errors, **none in changed files** — all in `scripts/*.mjs`, `apps/worker/test/cockpit-views.test.ts`, and untracked `.worktrees/` copies |
| Seam invariant | Pass | View readable as `otn_insights`; `registry_internal` still denies **42501** |
| Live data | Pass | Every count in this report re-measured post-change |

## Deviations from Plan

1. **Scope grew: the licence-vs-entity defect.** Not in the plan. Building the
   contested surface as specified would have shipped a review queue that was 97%
   noise. Fixed at source, with a regression test naming the live case.
2. **No `actions.tsx` for the contested page.** The plan listed
   `{page,actions}.tsx`, but also specified "no accept action in this task". With
   no action and no shared selection state the page renders entirely server-side
   — 190 B of client JS, versus 3.03 kB for the review page that needs a client
   table.
3. **`realConflicts()` / `rival_count` added.** Not planned. Required once the
   139:4 split was known, so a row count can never be reported as a workload.
4. **`unique_key_no_candidate` bucket added** — the plan listed five buckets;
   forcing these 3 into `ambiguous_multi_match` would have misreported the cause.
5. **No unit test for Task 3's filter.** `apps/web` has no component-test
   harness, and the mirrored `googleConfirmedRows` button has no test either.
   Verified against live data instead (button count = 46 = measured). Inventing a
   harness for a one-line filter was not worth it; flagged rather than skipped.
6. **No unit test for Task 5.** `roiSnapshot` is a SQL aggregate with no
   pure-function seam and there is no `roi` test file. Validated by running both
   the old and new predicates over a synthetic evidence set: the old counted 3
   (including healthy B-grade corroboration), the new correctly counts only the 2
   opportunities with no confirmed row.

## Issues Encountered

1. **`pnpm --filter @otn/resolution test` silently passed with no tests.** That
   package has no `test` script, so the command exited 0 having run nothing. Real
   commands are root-level `vitest run` / `pnpm -r run typecheck`. An empty pass
   was nearly mistaken for a green suite.
2. **Local Postgres (:5433) is down**, so 40 DB-backed test files fail on
   `ECONNREFUSED`. Confirmed zero `AssertionError`s anywhere in the suite — every
   failure is the missing container, not logic.
3. **Uncommitted baseline.** The validated `partner_observations` rewrite from
   the prior session was never committed; committed as `5b6db95` before starting.

## Files Changed

| File | Action |
|---|---|
| `packages/resolution/src/google-place-scrape.ts` | UPDATE — contested keyed by entity |
| `packages/resolution/src/google-place-scrape.test.ts` | UPDATE — regression test |
| `packages/resolution/src/google-place-contested.ts` | CREATE — reader + grouping |
| `packages/resolution/src/google-place-contested.test.ts` | CREATE — 9 tests |
| `packages/resolution/src/index.ts` | UPDATE — barrel |
| `packages/resolution/src/registry-observations.ts` | UPDATE — `loadPrimaryContractorOrgIds` |
| `apps/web/app/app/admin/google-place-contested/page.tsx` | CREATE — surface |
| `apps/web/app/app/admin/registry-review/page.tsx` | UPDATE — role fetch |
| `apps/web/app/app/admin/registry-review/actions.tsx` | UPDATE — field + button |
| `apps/worker/src/cli/binding-audit.ts` | CREATE — diagnostic |
| `apps/worker/package.json` | UPDATE — script |
| `packages/delivery/src/roi.ts` | UPDATE — metric semantics |
| `<registry>/…/20260727010000_google_place_contested_view.sql` | CREATE — contract view |

## Open Items — owner decisions

1. **The 139 mislabelled links are still held back.** The scorer fix does not
   heal rows already written: re-scoring dedupes on `(entity, place)` and will
   not update them. Healing means flipping `relationship_type` → `direct`,
   `link_status` → `accepted`, `public_surface_policy` → `profile_enrichment_ready`
   on those rows. **Not executed** — it makes 139 business profiles surface Google
   data publicly, which is outward-facing and reversible only by hand. The UI
   counts them separately in the meantime.
2. **The registry migration is not on the trades trunk.** `a4f20124` is on
   `codex/otn-app-extraction` (pushed as a new remote branch) per the plan's
   explicit instruction. Its two sibling migrations (`f3597a38`, `216870d1`) are
   on `origin/release/trades-staging`. The view is already applied live, so
   nothing is broken, but the file should be cherry-picked to the trunk.
3. **`unique_key_no_candidate`** — 3 orgs match a unique registry key and produce
   no candidate. Small, but it is the only bucket that looks like a live bug.
4. **Roadmap P6** (full WA L&I load) still gates the person-shape refusal, and
   the `person_shaped` overcount above is fresh evidence for why.

## Next Steps
- [ ] Owner decision on the 139-row remediation
- [ ] Cherry-pick `a4f20124` onto `release/trades-staging`
- [ ] `/code-review` before merge
