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

Dry-run by default; profiles every distinct outcome shape and prints each
candidate row. `--apply` deletes.

Needs a human first: `opportunity_outcomes` has no `reason` column and
`created_by` is stamped from the session, so no single field separates a test
row from a real win. What identifies them is the combination — one bare shape,
one `opportunity_id`, clustered inside known e2e runs. `claim_corrections` is
documented as immutable, so deleting from it is an owner decision even though
every row is synthetic.

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
