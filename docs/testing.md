# Testing

Three suites, **three databases**. Getting these confused is how the e2e suite
spent months writing to production.

| Suite | Command | Database | Seeded by |
|---|---|---|---|
| Unit + integration | `pnpm vitest run` | `otn` (local) | each test, inline |
| Browser e2e | `cd apps/web && pnpm test:e2e` | `otn_e2e` (local) | `pnpm db:setup:e2e` |
| — | — | hosted Supabase | **never by a test** |

## First run

```bash
pnpm infra:up && pnpm db:migrate && pnpm db:seed
```
```bash
pnpm db:setup:e2e
```

`db:setup:e2e` drops and recreates `otn_e2e`, bootstraps the `insights` schemas,
migrates, seeds sources/accounts from `config/`, then lays the e2e corpus on
top. It is safe to re-run at any time and is the fastest way out of a confusing
e2e failure.

Between reseeds the database stays deterministic on its own: `e2e/global-setup.ts`
wipes every mutation table the suite writes (feedback, outcomes, corrections,
pursuits and children, invitations and their inbound messages, relationships,
suppressions, action tokens — children before parents) at the start of each run,
so run three sees the same database as run one. Corpus tables are never wiped —
the seeded review cluster's `pending` status is corpus, not mutation. The wipe
sits below the non-local refusal in that file, so it structurally cannot touch
`otn` or production.

## Why three databases and not one

**Production is excluded because tests write.** `apps/web/e2e/app.spec.ts` POSTs
outcomes, corrections, pursuits and feedback, and does not clean them up.
Measured 2026-07-27, before the guard existed: **30 of 30 rows in
`claim_corrections` and 30 of 30 in `opportunity_outcomes` were e2e output** —
100% of both tables. Those feed `delivery/src/roi.ts` (the customer's ROI
scorecard), `delivery/src/pipeline.ts` (the "Won" figure on `/app/pipeline`) and
`intelligence/src/trust.ts`.

It also falsified a recorded finding: the scoring v1.12.0 work concluded the
"our data supports it" premise was false *because all five outcome tables were
empty*. They were not empty; a re-check would have found 30 synthetic wins.

**vitest and e2e are separated for the same reason, one layer down.** The e2e
corpus inserts projects and opportunities that vitest tests then read — seeding
it into `otn` broke `assistant.test.ts`, which asserts a filter returns exactly
one row and got two.

## The guard

`testDatabaseUrl()` and `e2eDatabaseUrl()` live in
[`packages/db/src/test-urls.ts`](../packages/db/src/test-urls.ts) — the package
every harness already depends on.

That location is the fix. The guard has always existed and always been correct;
it lived at the repo root where only vitest imported it, so Playwright ran
without it for months. Both harnesses now reach the same definition through the
same package.

- **vitest** ignores a non-local `DATABASE_URL` and warns, unless
  `ALLOW_REMOTE_TEST_DB=1`.
- **e2e** *refuses to start* on a non-local URL and does **not** honour
  `ALLOW_REMOTE_TEST_DB=1`. A browser suite that POSTs is not something to let
  loose on production with an env var.

## Cleaning up what already leaked

```bash
pnpm purge:e2e-rows
```

Dry-run by default; profiles every table and prints each candidate row.
`--apply` deletes — and refuses entirely if the profile has changed since it
was approved.

Phase 1 (`claim_corrections` 30→0, `opportunity_outcomes` 30→0) was applied
2026-07-28 with owner approval; those sections remain as verification and now
report zero. Phase 2 covers the residue: `feedback` (identified by its cluster
profile — all rows on one opportunity, one user, one window — never by a field,
because none exists), `pursuits` with children first, and the acme-gc
`bid_invitations` with their inbound-message parents.

Needs a human every time: `feedback` is a scoring-calibration input, and the
script's tripwire (refuse `--apply` when feedback spans more than one
opportunity or user) is what keeps the purge safe once real customer feedback
starts arriving.

**Never `pg_dump` production into a fixture.** `/app/admin/corporate-families`
displays real private individuals by design; a filtered dump puts principal
names in the repository.

## Gotchas worth knowing before editing the corpus

- **No natural unique keys.** `projects`, `organizations`, `evidence_items`,
  `project_roles` and `resolution_reviews` have none, so `ON CONFLICT DO
  NOTHING` is a no-op that inserts every time. Use the `ensure()` /
  `ensureRow()` helpers in `seed-e2e.ts`. `project_roles` has no `id` column at
  all.
- **Presence-idempotent is not value-idempotent.** `ensure()` only inserts when
  absent, so editing a fixture value does not reach an already-seeded database.
  Follow with an explicit `UPDATE`, or re-run `db:setup:e2e`.
- **Do not use `permittingJurisdiction: "Test Jurisdiction"`.** Production
  aggregates filter it out (`corporate-family.ts:268`), so league-table and
  rollup assertions would see nothing. Isolation comes from the separate
  database, not a sentinel string.
- **Opportunities are inserted directly, not scored.** Running `scoreAll` would
  make the fixtures a function of the current scoring version, so a weight
  change would rewrite the data the assertions depend on.
- **Review fixtures need a decidable reason.** One of
  `HUMAN_DECIDABLE_REASONS` (`resolution/src/review.ts:242`), or the cluster is
  `awaiting_evidence`, the page renders no decision control, and
  `cluster-reject` is absent.
- **`REGISTRY_DATABASE_URL` is unset for e2e** on purpose, so the cockpit
  exercises its "seam offline" state.
