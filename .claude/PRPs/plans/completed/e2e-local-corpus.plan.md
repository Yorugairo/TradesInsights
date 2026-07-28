# Plan: A local e2e corpus — stop the test suite writing to production

> **STATUS 2026-07-28 — COMPLETE. ARCHIVED.** No PRP report was written, which is why the first close-out pass misfiled this as open. Verified instead against commits and artifacts: T1a `e6e4a42` (purge-e2e-rows CLI, dry-run by default), T2–T5 `7685efa` (suite runs against its own local database), T4 `6f4187f` (mutation POSTs stamped e2e, owner-approved), `0c915b3` (wipe mutation tables at start of run) and `523243c` (otn_e2e migrates itself; wipe list checked against `pg_constraint`). **All 7 declared deliverables present.**


> **COMPLETE 2026-07-28** — Tasks 2-5 shipped (`e6e4a42`, `7685efa`).
> e2e now runs against `otn_e2e`, its own local database: **29/29 in ~25-34s at
> two workers**, twice consecutively, versus 1.3-1.5m at one worker with
> intermittent unrelated failures. `workers: 1` removed; perf budget tightened
> from a 30s placeholder to 5s per route. Docs: [docs/testing.md](../../../docs/testing.md).
>
> **Task 1 (the purge) was APPLIED 2026-07-28 with owner approval**:
> `claim_corrections` 30→0, `opportunity_outcomes` 30→0, verified. Residue
> (`feedback` 58 — profiled as 100% e2e-attributable — `pursuits` 1,
> `bid_invitations` ~1) is planned in
> [post-purge-residue-and-hardening.plan.md](post-purge-residue-and-hardening.plan.md).
>
> **One thing the plan did not anticipate: three databases, not two.** The
> corpus first went into vitest's `otn` and broke `assistant.test.ts` (asserts a
> filter returns one row, got two). Same "one suite writes what another reads"
> defect, one layer down, so it got the same answer rather than a tuned corpus.
>
> Four other surprises, all now documented in `docs/testing.md`: five of the
> tables have no natural unique key (so `ON CONFLICT DO NOTHING` silently
> duplicates, and `project_roles` has no `id` at all); dotenv resolved `.env`
> from cwd so Playwright missed `PG_PORT` and hit a different Postgres; a fresh
> database has no `insights` schema so the first migration silently populated
> `public`; and a review fixture needs a reason from `HUMAN_DECIDABLE_REASONS`
> or no `cluster-reject` control renders.

## Summary

The e2e suite runs against the hosted production database and **writes to it**.
Measured 2026-07-27: `claim_corrections` holds 30 rows and **all 30 are e2e
fixtures**; `opportunity_outcomes` holds 30 rows and **all 30 are the same
synthetic `won` / not-influenced row**. Those two tables feed the customer's ROI
scorecard, the Pipeline page, and trust scoring. This plan builds a deterministic
local corpus, points e2e at it, purges the contamination, and restores parallel
workers.

## User story

As the person who has to trust the numbers this product shows customers, I want
the test suite to run against its own database, so that "we won 30 jobs" is a
fact about the business and not a side effect of running `pnpm test:e2e` thirty
times.

## Problem → Solution

e2e asserts against, and mutates, live production data → e2e owns a seeded local
corpus; production is never written by a test.

## Metadata

- **Complexity**: Large
- **Source PRD**: N/A — carried forward from
  `cockpit-seam-performance-and-degradation.plan.md` ("Still open")
- **Estimated files**: 8

---

## Value — why this is worth doing

### 1. It is currently fabricating production data (the real reason)

Measured against the production database on 2026-07-27:

| Table | Total rows | Written by e2e | Read by |
|---|---|---|---|
| `claim_corrections` | 30 | **30 (100%)** | `intelligence/src/trust.ts` |
| `opportunity_outcomes` | 30 | **30 (100%)**, all `won`, all `influenced_by_otn = false` | `delivery/src/roi.ts:86`, `delivery/src/pipeline.ts:64` |
| `feedback` | 58 | 3 per run | scoring calibration |
| `account_suppressions` | 0 with `reason='e2e'` | cleaned up correctly | — |

The outcomes row is created by `app.spec.ts:219` and **never deleted**. The
correction is created by `app.spec.ts:225`, and the test's own comment calls it
"Admin-only **immutable** correction" — it cannot be deleted by design.

Three consequences, in increasing order of seriousness:

- **The Pipeline page I retrofitted this session reads these rows.**
  `pipelineSummary` counts `won` from `opportunity_outcomes`. Every headline on
  `/app/pipeline` for that account is partly test output.
- **The ROI scorecard shown to customers reads them** (`roi.ts:86`).
- **It has already falsified a recorded finding.** The scoring v1.12.0 work
  concluded that the "our data supports it" premise was FALSE because *all five
  outcome tables were empty*. They are not empty now. Anyone re-checking that
  premise finds 30 wins and reaches the opposite conclusion from synthetic data.

That last one is the argument. A test suite that quietly manufactures evidence
is worse than a slow one, and no amount of `workers: 1` addresses it.

### 2. It makes the gate mean something

Measured across this session's runs of the same unchanged suite: 28/28 in 1.2m,
and 9-of-21 failed in 4.7m. Failures were login POSTs not returning, `/app/radar`
not navigating, and the cockpit hitting `statement_timeout` — none related to the
code under test. A gate that can report nine failures for environmental reasons
cannot distinguish a dropped `data-testid` from a bad afternoon, which is exactly
the safety argument the Phase 3 retrofit rested on.

### 3. It unlocks three things currently blocked

- **`workers: 1` can go.** It is a compensating control for a 2-connection pool,
  costing ~40s a run and, more importantly, meaning.
- **The perf budget can be tightened.** `e2e/perf.spec.ts` currently uses a 30s
  ceiling with a comment saying it is loose because the numbers move with WAN
  latency. Against a local corpus it can assert the real budget (~2s) and catch
  a regression the day it lands rather than the month it is noticed.
- **Two agents can run the suite at once.** Today they clobber each other's
  writes in shared tables.

### What it costs

One work session to author the corpus, plus a one-off production cleanup. The
corpus is a fixture file, not a system — no new service, no new dependency.

### What happens if it is not done

The contamination grows by one correction, one outcome and three feedback rows
per run, in tables nothing prunes, feeding customer-facing numbers.

---

## UX Design

Internal change — no user-facing UX transformation. The one visible effect is
that customer-facing ROI and Pipeline figures stop including test rows, i.e.
they get *smaller* and *correct*.

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `vitest.test-db.ts` | 1-66 | `testDatabaseUrl()` — the exact guard to reuse |
| P0 | `apps/worker/test/helpers.ts` | 33-106 | `testDb`, `resetSource`, `deleteTestProjects` |
| P0 | `packages/db/src/seed.ts` | 1-207 | Idempotent-upsert seeding style to mirror |
| P0 | `apps/web/e2e/app.spec.ts` | all | Every assertion the corpus must satisfy |
| P1 | `apps/worker/test/digest.test.ts` | 60-90 | Inline project/source-record fixture shape |
| P1 | `apps/web/playwright.config.ts` | all | `webServer`, `workers`, the notes to delete |
| P2 | `packages/db/src/schema.ts` | — | Table names; several differ from the obvious guess |

## External documentation

No external research needed — this uses established internal patterns only.

---

## Patterns to mirror

### LOCAL_DB_GUARD
```ts
// SOURCE: vitest.test-db.ts:56-66
export function testDatabaseUrl(): string {
  const configured = process.env.DATABASE_URL;
  if (!configured) return LOCAL_TEST_DB;
  const isLocal = /localhost|127\.0\.0\.1/.test(configured);
  if (isLocal || process.env.ALLOW_REMOTE_TEST_DB === "1") return configured;
  console.warn(
    "[vitest] DATABASE_URL is non-local — tests run against the LOCAL Docker DB instead " +
      "(set ALLOW_REMOTE_TEST_DB=1 to override; tests truncate data and must not touch production).",
  );
  return LOCAL_TEST_DB;
}
```
This already exists and already does the right thing — **the e2e suite simply
never called it.** That is the whole bug in one sentence.

### IDEMPOTENT_SEED
```ts
// SOURCE: packages/db/src/seed.ts:18-37
const [row] = await db
  .insert(sources)
  .values({ key: s.key, name: s.name, /* … */ })
  .onConflictDoUpdate({ target: sources.key, set: { enabled: s.enabled } })
  .returning({ id: sources.id });
```

### FIXTURE_PROJECT
```ts
// SOURCE: apps/worker/test/digest.test.ts:64-73
.insert(projects)
.values({
  canonicalName: name,
  permittingJurisdiction: "Test Jurisdiction",
  county: "Thurston",
  currentStage: "permit_applied",
  firstSeenAt: new Date(),
  lastSeenAt: new Date(),
})
```

### PRODUCTION_EXCLUSION_SENTINEL
```sql
-- SOURCE: packages/intelligence/src/corporate-family.ts:268
AND p.permitting_jurisdiction != 'Test Jurisdiction'
```

### PREFLIGHT_FAIL_FAST
```ts
// SOURCE: vitest.global-setup.ts:53-66
if (!reachable) {
  throw new Error([
    "", `  The test database is not reachable at ${host}:${port}.`, "",
    "  Start it with:   pnpm infra:up", "",
  ].join("\n"));
}
```

---

## Files to change

| File | Action | Justification |
|---|---|---|
| `packages/db/src/seed-e2e.ts` | CREATE | The corpus |
| `packages/db/package.json` | UPDATE | `seed:e2e` script |
| `package.json` | UPDATE | Root `db:seed:e2e` passthrough |
| `apps/web/playwright.config.ts` | UPDATE | Local DSN in `webServer.env`; restore workers |
| `apps/web/e2e/global-setup.ts` | CREATE | Reachability preflight + corpus freshness |
| `apps/web/e2e/perf.spec.ts` | UPDATE | Tighten the budget |
| `apps/worker/src/cli/purge-e2e-rows.ts` | CREATE | One-off production cleanup |
| `docs/testing.md` | UPDATE | Document the two databases |

## NOT building

- A general-purpose fixture factory or ORM-level factory library. One corpus
  file, shaped by the assertions that exist today.
- Any change to an e2e assertion. The corpus adapts to the tests, never the
  reverse.
- Production data copying. See the risk table.
- Registry-seam fixtures. `REGISTRY_DATABASE_URL` stays unset for e2e, which
  exercises the "seam offline" path — a state worth covering anyway.

---

## Step-by-step tasks

### Task 1: Purge the contamination from production (do this first)
- **ACTION**: `apps/worker/src/cli/purge-e2e-rows.ts`, dry-run by default,
  `--apply` to commit. Deletes `claim_corrections WHERE reason = 'e2e'`,
  `opportunity_outcomes` rows matching the e2e signature, and `feedback` rows
  matching the e2e notes.
- **GOTCHA**: **Print counts and require `--apply`.** This deletes production
  rows; a script that does it on import is how a cleanup becomes an incident.
- **GOTCHA**: `opportunity_outcomes` has no `reason` column. Identify e2e rows by
  their exact signature (`outcome_type='won' AND influenced_by_otn = false`)
  **cross-checked against `created_at` clustering near known e2e runs** — and
  print the candidate rows for a human to confirm before `--apply`. Do not
  delete on the signature alone; a real customer win looks identical.
- **GOTCHA**: `claim_corrections` is documented as immutable. Deleting from it
  needs the owner's explicit say-so even though every row is synthetic. Ask.
- **VALIDATE**: dry-run output reviewed by the owner; after `--apply`, the ROI
  scorecard and `/app/pipeline` show the real (smaller) numbers.

### Task 2: Author the corpus
- **ACTION**: `packages/db/src/seed-e2e.ts`, idempotent, running after
  `db:migrate` and `db:seed`. It must satisfy, exactly:

  | Assertion | Source | Corpus requirement |
  |---|---|---|
  | `all.total > all.items.length` at `limit=5` | `app.spec.ts:233` | ≥ 6 opportunities for `solis_interiors` |
  | every Pierce item has `county = "Pierce"` | `:238` | ≥ 1 Pierce opportunity |
  | search `"tenant improvement"` matches | `:243` | ≥ 1 project whose name or jurisdiction contains "tenant" |
  | `opportunities-table` has rows | `:54, :251` | as above |
  | map renders an SVG `path` | `:262` | ≥ 1 `lacey_glass_commercial` project with non-null `projects.geometry` |
  | `geometry-coverage-table` contains "King" | `:357` | ≥ 1 King-county project with geometry |
  | `sources-table` > 10 rows | `:347` | **free** — `db:seed` loads 38 from `config/sources.yaml` |
  | `coverage.items.length > 10` | `:353` | **free** — seeded per source |
  | `cluster-reject` count > 0 | `:369` | ≥ 1 pending `resolution_reviews` cluster |
  | `league.items.length > 0` at `min=2` | `:284` | ≥ 1 organization with roles on ≥ 2 projects |
  | `scorecard.unsupportedFactCount === 0` | `:200` | every evidence item cited and graded |
  | `roi.leadTime.measured` is a number | `:269` | ≥ 1 project with the events lead-time needs |
  | detail page §16 sections | `:57-101` | 1 opportunity with extraction, gate, evidence, timeline, roles |

- **MIRROR**: `IDEMPOTENT_SEED`, `FIXTURE_PROJECT`.
- **GOTCHA**: **Do NOT use `permittingJurisdiction: "Test Jurisdiction"`.**
  `corporate-family.ts:268` filters it out of rollups, and other aggregates do
  the same. The vitest fixtures use it deliberately to stay invisible; the e2e
  corpus must be *visible* to those aggregates or the league-table and rollup
  assertions fail. Use real jurisdictions and isolate by database instead.
- **GOTCHA**: `projects.geometry` is PostGIS. Insert via
  `ST_SetSRID(ST_MakePoint(lon, lat), 4326)`, not a bare literal.
- **GOTCHA**: Opportunities are normally produced by the scorer. Insert them
  directly with explicit `current_score` and `state` rather than running
  `scoreAll` — the corpus must be deterministic, and a scorer change must not
  silently rewrite the fixtures the assertions depend on.
- **GOTCHA**: Scores must straddle the band thresholds (80 / 65) so the
  band control, the StatTiles and `ScoreBar` all have something to show.
- **VALIDATE**: `pnpm db:seed:e2e` twice in a row produces identical row counts.

### Task 3: Point e2e at the local database
- **ACTION**: `playwright.config.ts` `webServer.env` sets `DATABASE_URL` from a
  shared `testDatabaseUrl()`. Add `e2e/global-setup.ts` doing the TCP preflight
  and asserting the corpus is present.
- **MIRROR**: `LOCAL_DB_GUARD`, `PREFLIGHT_FAIL_FAST`.
- **GOTCHA**: `webServer.env` **replaces** rather than merges in some Playwright
  versions — spread `process.env` explicitly or the app loses `AUTH_SECRET`.
- **GOTCHA**: Leave `REGISTRY_DATABASE_URL` unset. The cockpit then renders
  "seam offline", which is a state worth asserting.
- **GOTCHA**: The preflight must fail with the corpus's name, not a stack trace —
  a missing corpus should read as "run `pnpm db:seed:e2e`".
- **VALIDATE**: with Docker stopped, `pnpm test:e2e` fails in seconds with a
  legible message rather than 29 timeouts.

### Task 4: Restore parallel workers and tighten the budget
- **ACTION**: Delete `workers: 1` and its comment block. Lower `perf.spec.ts`
  `BUDGET_MS` from 30s to a real ceiling and drop the WARMUP allowance.
- **GOTCHA**: The local pool max may also be 2. Raise it for the test DSN, or
  keep 2 workers rather than defaulting to CPU count.
- **GOTCHA**: Parallel workers share one database. Any test that mutates shared
  state needs its own account or a unique key — the invitation test already does
  this with a stable `Message-ID`.
- **VALIDATE**: 29/29 green three times consecutively; wall clock down.

### Task 5: A test that stops this recurring
- **ACTION**: Assert in `global-setup.ts` that the resolved `DATABASE_URL` is
  local unless `ALLOW_REMOTE_TEST_DB=1`, and **fail the run** otherwise.
- **GOTCHA**: This is the whole point. `testDatabaseUrl()` has existed and been
  correct the entire time; nothing forced e2e to call it. Make the omission
  impossible rather than documented.
- **VALIDATE**: pointing `DATABASE_URL` at the hosted DSN fails the run
  immediately with an explanatory message.

---

## Testing strategy

### Unit tests

| Test | Input | Expected | Edge? |
|---|---|---|---|
| corpus is idempotent | seed twice | identical counts | — |
| corpus satisfies band spread | seeded rows | ≥1 above 80, ≥1 between 65-79 | ✓ |
| purge script dry-run | production DSN | prints counts, deletes nothing | ✓ |
| local guard | hosted DSN, no override | throws | ✓ |
| local guard | `ALLOW_REMOTE_TEST_DB=1` | permits | ✓ |

### Edge cases
- [ ] Docker down → legible failure, not 29 timeouts
- [ ] Migrations not applied → named failure
- [ ] Corpus absent → "run `pnpm db:seed:e2e`"
- [ ] Two suites concurrently → both green
- [ ] `REGISTRY_DATABASE_URL` unset → cockpit "seam offline", still 200

---

## Validation commands

```bash
pnpm infra:up && pnpm db:migrate && pnpm db:seed && pnpm db:seed:e2e
```
```bash
cd apps/web && pnpm test:e2e
```
```bash
pnpm typecheck && pnpm lint && pnpm vitest run
```

### Manual validation
- [ ] Purge dry-run reviewed and approved by the owner before `--apply`
- [ ] `/app/pipeline` and `/app/roi` show real numbers after the purge
- [ ] e2e green with production credentials absent from the environment

---

## Acceptance criteria

- [ ] e2e reads and writes **only** the local database
- [ ] Pointing it at production fails the run rather than proceeding
- [ ] `workers: 1` removed; 29/29 green three times consecutively
- [ ] Perf budget tightened to a real ceiling
- [ ] Production `claim_corrections` / `opportunity_outcomes` purged of e2e rows
- [ ] No e2e assertion weakened or reworded

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Purge deletes a real customer outcome | Low | **High** | Dry-run, human review, owner sign-off; never delete on signature alone |
| Corpus drifts from assertions as tests grow | High | Medium | Task 5's preflight names the missing fixture |
| Fixture data leaks into a production aggregate | Low | High | Separate database, not a sentinel jurisdiction |
| Parallel workers reintroduce contention | Medium | Low | Raise local pool max; cap workers at 2 if not |
| Tempting shortcut: `pg_dump` production into a fixture | Medium | **High** | **Forbidden.** The corporate-families page displays real private individuals; a filtered dump puts principal names in the repository |

## Notes

Task 1 is separable and urgent — the contamination grows by one correction, one
outcome and three feedback rows per run, and it is already 100% of two tables.
It can ship before any of the test work.

The most uncomfortable detail: `testDatabaseUrl()` already existed, already
carried the correct guard, and already printed a warning when someone pointed
tests at production. The e2e suite simply never called it. The fix is less about
building something new than about closing a door that was left open.
