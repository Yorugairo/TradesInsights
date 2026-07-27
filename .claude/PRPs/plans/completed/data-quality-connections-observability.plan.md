# Plan: Data Quality, Connections, and Observability (Phases 1, 2, 3, 5)

## Summary

Three defects and one gap, all surfaced by the 2026-07-27 session. `project_events` carries 2,997 surplus rows because `emitEvent` is a bare insert into a table with no unique constraint. The review queue holds 2,505 rows with no drain, and pass 1b now routes enrichment records into it. 3,882 Google Place observations are staged but unconsumed. And `resolveUnresolved` counts its errors without storing them, so failures are unrecoverable after the run.

## User Story

As the operator of the Insights pipeline, I want event writes to be idempotent, the review queue to clear itself when new evidence arrives, staged connections to land, and resolver failures to survive the run — so that scoring inputs are trustworthy and enrichment converts into bindings instead of queue depth.

## Problem → Solution

Enrichment currently accumulates as unresolved queue depth and duplicated events, and failures vanish → evidence-driven re-evaluation drains the queue, a unique index makes event writes idempotent (and `resolveRecord` retry-safe), and errors become durable and alertable.

## Metadata

- **Complexity**: Large (Phase 2 dominates)
- **Source PRD**: N/A — free-form, from the `/plan` session of 2026-07-27
- **PRD Phase**: N/A
- **Estimated Files**: ~12
- **Repo / branch**: `C:\Users\Snipe\Downloads\TradesInsights`, `claude/tmux-install-320aiz`

---

## Measurements already taken (do not re-derive)

Taken against `arbmeioglflvzoffgtii`, schema `insights`, 2026-07-27.

### Phase 1 — the diagnosis is DONE, and it says "real duplicates"

| Metric | Value |
|---|---|
| duplicate groups on `(project_id, source_record_id, event_type, event_date)` | 2,952 |
| surplus rows | 2,997 of 44,074 total (6.8%) |
| groups where **`observed_at` is identical** (same write ⇒ true duplicate) | **2,816** |
| groups where `observed_at` differs (legitimate `applyRecordUpdates` re-emit) | 136 |
| groups byte-identical incl. `prior_stage`/`resulting_stage`/`material_change` | 2,661 |
| worst group size | 3 |

**Verdict: ~95% are true duplicates.** Task 1.1 (the diagnosis gate) is satisfied — proceed to dedupe + constraint. The 136 differing-`observed_at` groups are legitimate and the unique key **must include `observed_at`** so they survive.

### Phase 2 — queue composition

| Rule / reason | n | distinct sources | oldest |
|---|---|---|---|
| `proximity_org` / `fuzzy_without_parcel_or_org_support` | 1,605 | 8 | 2026-07-21 |
| `address_name` / `same_address_name_mismatch` | 784 | 14 | 2026-07-21 |
| `parcel_overlap` / `conflicting_jurisdiction` | 52 | 5 | 2026-07-21 |
| `address_name` / `generic_name` | 33 | 1 | 2026-07-22 |
| `proximity_org` / `generic_name` | 23 | 2 | 2026-07-21 |
| `address_name` / `multiple_address_candidates` | 7 | 1 | 2026-07-22 |
| `parcel_overlap` / `multiple_parcel_candidates` | 1 | 1 | 2026-07-21 |
| **total** | **2,505** | | |

### Phase 3 — staging state

`registry_partner.partner_observations`, `observation_type = 'google_place_confirmation'`: 7,460 rows total; **3,882 with `applied_at IS NULL`** (every unapplied row in the whole table is one of these); 3,578 with `payload->>'name_basis' IS NULL` (all of which ARE applied). Review tiers among the staged batch: 3,012 `exact`@0.95, **840 `contained`@0.9**, 8 `close`@0.95, 22 contested@0.4 (12 exact + 10 contained).

### Phase 5 — one stated blocker does not exist

`packages/resolution/package.json` already declares `"@otn/db": "workspace:*"`, and `resolver.ts:2-13` imports tables and `type Db` from it. **`withConnectionRetry` (`packages/db/src/retry.ts:80`) can be imported into `packages/resolution` today with no dependency change.** The note that this was "blocked on the `@otn/db` dependency question" was wrong.

---

## UX Design

**Internal change — no user-facing UX transformation.** The only externally visible effects are indirect: fewer duplicate events feeding velocity/stage-lag/corroboration, and opportunities gaining named contractors as reviews clear.

| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Admin review queue | 2,505 rows, no drain | Rows clear automatically when new evidence resolves them | Only on strong verdicts; ambiguous rows still wait for a human |
| `maintenance:run` log | `resolved.errors: 15` (a bare count) | `errors: [{sourceRecordId, error}]` + an alert row | Mirrors `BulkDecisionSummary.errors` |
| `pnpm lint` | 97 errors, all from `.worktrees/` | clean | |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `packages/db/migrations/0033_opportunity_evidence_indexes.sql` | all | **Exact precedent for Phase 1**: a table missing the UNIQUE index its `ON CONFLICT` writer needs. Mirror its reasoning and comment density. |
| P0 | `packages/resolution/src/resolver.ts` | 258-280 (`emitEvent`), 291-332 (`mergeIntoProject`), 484-620 (`resolveRecord`), 526-560 (pass 1b) | The write path being made idempotent, and where a preview must diverge from a write |
| P0 | `packages/resolution/src/review.ts` | 120-160 (`decideReview` reject → re-resolve), 305-400 (`triageReviewQueue`), 343-412 (`decideReviewCluster`) | Reuse targets for Phase 2; `BulkDecisionSummary.errors` at :350 is the shape Phase 5 mirrors |
| P1 | `packages/db/src/schema.ts` | 241-260 (`projectEvents`) | Column nullability — `event_date` is NULLABLE, which drives the Phase 1 gotcha |
| P1 | `packages/db/src/retry.ts` | 80+ (`withConnectionRetry`) | Phase 5 retry helper |
| P1 | `packages/resolution/src/google-place-rescore.ts` | 180-230 (`recordGooglePlaceConfirmations`) | Phase 3/5 write loop |
| P1 | `apps/worker/src/cli/google-place-rescore.ts` | 62-90 | How `withConnectionRetry` + `onRetry` logging is already wired at a call site |
| P2 | `apps/worker/test/resolution.test.ts` | 1-130 (harness), 480-700 (pass 1b block) | Test harness, twin-source setup, teardown |
| P2 | `packages/source-sdk/src/runner.ts` | 141, 350, 385 | `deadLetters` accumulation + persistence into `source_runs.metrics_json` |
| P2 | `eslint.config.mjs` | 5-17 | `ignores` array for Phase 5.3 |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| Postgres `NULLS NOT DISTINCT` | PostgreSQL 15 release notes | Required for a unique index over a nullable column to treat two NULLs as equal. Supabase runs PG15+, so this is available — but **verify before relying on it** (`SHOW server_version`). |

No other external research needed — everything else uses established internal patterns.

---

## Patterns to Mirror

### MIGRATION_STYLE — explain WHY the constraint is needed, with live numbers
```sql
-- SOURCE: packages/db/migrations/0033_opportunity_evidence_indexes.sql:1-16
-- Opportunity payload, Phase 2 — give `opportunity_evidence` the UNIQUE index
-- its writer needs.
--
-- The table has existed since 0000_init with two foreign keys and one plain
-- index ... but NO UNIQUE INDEX and no primary key.
--
-- ... Its write path is INSERT ... ON CONFLICT DO NOTHING, and ON CONFLICT
-- REQUIRES A UNIQUE INDEX to name as its arbiter — without one the statement
-- does not merely duplicate rows, it fails outright.
```
Migrations are numbered `NNNN_snake_case.sql` in `packages/db/migrations/`; next free number is **0035**. They are excluded from eslint (`eslint.config.mjs:13`). Unqualified DDL lands in `insights` via the `search_path` in `packages/db/drizzle.config.ts:8-14`.

### SCHEMA_TABLE_DEFINITION
```ts
// SOURCE: packages/db/src/schema.ts:241-260
export const projectEvents = pgTable(
  "project_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id").notNull().references(() => projects.id),
    sourceRecordId: uuid("source_record_id").notNull().references(() => sourceRecords.id),
    eventType: text("event_type").notNull(),
    eventDate: timestamp("event_date", { withTimezone: true }),   // ← NULLABLE
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    // ...
  },
  (t) => [
    index("project_events_project_ix").on(t.projectId, t.eventDate),
    index("project_events_type_ix").on(t.eventType),
  ],
);
```

### ERROR_DETAIL_SHAPE — carry the id alongside the message
```ts
// SOURCE: packages/resolution/src/review.ts:343-350
export interface BulkDecisionSummary {
  matched: number;
  decided: number;
  // ...
  errors: { reviewId: string; error: string }[];
}
// ...and at :409
summary.errors.push({ reviewId: id, error: String(err) });
```
This is the in-repo precedent Phase 5.1 mirrors: an error list of `{id, error}`, collected per row, never aborting the batch.

### DEAD_LETTER_PERSISTENCE
```ts
// SOURCE: packages/source-sdk/src/runner.ts:141, 350, 385
const deadLetters: DeadLetterEntry[] = [];
// ...
deadLetters.push(entry);
// ...
metricsJson: { ...metrics, deadLetters, invariantViolationDetails },
```

### RETRY_AT_A_CALL_SITE
```ts
// SOURCE: apps/worker/src/cli/google-place-rescore.ts:68-76
const onRetry = (attempt: number, err: unknown) =>
  logger.info(
    { attempt, err: String(err) },
    "transient connection fault reading the registry contract — retrying",
  );

const observations = await withConnectionRetry(() => loadGooglePlaceScrapeRows(registryPool), {
  onRetry,
});
```

### LOGGING_PATTERN — one structured summary object per step
```ts
// SOURCE: packages/resolution/src/resolver.ts:644
opts.logger?.info(summary, "resolution run complete");
```
pino JSON; the summary object IS the log payload. Steps in `runMaintenance` each emit one line and are collected into a final `pipeline maintenance complete` object (`apps/worker/src/schedules.ts:225-240`).

### TEST_STRUCTURE — real Postgres, RUN-unique fixtures, explicit teardown
```ts
// SOURCE: apps/worker/test/resolution.test.ts:45-46, 103-110
const RUN = randomUUID().slice(0, 8).toUpperCase();
// ...
beforeAll(async () => {
  ({ db, pool } = await testDb());
  sourceId = await resetSource(db, "fake_source");
```
Tests run against the LOCAL docker Postgres — `vitest.config.ts` ignores a non-local `DATABASE_URL` unless `ALLOW_REMOTE_TEST_DB=1`. **`PG_PORT=5433` on this machine** (a native Postgres shadows 5432).

### CLI_STRUCTURE
```ts
// SOURCE: apps/worker/src/cli/maintenance-run.ts:1-14
import "../load-env.js";
import { createLogger } from "@otn/source-sdk";
// ... async function main() { ... }
main().catch((err) => { console.error(err); process.exit(1); });
```
Registered in `apps/worker/package.json` scripts as `"name:verb": "tsx src/cli/<file>.ts"`, then re-exported at the root `package.json` as `pnpm --filter @otn/worker <script>`.

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `packages/db/migrations/0035_project_events_unique.sql` | CREATE | Dedupe + unique index (Phase 1) |
| `packages/db/src/schema.ts` | UPDATE | Add the unique index to `projectEvents` so drizzle matches the DB |
| `packages/resolution/src/resolver.ts` | UPDATE | `emitEvent` → `ON CONFLICT DO NOTHING`; `resolveUnresolved` error detail (Phase 1, 5) |
| `packages/resolution/src/review.ts` | UPDATE | `previewResolution` + `reevaluatePendingReviews` (Phase 2) |
| `packages/resolution/src/index.ts` | UPDATE | Export the new Phase 2 functions |
| `apps/worker/src/cli/review.ts` | UPDATE | `pnpm review reevaluate [--apply]` subcommand |
| `apps/worker/src/schedules.ts` | UPDATE | Call re-evaluation in `runMaintenance`; surface resolver errors |
| `packages/resolution/src/google-place-rescore.ts` | UPDATE | Retry the insert loop (Phase 5.2) |
| `apps/worker/src/cli/google-place-rescore.ts` | UPDATE | `--restage` flag to backfill `name_basis` (Phase 3.2) |
| `apps/worker/test/resolution.test.ts` | UPDATE | Event idempotency tests |
| `apps/worker/test/review.test.ts` | UPDATE | Re-evaluation tests |
| `eslint.config.mjs` | UPDATE | Ignore `.worktrees/` (Phase 5.3) |
| `docs/architecture.md`, `docs/STATUS.md` | UPDATE | Decisions of record |

## NOT Building

- **No change to matching thresholds.** No lowering of fuzzy scores, no timeout-based auto-accept, no "stale review = accept". Re-evaluation acts only on a *strong* verdict from unchanged logic.
- **No automatic decision on `same_address_name_mismatch` (784).** Task 2.5 MEASURES the containment collapse and reports; behaviour change is a separate, owner-gated decision.
- **No registry-side loader work.** The consumer of `partner_observations` lives in the OneTradeNetwork tree. This plan stages and reports; landing is cross-repo (see Risks).
- **No repair of historical mis-merges** beyond the 46 already remediated.
- **No PALS throughput work** — Phase 4 is owner-run as a separate 45-per-8-hour experiment.
- **No new `resolution_errors` table.** Phase 5.1 uses the existing alert machinery (alternative considered and rejected as over-build for ~15 rows/run).

---

## Step-by-Step Tasks

### Task 1.1: Confirm the duplicate diagnosis on the LOCAL db before writing DDL
- **ACTION**: Re-run the diagnosis query (above) against the local docker Postgres so the migration is developed against a reproducible fixture, and record `SHOW server_version`.
- **IMPLEMENT**: The `WITH d AS (...) SELECT ... count(DISTINCT observed_at)` query from *Measurements already taken*.
- **GOTCHA**: The production numbers are already known — this step is to confirm **PG ≥ 15** so `NULLS NOT DISTINCT` is available. If PG < 15, switch the index expression to `coalesce(event_date, 'epoch'::timestamptz)`.
- **VALIDATE**: `SHOW server_version` ≥ 15, and the local query returns a non-null result.

### Task 1.2: Migration `0035_project_events_unique.sql`
- **ACTION**: Delete surplus rows keeping the lowest `id` per group, then create the unique index.
- **IMPLEMENT**:
  ```sql
  DELETE FROM project_events pe USING (
    SELECT id, row_number() OVER (
      PARTITION BY project_id, source_record_id, event_type, event_date, observed_at
      ORDER BY id) AS rn
    FROM project_events) d
  WHERE pe.id = d.id AND d.rn > 1;

  CREATE UNIQUE INDEX project_events_dedupe_ux
    ON project_events (project_id, source_record_id, event_type, event_date, observed_at)
    NULLS NOT DISTINCT;
  ```
- **MIRROR**: `MIGRATION_STYLE` — lead with why, cite the live numbers (2,816 same-`observed_at` groups vs 136 legitimate re-emits), and state what the constraint protects.
- **GOTCHA (critical)**: `observed_at` **must** be in the key. Omit it and the 136 legitimate `applyRecordUpdates` re-emits are destroyed. `event_date` is nullable, hence `NULLS NOT DISTINCT`.
- **GOTCHA**: Deleting by `rn > 1` keeps the lowest `id`; since `id` is a random uuid this is arbitrary but the rows are byte-identical in 2,661 of 2,816 cases, and the remainder differ only in stage fields where the earliest write is the correct one.
- **VALIDATE**: `pnpm db:migrate`, then re-run the diagnosis query — expect `dup_groups = 136` (the legitimate re-emits, which now differ on `observed_at` and so are no longer counted by the old 4-column grouping... re-check with the 5-column grouping, which must return **0**).

### Task 1.3: Make `emitEvent` idempotent
- **ACTION**: Add `.onConflictDoNothing()` to the insert.
- **IMPLEMENT**: `await db.insert(projectEvents).values({...}).onConflictDoNothing();`
- **MIRROR**: The `ON CONFLICT DO NOTHING` convention already used by `recordGooglePlaceConfirmations` (`google-place-rescore.ts`, keyed on `dedupe_key`).
- **IMPORTS**: none new.
- **GOTCHA**: `ON CONFLICT` requires the unique index from 1.2 to exist. Ship them together; a deploy with 1.3 but not 1.2 is a silent no-op, and 1.2 without 1.3 leaves the write able to *fail* rather than dedupe.
- **VALIDATE**: New test — call `resolveRecord` twice on the same record; `project_events` count unchanged the second time.

### Task 1.4: Update the drizzle schema to match
- **ACTION**: Add `uniqueIndex("project_events_dedupe_ux")` to the `projectEvents` index array.
- **MIRROR**: `SCHEMA_TABLE_DEFINITION`.
- **IMPORTS**: `uniqueIndex` from `drizzle-orm/pg-core` (check whether already imported in `schema.ts`).
- **GOTCHA**: Drizzle has no first-class `NULLS NOT DISTINCT`; if it cannot express it, leave the index DB-only and add a comment in `schema.ts` pointing at migration 0035 so the drift is documented rather than silent.
- **VALIDATE**: `pnpm --filter @otn/db typecheck`.

---

### Task 2.1: `previewResolution` — what would the resolver decide today, without writing
- **ACTION**: Add a read-only sibling to `resolveRecord` in `resolver.ts` that runs the match passes and returns the would-be outcome, performing NO writes.
- **IMPLEMENT**: `export async function previewResolution(db, row, opts?): Promise<{ rule: MatchedRule | null; projectId: string | null; wouldReview: boolean }>` — call `matchByIds`, then `pendingReviewForSamePermit`, then `matchByParcels`, then `evaluateFuzzy`, returning at the first decisive answer. Do not call `mergeIntoProject`, `persistResolution`, `createProject`, or insert reviews.
- **MIRROR**: The pass order in `resolveRecord` (`resolver.ts:484-620`) exactly — this is the same decision tree with the writes removed.
- **GOTCHA**: Keep the pass order identical to `resolveRecord` or preview and apply will disagree. Consider extracting the shared pass sequence so it cannot drift; if extraction is too invasive, add a test asserting preview and apply agree on a fixture set.
- **VALIDATE**: Test — for a record that resolves on `official_id`, preview returns that rule and `project_events` gains no rows.

### Task 2.2: `reevaluatePendingReviews`
- **ACTION**: Add to `review.ts`. For every pending review, run `previewResolution`; act only when the verdict is a STRONG rule.
- **IMPLEMENT**:
  ```ts
  export interface ReevaluateSummary {
    scanned: number; resolved: number; stillAmbiguous: number;
    byRule: Record<string, number>;
    errors: { reviewId: string; error: string }[];
  }
  export async function reevaluatePendingReviews(
    db: Db, opts: { apply?: boolean; limit?: number; logger?: ... },
  ): Promise<ReevaluateSummary>
  ```
  Strong = `official_id` or `explicit_reference` **only**. On a strong verdict, decide the review through the existing `decideReview` path so provenance (`decided_by`, `decided_at`, note) is recorded identically to a human decision; set `decidedBy` to a machine identity such as `system/reevaluation`.
- **MIRROR**: `ERROR_DETAIL_SHAPE` for `errors`; `decideReviewCluster` (`review.ts:343-412`) for "loop, collect per-row errors, never abort the batch".
- **GOTCHA**: **Default to dry-run.** `apply` must be opt-in, matching `strict-bind:preview` / `--apply` and `google-place-rescore:preview` / `:apply`.
- **GOTCHA**: A parcel or fuzzy verdict is NOT strong enough — those are exactly the guesses the review exists to question. Restricting to `official_id`/`explicit_reference` is what makes this "positive new evidence" rather than a lowered bar.
- **GOTCHA**: This is precisely what would have cleared today's 46 rows without a one-off script. Use those as the design reference case.
- **VALIDATE**: Dry-run on production reports a plausible count; test asserts a held twin auto-clears once its sibling gains a project, and that an unchanged ambiguous review is left alone.

### Task 2.3: Wire into the CLI
- **ACTION**: Add `pnpm review reevaluate [--apply] [--limit N]`.
- **MIRROR**: `apps/worker/src/cli/review.ts` command dispatch (`list` / `triage` / `bulk` / `decide` / `undo`) and its `flag(name)` helper.
- **VALIDATE**: `pnpm review reevaluate` runs read-only and prints a summary.

### Task 2.4: Wire into the nightly chain
- **ACTION**: Call `reevaluatePendingReviews(db, { apply: true, logger })` in `runMaintenance`, positioned AFTER `resolveUnresolved`/`applyRecordUpdates` (so this run's new evidence counts) and BEFORE `scoreAll` (so freshly-resolved projects score this run).
- **MIRROR**: `apps/worker/src/schedules.ts:129-141` step ordering and the final summary object at :225-240.
- **GOTCHA**: Add its counts to the `pipeline maintenance complete` payload, or the step is invisible.
- **VALIDATE**: `pnpm maintenance:run` shows the new step with non-negative counts and no errors.

### Task 2.5: MEASURE the `same_address_name_mismatch` collapse — report only
- **ACTION**: Add a read-only report (a `--report` flag on the reevaluate CLI, or a `match:audit` mode) that counts how many of the 784 rows have L&I/record names that agree under `crossNameKeyLoose` + `classifyNameAgreement`.
- **IMPLEMENT**: Reuse `classifyNameAgreement` from `packages/resolution/src/registry-identifiers.ts`; bucket by `exact` / `close` / `contained` / `none`.
- **MIRROR**: `packages/resolution/src/google-name-agreement.test.ts` for how the basis classes are interpreted.
- **GOTCHA**: **Report only. Change no behaviour in this task.** Whether containment should auto-resolve an address-name mismatch is a separate owner decision with its own false-bind risk.
- **VALIDATE**: Report runs and the four buckets sum to 784.

---

### Task 3.1: Re-stage to backfill `name_basis`
- **ACTION**: Add a `--restage` flag to `google-place-rescore` that re-writes the 3,578 already-applied rows so they carry `name_basis`.
- **GOTCHA**: The insert is `ON CONFLICT (dedupe_key) DO NOTHING`, so a plain re-run will NOT update existing rows — it will report `alreadyPresent` and change nothing. `--restage` must use `DO UPDATE SET payload = ...` scoped to `google_place_confirmation`, or it is a silent no-op.
- **GOTCHA**: **`alreadyPresent` reads 0 in dry-run by construction** (the insert is skipped). Do not read a dry-run 0 as "the table is empty" — that error was made twice in the 2026-07-27 session.
- **GOTCHA**: Do not touch `applied_at` / `applied_action` — those belong to the registry loader.
- **VALIDATE**: `SELECT count(*) ... WHERE payload->>'name_basis' IS NULL` drops to 0.

### Task 3.2: Review export for the 840 + 22
- **ACTION**: Produce a reviewable listing grouped by `name_basis` and `contested`, so 840 uncontested containment rows can be judged as a class and the 22 contested individually.
- **MIRROR**: `triageReviewQueue`'s cluster-shaped output (count, sample titles, score range) — the same "judge a class, not 840 rows" ergonomic.
- **VALIDATE**: Counts reconcile with the staging table.

### Task 3.3: Document the cross-repo handoff
- **ACTION**: In `docs/architecture.md`, record that 3,882 rows sit `applied_at IS NULL` awaiting the OneTradeNetwork loader, and what the loader must honour (`dedupe_key`, `trust_score` tiers, `contested`, `name_basis`).
- **GOTCHA**: **This repo cannot land them.** Do not add a "make it applied" step here — writing `applied_at` from behind the seam would forge the loader's provenance.
- **VALIDATE**: Doc states the boundary explicitly.

---

### Task 5.1: Make resolver errors durable and alertable
- **ACTION**: Change `ResolveRunSummary.errors` from `number` to `{ sourceRecordId: string; error: string }[]`; thread the detail into `runMaintenance`'s summary; raise an alert when non-empty.
- **MIRROR**: `ERROR_DETAIL_SHAPE` (`review.ts:343-350`) — the same `{id, error}[]` shape already used by `BulkDecisionSummary`.
- **GOTCHA**: `errors` is currently a number and is read in `resolve-run.ts` and `schedules.ts`; `.length` those call sites. Check `apps/web` for any consumer of the summary shape before changing it.
- **GOTCHA**: Keep the existing per-row `logger.error` — the change is about durability, not replacing the log line.
- **ALTERNATIVE CONSIDERED**: a dedicated `resolution_errors` table — rejected as over-build for ~15 rows/run when the alert row is already durable.
- **VALIDATE**: Force a failure with a poisoned fixture record; the id appears in the summary and an alert row is written.

### Task 5.2: Retry the Google Place insert loop
- **ACTION**: Wrap the per-row insert in `recordGooglePlaceConfirmations` with `withConnectionRetry`.
- **IMPORTS**: `import { withConnectionRetry } from "@otn/db";` — **already an allowed dependency** (`packages/resolution/package.json` declares `"@otn/db": "workspace:*"`; `resolver.ts:2-13` imports from it).
- **MIRROR**: `RETRY_AT_A_CALL_SITE` — including the `onRetry` logging callback.
- **GOTCHA**: The insert is `ON CONFLICT (dedupe_key) DO NOTHING`, so it is genuinely idempotent and safe to retry — unlike `emitEvent` before Task 1.3.
- **VALIDATE**: `pnpm test`; typecheck clean.

### Task 5.3: Make `pnpm lint` usable
- **ACTION**: Add `"**/.worktrees/**"` to the `ignores` array.
- **IMPLEMENT**: `eslint.config.mjs:6-17`, alongside `"**/node_modules/**"` and `"**/dist/**"`.
- **GOTCHA**: All 97 current errors are in `.worktrees/` (untracked worktree copies) and pre-existing `scripts/*.mjs`. Ignoring `.worktrees/` will NOT get to zero — the `scripts/*.mjs` `no-undef` on `console` remains. Decide separately whether to add a Node globals env for `scripts/`; do not silently widen the ignore to hide real files.
- **VALIDATE**: `pnpm lint` error count drops to only the `scripts/*.mjs` set; report the residual number.

---

## Testing Strategy

### Unit / integration tests

| Test | Input | Expected | Edge case? |
|---|---|---|---|
| `emitEvent` is idempotent | resolve the same record twice | event count unchanged on 2nd | — |
| legitimate re-emit survives | same record, different `observed_at` | 2 rows | ✅ the 136 |
| null `event_date` still dedupes | two writes, `event_date IS NULL` | 1 row | ✅ `NULLS NOT DISTINCT` |
| `previewResolution` writes nothing | any record | no rows in `project_events` / `record_resolutions` | — |
| preview agrees with apply | fixture set across all passes | identical rule + projectId | ✅ drift guard |
| re-evaluation clears a held twin | twin gains a project | held review auto-decides on `official_id` | — |
| re-evaluation leaves ambiguity alone | fuzzy review, no new evidence | still pending | ✅ the safety property |
| re-evaluation defaults to dry-run | no `--apply` | zero writes | ✅ |
| resolver error detail | poisoned record | `{sourceRecordId, error}` in summary | — |

### Edge cases checklist
- [ ] `event_date IS NULL` on both sides of a would-be duplicate
- [ ] A review whose candidate project was deleted
- [ ] Re-evaluation on an empty queue
- [ ] Concurrent maintenance run (re-evaluation must not double-decide — `decideReview` on an already-decided row must be a no-op or a clean error)
- [ ] Pooler connection drop mid-loop (Task 5.2)
- [ ] `--limit` smaller than the queue

---

## Validation Commands

### Static analysis
```bash
pnpm typecheck
```
EXPECT: zero errors.

### Lint
```bash
pnpm lint
```
EXPECT: only the pre-existing `scripts/*.mjs` `no-undef` set; report the count.

### Focused tests
```bash
npx vitest run apps/worker/test/resolution.test.ts apps/worker/test/review.test.ts
```
EXPECT: all pass.

### Full suite
```bash
pnpm test
```
EXPECT: ≥1127 passing, no regressions.

### Migration
```bash
pnpm db:migrate
```
EXPECT: 0035 applies cleanly against the local DB.

### Dry-run against production (read-only)
```bash
pnpm review reevaluate
```
EXPECT: a summary with `apply: false` and zero writes.

### Manual validation
- [ ] Local `SHOW server_version` ≥ 15 (else switch to the `coalesce` index expression)
- [ ] Post-migration duplicate query on the 5-column key returns 0
- [ ] `pnpm maintenance:run` shows the re-evaluation step in the final summary
- [ ] Production dry-run count is plausible before any `--apply`

---

## Acceptance Criteria
- [ ] All tasks complete
- [ ] All validation commands pass
- [ ] Tests written and passing
- [ ] No type errors
- [ ] Lint no worse than the documented residual
- [ ] `docs/architecture.md` + `docs/STATUS.md` updated

## Completion Checklist
- [ ] Patterns mirrored, not reinvented (migration style, error shape, retry call site, CLI dispatch)
- [ ] No thresholds lowered anywhere
- [ ] Every new write path defaults to dry-run
- [ ] Counts disclosed, never silently dropped
- [ ] No cross-seam writes to registry-owned columns

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Unique index omits `observed_at` and destroys the 136 legitimate re-emits | Medium | **High** | Key includes `observed_at`; explicit test |
| `NULLS NOT DISTINCT` unavailable (PG < 15) | Low | Medium | Task 1.1 verifies first; `coalesce` fallback specified |
| Task 1.3 ships without 1.2 (or vice versa) | Medium | High | Ship together; `ON CONFLICT` without the index fails outright, which is at least loud |
| `previewResolution` drifts from `resolveRecord` | **High** over time | High | Shared pass sequence or an agreement test; called out in Task 2.1 |
| Re-evaluation auto-decides something wrong | Medium | **High** | Strong rules only (`official_id`/`explicit_reference`); dry-run default; machine `decided_by` so it is auditable and reversible via `undoResolution` |
| Re-staging silently no-ops on `ON CONFLICT DO NOTHING` | **High** | Medium | Explicit `DO UPDATE`; verify the null-basis count reaches 0 |
| Misreading a dry-run `alreadyPresent: 0` as "table empty" | Medium | Low | Documented in Task 3.1 — this happened twice on 2026-07-27 |
| Registry loader never consumes the 3,882 | Medium | Medium | Cross-repo; Task 3.3 documents the boundary rather than forging `applied_at` |
| Deleting 2,997 rows loses real history | Low | Medium | 2,661 byte-identical; keeps one row per group; run on local first |

## Notes

- **Phase 1's diagnosis gate is already satisfied** — 2,816 of 2,952 groups share `observed_at`, so these are true duplicates, not by-design re-emits. Proceed straight to the migration; do not re-litigate.
- **The stated Phase 5.2 blocker was false.** `packages/resolution` already depends on `@otn/db`.
- **Sequencing**: Phase 2.2 should land before the owner's PALS 45-per-8-hour job reaches volume, or pass-1b holds accumulate as queue depth. This is the one cross-plan ordering constraint.
- **Phase 2 is the compounding one.** Phases 1, 3 and 5 are hygiene; 2.2 is what converts enrichment into resolved bindings automatically. If effort has to be cut, cut 3.2 and 5.3, not 2.2.
- Test DB is LOCAL docker on **`PG_PORT=5433`**; a native Postgres shadows 5432 and will fail auth confusingly.
