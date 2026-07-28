# Plan: Cockpit seam — performance, pool hygiene, and honest degradation

## Summary

`/app/admin/cockpit` takes 9.6–21.8s and returns a 500 when it crosses
`statement_timeout`. `/app/admin/corporate-families` takes **109 seconds**. Both
have the same root cause, and it is not the database: the corporate-family graph
is re-derived in Node on every request. Two adjacent defects make it worse — the
registry pool is created per request and never closed, and the app has no error
or loading boundary anywhere, so a slow page is a dead tab and a failed one is a
stack trace.

## User story

As the operator working the review queues, I want the cockpit to load in about a
second and to tell me plainly when a number could not be measured, so that I can
trust what it shows and act on it.

## Metadata

- **Complexity**: Medium
- **Source**: follow-up to `cockpit-ui-first-class-product.plan.md` (Phase 3 complete)
- **Estimated files**: 12

---

## Measured evidence

All timings taken 2026-07-27 against the production database, built server,
warm, logged in as `solis_interiors` / admin, one request at a time.

| Route | Status | Time |
|---|---|---|
| `/app/admin/sources` | 200 | 0.42s |
| `/app/admin/google-place-review` | 200 | 1.15s |
| `/app/admin/review` | 200 | 1.61s |
| `/app/admin/cockpit` (cold) | 200 | **21.83s** |
| `/app/admin/cockpit` (warm) | 200 | **11.20s** |
| `/app/admin/corporate-families` | 200 | **109.58s** |

Under e2e load the cockpit crosses `statement_timeout` and returns **500 with
error code 57014**.

### What this rules out

- **Not the seam connection.** `google-place-review` opens the same registry
  pool and answers in 1.15s.
- **Not `triageReviewQueue`.** `/app/admin/review` runs it and answers in 1.61s.
- **Not the app database.** `sources` answers in 0.42s.

The only thing the two slow pages share, and the fast ones do not, is
`familiesSummary` / the corporate-family derivation.

---

## Root causes

### RC1 — the family graph is re-derived per request, to print three integers

`packages/intelligence/src/cockpit-summary.ts:212`:

```ts
async function familiesSummary(db: Db, pool: RegistryPoolLike): Promise<CockpitFamilies> {
  const rows = await fetchRegistryIdentityRows(pool);          // whole identity view → Node
  const { families } = buildFamilies(rows);                    // 1,401 families, in JS
  const candidates = await loadPersonCandidates(db);           // person candidates → Node
  const pairs = matchPrincipalsToPeople(candidates, buildPrincipalPersonIndex(rows));
  const newPairs = pairs.filter((p) => !p.alreadyBound);
  const strong = newPairs.filter((p) => p.verdict === "strong" || p.verdict === "corroborated");
  return { count: families.length, pairsNew: newPairs.length, pairsStrong: strong.length };
}
```

The whole derivation runs so the cockpit can render `1,401`, `354` and `258`.
The corporate-families page runs the same derivation and then renders all of it,
which is the 109s.

This is a **read model that was never materialised**. The repo already has the
pattern: `deriveCorroboration` runs on the nightly maintenance chain
(`apps/worker/src/schedules.ts:153`) and writes `projects.corroboration` with a
`derivedAt` stamp, and every reader just selects it.

### RC2 — the registry pool is created per request and never closed

`apps/web/lib/db.ts` memoises the app pool on `globalThis` — correct. Nothing
does that for the registry pool. `createRegistryPool()` (`max: 4`) is called
inline in **five** places:

- `app/app/admin/cockpit/page.tsx:35`
- `app/app/admin/corporate-families/page.tsx:60`
- `app/app/admin/google-place-review/page.tsx:38`
- `app/app/admin/google-place-contested/page.tsx:35`
- `app/api/admin/google-place-review/[id]/decision/route.ts:32`

Every page load allocates a new four-connection pool against the registry
database and leaks it. A single operator session of fifty page views leaks two
hundred connections. This has not caused a visible outage yet, which is the only
reason it is still here.

### RC3 — no degradation path, anywhere

Measured: `error.tsx` **0**, `loading.tsx` **0**, `Suspense` **0** across the
whole of `apps/web/app`.

Consequences:
- A 21s page is 21 seconds of an unresponsive tab with no shell, no nav, no
  indication that anything is happening.
- Any server throw renders Next's raw "Application error: a server-side
  exception has occurred", with a digest and nothing actionable. That is exactly
  what the cockpit 500 showed.
- The cockpit's own doctrine has two states — a number, or "seam offline". It
  has no third state for **"we could not measure this in time"**, which is what
  actually happened.

---

## Patterns to mirror

### MATERIALISED_DERIVATION
```
// SOURCE: packages/resolution/src/corroboration.ts:96-100
UPDATE projects p SET corroboration = jsonb_build_object(
  'sourceCount', src.source_count,
  'stageDepth', COALESCE(st.stage_depth, 0),
  'contradictions', COALESCE(cf.contradictions, '[]'::jsonb),
  'derivedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
```
Derived once on the maintenance chain, stamped with `derivedAt`, read cheaply
everywhere. `derivedAt` is what lets the UI say "as of" instead of implying live.

### POOL_MEMOISATION
```ts
// SOURCE: apps/web/lib/db.ts
const globalStore = globalThis as unknown as { __otnPool?: pg.Pool; __otnDb?: Db };
export function db(): Db {
  if (!globalStore.__otnDb) { … }
  return globalStore.__otnDb;
}
```

### THREE_STATE_PROOF
```tsx
// SOURCE: apps/web/components/proof/GateBadge.tsx:28-47
// pass / fail / blocked_on_verifier / null — "could not ask" is not "said no",
// and neither is a number.
```

### SEQUENTIAL_READS
```tsx
// SOURCE: apps/web/app/app/opportunities/page.tsx
// Pool max is 2. Promise.all of two page reads holds BOTH connections and
// starves every other request. Measured: 3 e2e failures, 4.7m vs 1.3m.
```

---

## Files to change

| File | Action | Why |
|---|---|---|
| `apps/web/lib/registry-db.ts` | CREATE | Memoised registry pool |
| 5 call sites listed in RC2 | UPDATE | Use it |
| `packages/db/src/schema.ts` | UPDATE | `corporate_family_summary` table |
| `packages/db/migrations/****_corporate_family_summary.sql` | CREATE | |
| `packages/intelligence/src/corporate-family.ts` | UPDATE | Persist derivation |
| `packages/intelligence/src/cockpit-summary.ts` | UPDATE | Read the table; sequential |
| `apps/worker/src/schedules.ts` | UPDATE | Add to the maintenance chain |
| `apps/web/app/app/admin/cockpit/page.tsx` | UPDATE | Third state + Suspense |
| `apps/web/app/app/admin/corporate-families/page.tsx` | UPDATE | Read the table |
| `apps/web/app/app/error.tsx` | CREATE | Segment error boundary |
| `apps/web/app/app/loading.tsx` | CREATE | Shell-preserving skeleton |
| `apps/web/e2e/perf.spec.ts` | CREATE | Budget as a test |

## NOT building

- A general caching layer. One derivation is slow; the rest of the app is
  sub-2s.
- A lineage/affiliation resolver. Disproven previously; out of scope.
- Any change to what the numbers mean. Same derivation, computed on a schedule
  instead of per request, and labelled with when.

---

## Step-by-step tasks

### Task 1: Memoise the registry pool
- **ACTION**: `apps/web/lib/registry-db.ts` exporting `registryPool(): pg.Pool | null`,
  memoised on `globalThis.__otnRegistryPool`. Replace all five call sites.
- **MIRROR**: `POOL_MEMOISATION`.
- **GOTCHA**: Keep returning `null` when `REGISTRY_DATABASE_URL` is unset — the
  entire "seam offline" contract is that null, and callers branch on it.
- **GOTCHA**: Do not close the pool per request. It is process-lifetime, like `db()`.
- **VALIDATE**: `SELECT count(*) FROM pg_stat_activity` on the registry database
  stays flat across 20 cockpit loads. It currently climbs by 4 per load.

### Task 2: Materialise the family derivation
- **ACTION**: New table `corporate_family_summary` — one row: `family_count`,
  `pairs_new`, `pairs_strong`, `derived_at`. Plus persist the pair rows the
  corporate-families page renders.
- **IMPLEMENT**: `deriveCorporateFamilies(db, registryPool)` runs the existing
  `fetchRegistryIdentityRows` → `buildFamilies` → `matchPrincipalsToPeople` chain
  once and writes the result. Add it to the maintenance chain next to
  `deriveCorroboration`.
- **MIRROR**: `MATERIALISED_DERIVATION`.
- **GOTCHA**: **Stamp `derived_at` and render it.** A cached number presented as
  live is the fabrication rule with extra steps. The UI must read "1,401
  families as of 03:12 today".
- **GOTCHA**: Never write a zero row on failure. If the derivation cannot run,
  leave the previous row and let `derived_at` go stale — a stale honest number
  beats a fresh fake one. The UI flags staleness past a threshold.
- **GOTCHA**: Principal↔person discovery stays review-only by construction. This
  task changes WHEN it is computed, never what it is allowed to do.
- **VALIDATE**: cockpit and corporate-families quote identical numbers; both
  under 2s.

### Task 3: Third state — "could not measure in time"
- **ACTION**: Give each seam-dependent card a per-section budget
  (`Promise.race` against ~3s) and its own `try`/`catch`. On timeout or throw,
  render a state visually distinct from both a number and "seam offline".
- **MIRROR**: `THREE_STATE_PROOF`.
- **GOTCHA**: The three states are NOT interchangeable — "seam offline"
  (`REGISTRY_DATABASE_URL` unset, a config fact), "not measured in time" (the
  seam exists and did not answer), and a number. Collapsing the middle one into
  either of the others is the bug this task exists to prevent.
- **VALIDATE**: with `REGISTRY_DATABASE_URL` pointed at a blackholed port, the
  cockpit renders in under 4s showing the timeout state, and returns **200**.

### Task 4: Error and loading boundaries
- **ACTION**: `app/app/error.tsx` (client, `reset()`), `app/app/loading.tsx`
  skeleton. Wrap the cockpit's slow cards in `<Suspense>` so the fast sections
  and the nav paint immediately.
- **MIRROR**: frontend-patterns — Error Boundary and Suspense/streaming.
- **GOTCHA**: `error.tsx` must be a client component and must not leak the
  digest as the only content — it needs a human sentence and a way out.
- **GOTCHA**: The shell must survive. Today a 500 loses the nav entirely, so the
  operator cannot even navigate away from the broken page.
- **VALIDATE**: cockpit paints its shell and fast cards in <1s while the family
  card streams in.

### Task 5: Sequential reads in `queueSummary`
- **ACTION**: Replace the two `Promise.all` blocks with sequential awaits.
- **MIRROR**: `SEQUENTIAL_READS`.
- **GOTCHA**: Three concurrent reads on a pool of 2 is the same defect already
  measured twice in Phase 3. Once Task 2 lands the reads are cheap, so serial
  costs almost nothing.
- **VALIDATE**: e2e 28/28, wall clock unchanged.

### Task 6: Make the budget a test
- **ACTION**: `e2e/perf.spec.ts` asserting every admin route responds 200 within
  a stated budget.
- **GOTCHA**: A budget test against the production database will be flaky, which
  is the same finding as task #12. Gate it behind the seeded local corpus, or
  mark it `test.slow()` with a generous ceiling and a comment saying the tight
  budget arrives with the local database.
- **VALIDATE**: fails today on cockpit and corporate-families; passes after
  Tasks 1–5.

---

## Validation commands

```bash
pnpm typecheck && pnpm lint && pnpm vitest run
```
```bash
cd apps/web && pnpm test:e2e
```

## Acceptance criteria

- [ ] `/app/admin/cockpit` < 2s warm; `/app/admin/corporate-families` < 2s
- [ ] Registry connection count flat across repeated loads
- [ ] Blackholed seam → 200 with the timeout state, not a 500
- [ ] Every derived number renders its `derived_at`
- [ ] e2e 28/28 (+ the new perf spec), no existing spec edited

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Cached counts read as live | Medium | High | `derived_at` rendered, staleness flagged |
| Nightly job fails, numbers freeze silently | Medium | High | Never write zero; flag stale past threshold |
| Migration on a DB with no ledger | Low | Medium | Additive table only, no backfill |
| Perf budget flaky on production DB | High | Low | Generous ceiling until the local corpus lands |

## Notes

Task 1 is independently shippable in under an hour and fixes a live resource
leak; it does not depend on Task 2. Task 3 is what turns a 500 into a usable
page and is worth doing even if Task 2 slips.
