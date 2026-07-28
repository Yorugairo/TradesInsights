# Implementation Report: Cockpit seam — performance, pool hygiene, degradation

Executed 2026-07-27. **All six planned tasks complete**, plus one follow-up the
validation exposed. One item from the plan's "Notes" remains open and is
described honestly at the end.

## Result

| Route | Before | After |
|---|---|---|
| `/app/admin/cockpit` | 21.8s cold / 11.2s warm, **500 under load** | **1.23s** |
| `/app/admin/corporate-families` | **109.58s** | **0.62s** |
| Cockpit, seam unreachable | 500 (raw stack trace) | **200 in 6.45s**, "not measured" |
| Registry connections per page load | **+4, leaked** | flat |

Gate: e2e **29/29** (28 existing + the new perf spec, no spec edited),
unit **1242/1242**, typecheck and lint clean.

## The diagnosis I got wrong, and what corrected it

The plan asserted that `corporateFamilyRollup`'s query shape was the 109
seconds — a giant inline `VALUES` list and an unfiltered `proj_val` CTE. That
was a reasonable read of the SQL and it was **wrong**. Timing each step against
production:

| Step | Time | Rows |
|---|---|---|
| `fetchRegistryIdentityRows` (over the seam) | 5.2s warm / 29–79s cold | **72,952** |
| `loadPersonCandidates` | 6.4s | 2,779 |
| `buildFamilies` (pure JS) | 0.3s | |
| `buildPrincipalPersonIndex` (pure JS) | 0.2s | |
| `matchPrincipalsToPeople` (pure JS) | 0.007s | 354 |
| `corporateFamilyRollup` — the accused | **3.3s** | 50 |

The derivation is half a second. The cost was shipping the entire registry
identity view across the seam on every request. The 109-second reading was a
cold fetch; the 9–21s cockpit was a warm one plus person candidates.

Worth keeping: reading a query and reasoning about its shape produced a
confident, specific, wrong answer. Six timing calls produced the right one.

## What shipped

| Task | Commit | Note |
|---|---|---|
| T1 pool memoisation | `8597fcc` | Independently shippable, fixes a live leak |
| T2 cached derivation | `120cc65` | Process cache, stale-while-revalidate |
| T3 third state | `120cc65` | + `dc8dbce` for the Google Place half |
| T4 error + loading boundaries | `120cc65` | |
| T5 sequential reads | `120cc65` | |
| T6 perf budget spec | `120cc65` | |

### Deviation: cached, not materialised

The plan called for a `corporate_family_summary` table written by the
maintenance chain. I used a process-level cache with stale-while-revalidate
instead. Same outcome for the two rules that mattered — `derivedAt` travels with
the data and renders, and a failed refresh never overwrites good data with a
zero — with no migration, no schema change, and no new worker job.

The trade is honest: a table survives a restart and is shared across instances;
a process cache does neither, so the first request after a deploy pays the cold
derivation (22–79s) and sees "not measured". Given this is a single-instance
admin surface that self-heals in one request, the migration is not yet earned.
It becomes the right answer the moment this app runs more than one instance.

### Three things the validation caught that the plan did not

**Budgeting one seam call is not budgeting the seam.** With the family snapshot
under a 4s budget, the cockpit against a blackholed seam still took **25.4s** —
`googlePlaceSummary` had no ceiling and sat on the TCP connect timeout. Both are
budgeted now; 6.45s worst case.

**`loading.tsx` at the segment root was a regression.** A `loading.tsx` makes
Next swap page content on every navigation beneath it, and the swap discards
focus. The e2e caught it instantly: focus the opportunities filter, press Cmd-K,
get the command palette — because the focused input had been replaced
mid-keystroke. It is now scoped to `/app/admin`, where pages are actually slow.
The sub-second customer pages were paying a content swap for nothing.

**`Promise.race` leaves an unhandled rejection.** The losing promise keeps
running — deliberately, since it still warms the cache — but without its own
`.catch` a later rejection is fatal in Node. A timeout guard that crashes the
server is worse than the hang it replaces.

## Still open: e2e runs against the hosted production database

This was on the improvements list and I did **not** fix it. What I found:

- The local Docker Postgres works, and `pnpm db:seed` runs — but it seeds only
  **sources, account profiles, account rules, coverage entries and a capacity
  snapshot**. Projects, opportunities, source records, evidence, gate results,
  extractions, organizations, roles, pursuits, digests, outcomes and review
  clusters all come from real pipeline runs.
- `apps/worker/test/helpers.ts` offers `testDb`, `resetSource` and
  `deleteTestProjects` only. Every vitest DB test authors its fixtures inline;
  there is no reusable corpus factory to build on.
- The 29 e2e tests assert against roughly fifteen tables — county filtering,
  full-text search hits, map geometry, evidence grades, league tables, ROI
  scorecards, triage clusters.

So this is a fixture-authoring task of several hours, not a config change. I
stopped rather than half-build it, because a partial corpus leaves the suite red
and the only way to make it green from there is to weaken the assertions — which
is the one move this project forbids.

**Do not solve it by copying production data into a fixture.** The
corporate-families page displays private individuals by design; a filtered
`pg_dump` would put real principal names in the repository.

`workers: 1` remains the compensating control.

## Files changed

| File | Action |
|---|---|
| `apps/web/lib/registry-db.ts` | CREATED — memoised pool |
| `apps/web/lib/registry-families.ts` | CREATED — cached derivation, SWR |
| `apps/web/components/proof/DerivedAt.tsx` | CREATED — the "as of" convention |
| `apps/web/app/app/error.tsx` | CREATED — first error boundary in the app |
| `apps/web/app/app/admin/loading.tsx` | CREATED — admin-scoped skeleton |
| `apps/web/e2e/perf.spec.ts` | CREATED — response budgets |
| `packages/intelligence/src/cockpit-summary.ts` | UPDATED — opts, sequential reads |
| `apps/web/app/app/admin/cockpit/page.tsx` | UPDATED — budgets, third state |
| `apps/web/app/app/admin/corporate-families/page.tsx` | UPDATED — reads the snapshot |
| 4 further admin routes | UPDATED — memoised pool |
