# Plan: Post-purge residue, family materialisation, e2e determinism

## Summary

The approved purge is APPLIED (2026-07-28): `claim_corrections` 30→0,
`opportunity_outcomes` 30→0, verified. Three issues remain, in value order:
production still carries e2e residue in `feedback` (58 rows — now proven 100%
attributable), `pursuits` (1) and `bid_invitations` (1); the corporate-family
snapshot is process-cached and pays a 22–79s cold derivation after every deploy;
and the e2e suite still never cleans up after itself, so `otn_e2e` drifts
between reseeds.

## User story

As the owner, I want production to contain only customer-generated rows and the
admin cockpit to be fast from the first request after a deploy, so that every
number the product shows is real and nobody waits on a cold cache.

## Problem → Solution

e2e residue in three production tables + cold-start derivation + drifting e2e
database → supervised residue purge, nightly-materialised family summary,
mutation wipe before each e2e run.

## Metadata

- **Complexity**: Medium
- **Source PRD**: N/A — successor to `e2e-local-corpus.plan.md` (complete) and
  the "cached, not materialised" deviation in
  `cockpit-seam-performance-and-degradation.plan.md`
- **Estimated Files**: 9

---

## What the post-purge profile established (measured 2026-07-28)

The purge left three residue tables, and profiling removed the ambiguity that
kept them out of the first purge:

| Table | Rows | Evidence |
|---|---|---|
| `feedback` | **58** | **All 58** on the one e2e opportunity (`17c815dc…`), **all** `user_id = solis_interiors`, all inside the 2026-07-27→28 window. There is no real feedback in production to protect. |
| `pursuits` | **1** | Same opportunity, `state = discovered`, opened in the window, 1 transition. |
| `bid_invitations` | ~1 | The stable `acme-gc.com` .eml the invitation test uploads (dedupes on Message-ID). Identify via `estimator_email ILIKE '%acme-gc%'`. |

Why it matters even at 58 rows: `feedback` is a scoring-calibration input, and
§12.3 calibration is owner-gated and **has not run yet** — left in place, its
first run would train partly on synthetic rows. The purge script deliberately
refused to touch feedback ("no marker"); the profile above IS the marker.

## UX Design

Internal change — no user-facing UX transformation. Visible effects: the
cockpit's family card is fast and populated on the first request after a
deploy, and `/app/pipeline` / ROI figures stay purely customer-generated.

---

## Mandatory reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `apps/worker/src/cli/purge-e2e-rows.ts` | all | The pattern Task 1 extends — profile, print, `--apply` |
| P0 | `apps/web/lib/registry-families.ts` | all | The cache Task 2 materialises; the two rules it keeps |
| P0 | `apps/worker/src/schedules.ts` | ~140-170 | Where `deriveCorroboration` runs; Task 2's job goes beside it |
| P0 | `packages/resolution/src/corroboration.ts` | 40-105 | The materialised-derivation pattern (derive → write → stamp) |
| P1 | `apps/web/e2e/global-setup.ts` | all | Task 3 adds the wipe here |
| P1 | `packages/db/src/schema.ts` | 567-620, 686-720, 808-895 | feedback / bid_invitations / outcomes+pursuits columns |
| P1 | `packages/intelligence/src/cockpit-summary.ts` | 74-175 | `CockpitFamilies` carries `derivedAt`/`stale` already |
| P2 | `docs/testing.md` | all | The three-database contract Task 3 completes |

## External documentation

No external research needed — established internal patterns only.

---

## Patterns to mirror

### SUPERVISED_PURGE
```ts
// SOURCE: apps/worker/src/cli/purge-e2e-rows.ts:40-47
const E2E_OUTCOME_PREDICATE = sql`
  outcome_type = 'won'
  AND influenced_by_otn = false
  AND pursuit_id IS NULL ...`;
// dry-run default, profile every distinct shape, print each candidate row,
// delete only under --apply
```

### MATERIALISED_DERIVATION
```ts
// SOURCE: packages/resolution/src/corroboration.ts:96-100
SET corroboration = jsonb_build_object(
  'sourceCount', src.source_count, …,
  'derivedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
// derive on the maintenance chain, stamp derivedAt, read cheaply everywhere
```

### STALE_OVER_ZERO
```ts
// SOURCE: apps/web/lib/registry-families.ts (refresh path)
// A failed refresh never replaces good data with a zero — the previous
// snapshot stands and its age becomes the signal. Task 2 keeps BOTH rules:
// derivedAt renders, and failure leaves the last good row.
```

### FK_ORDERED_DELETE
```sql
-- SOURCE: this session's otn cleanup (memory: insights-web-page-query-budget)
-- opportunities has 11 FK dependents; pursuits has transitions + tasks.
-- Delete children first: pursuit_transitions → pursuit_tasks → pursuits.
```

---

## Files to change

| File | Action | Justification |
|---|---|---|
| `apps/worker/src/cli/purge-e2e-rows.ts` | UPDATE | Phase-2 residue: feedback, pursuits(+children), bid_invitations |
| `packages/db/src/schema.ts` | UPDATE | `corporate_family_summary` + `corporate_family_pairs` |
| `packages/db/migrations/*_corporate_family_summary.sql` | CREATE | Additive only |
| `packages/intelligence/src/corporate-family.ts` | UPDATE | `deriveCorporateFamilies(db, pool)` — derive once, persist |
| `apps/worker/src/schedules.ts` | UPDATE | Run it on the maintenance chain beside `deriveCorroboration` |
| `apps/web/lib/registry-families.ts` | UPDATE | Read the table first; SWR cache becomes the fallback |
| `apps/web/app/app/admin/corporate-families/page.tsx` | UPDATE | Read persisted pairs |
| `apps/web/e2e/global-setup.ts` | UPDATE | Wipe mutation tables before each run |
| `docs/testing.md` | UPDATE | Record the wipe + purge completion |

## NOT building

- **A CI test workflow.** No workflow runs tests today (`source-fleet.yml` is
  the only one); adding CI for vitest/e2e is a new capability and a separate
  decision, not a fix.
- **A `reason`/marker column on feedback or outcomes.** Schema change for a
  problem the local-only guard already ended.
- **Any spec edit.** Task 3 achieves determinism outside the specs. (Optional
  Task 4 notes the one exception and leaves it as an owner call.)
- **Solis calibration.** §12.3 stays owner-gated; Task 1 merely stops synthetic
  rows reaching it.

---

## Step-by-step tasks

### Task 1: Phase-2 residue purge (production)
- **ACTION**: Extend `purge-e2e-rows.ts` with three sections, same contract
  (profile → print candidates → `--apply`): `feedback`, `pursuits` (+
  `pursuit_transitions`, `pursuit_tasks`, children first), `bid_invitations`.
- **IMPLEMENT**: Feedback predicate is the PROFILE, not a field: all rows on one
  `opportunity_id`, one `user_id`, inside a printed date window. The script
  prints the per-opportunity cluster table (already proven: 58/58 on
  `17c815dc…`) and refuses `--apply` if feedback spans >1 opportunity — that
  would mean real feedback has arrived since, and the human must re-review.
  Bid invitations: `estimator_email ILIKE '%acme-gc%'`; delete any dependent
  inbound-message row after checking the FK direction.
- **MIRROR**: `SUPERVISED_PURGE`, `FK_ORDERED_DELETE`.
- **IMPORTS**: existing (`createDb`, `createPool`, `sql`).
- **GOTCHA**: `feedback.user_id` is stamped from the session — `solis_interiors`
  matches real Solis feedback too. The >1-opportunity refusal is the tripwire
  that keeps this safe as time passes.
- **GOTCHA**: Do NOT hardcode the opportunity UUID as the predicate; derive it
  from the cluster profile at runtime so the script stays correct if the e2e
  target ever differed.
- **VALIDATE**: dry-run prints 58/1/1 candidates; after `--apply`, all three
  counts are 0 and `/app/pursuits` for Solis shows an empty board.

### Task 2: Materialise the corporate-family derivation
- **ACTION**: New tables — `corporate_family_summary` (single row: counts +
  `derived_at`) and `corporate_family_pairs` (the `PrincipalPersonPair` rows the
  families page renders, replace-all per derivation). New
  `deriveCorporateFamilies(db, registryPool)` in
  `packages/intelligence/src/corporate-family.ts` running the existing
  fetch → build → match chain once and persisting. Wire into the maintenance
  chain beside `deriveCorroboration` with a visible skip when the seam is
  offline.
- **IMPLEMENT**: `apps/web/lib/registry-families.ts` reads the table first and
  returns it as the snapshot (stamp from `derived_at`); the existing on-demand
  derivation + process cache becomes the fallback for a table that is absent or
  older than the cache would tolerate. `familyCounts` unchanged.
- **MIRROR**: `MATERIALISED_DERIVATION`, `STALE_OVER_ZERO`.
- **GOTCHA**: **Never write a zero row on failure** — on any error, leave the
  previous rows; `derived_at` going stale IS the signal, and `DerivedAt` already
  renders it.
- **GOTCHA**: **Privacy.** Pairs contain principal names (private individuals,
  owner decision 2026-07-23). The tables live in the `insights` schema, are read
  only by the admin-gated pages, and must never be exposed through
  `insights_public` or any export.
- **GOTCHA**: Migration is additive-only; do not backfill inside it. The first
  maintenance run populates it.
- **GOTCHA**: The maintenance chain is a Node job — the "plpgsql cannot COMMIT
  under pg_cron" constraint does not apply here; do not reintroduce an in-DB
  driver.
- **VALIDATE**: run `pnpm maintenance:run`; cockpit + families pages quote
  identical numbers with a fresh `derived_at`; kill `REGISTRY_DATABASE_URL` and
  re-run — previous rows survive and the UI flags staleness, never zeros.
  Restart the web process: first cockpit request is <2s with a populated card
  (the cold-start "not measured" only appears when the table has never been
  written).

### Task 3: e2e mutation wipe — determinism between reseeds
- **ACTION**: In `e2e/global-setup.ts`, after the corpus check, delete from the
  mutation tables the suite writes: `feedback`, `opportunity_outcomes`,
  `claim_corrections`, `pursuit_transitions`, `pursuit_tasks`, `pursuits`,
  `bid_invitations` (+ its inbound-message parent), `account_suppressions`,
  `account_organization_relationships`, `decision_labels`, `action_tokens` —
  children before parents, one explicit list with a comment naming why each is
  there.
- **MIRROR**: `FK_ORDERED_DELETE`.
- **GOTCHA**: The wipe runs against `e2eDatabaseUrl()` ONLY — it executes after
  the non-local refusal, so it can never touch `otn` or production, but keep it
  below that guard in the file so the ordering is structural.
- **GOTCHA**: Do not wipe corpus tables (`projects`, `opportunities`, evidence,
  roles, reviews) — the seeded review row's `pending` status is corpus, not
  mutation. Wiping `resolution_reviews` would delete the `cluster-reject`
  fixture.
- **VALIDATE**: `pnpm test:e2e` three times consecutively with NO reseed —
  29/29 each time, and `otn_e2e`'s feedback/outcomes counts return to 0 at each
  run's start.

### Task 4 (optional — owner call): stamp future e2e writes
- **ACTION**: Add `notes: "e2e"` to the outcome POST and `reason: "e2e"` is
  already on corrections/suppressions; feedback POST gains `notes: "e2e"`.
- **GOTCHA**: This edits `app.spec.ts` payloads. The standing rule forbids
  changing testids/asserted strings to suit markup; a POST body is neither, and
  no assertion weakens — but it is still a spec edit, so it ships only with
  explicit approval. Value: any future leak anywhere is identifiable by field
  instead of by forensics.
- **VALIDATE**: e2e 29/29; grep the spec diff shows payload-only changes.

---

## Testing strategy

| Test | Input | Expected | Edge? |
|---|---|---|---|
| purge dry-run | current prod | 58/1/1 candidates, deletes nothing | — |
| purge refusal | feedback on 2+ opportunities | refuses `--apply` | ✓ |
| derive job, seam offline | no `REGISTRY_DATABASE_URL` | visible skip, rows untouched | ✓ |
| derive job, seam error mid-run | kill connection | previous rows stand, stale flagged | ✓ |
| web read, table empty | fresh DB | falls back to on-demand path | ✓ |
| wipe idempotency | 3 e2e runs, no reseed | 29/29 × 3 | — |
| privacy | `insights_public` views | no pair/principal data reachable | ✓ |

## Validation commands

```bash
pnpm typecheck && pnpm lint && pnpm vitest run
```
```bash
pnpm db:migrate && pnpm maintenance:run
```
```bash
cd apps/web && pnpm test:e2e
```
```bash
pnpm purge:e2e-rows
```

### Manual validation
- [ ] Owner reviews the phase-2 dry-run before `--apply` (feedback is a
      calibration input; the profile is the marker, not a field)
- [ ] After `--apply`: feedback 0, pursuits 0, invitations 0 in production
- [ ] Post-deploy first cockpit load: populated family card, fresh `derived_at`

## Acceptance criteria
- [ ] Production carries zero e2e-attributable rows in all six tables
- [ ] Family counts survive a web-process restart without a cold derivation
- [ ] A failed nightly derivation leaves stale-flagged data, never zeros
- [ ] e2e green three consecutive runs with no reseed
- [ ] No spec assertion changed (Task 4 only with explicit approval)

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Real feedback arrives before phase-2 purge runs | Low | High | >1-opportunity refusal tripwire; dry-run review |
| Nightly job dies, family numbers freeze silently | Medium | Medium | Never-write-zero + `DerivedAt` stale flag already renders |
| Pairs table leaks principal names | Low | **High** | insights schema only, admin reads only, explicit VALIDATE step |
| Wipe list drifts as tests grow | Medium | Low | Explicit list with per-table comments; a missed table only drifts `otn_e2e`, never prod |

## Notes

Task 1 is one owner review away from execution and stops synthetic rows
reaching §12.3 calibration. Task 2 retires the last deliberate deviation from
the seam plan. Task 3 closes the loop the corpus opened: the suite that once
wrote to production now cannot even dirty its own sandbox between runs.
