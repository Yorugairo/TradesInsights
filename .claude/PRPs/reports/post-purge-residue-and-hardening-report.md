# Implementation Report: Post-purge residue, family materialisation, e2e determinism

## Summary

All four tasks implemented and validated. **The phase-2 purge was APPLIED
2026-07-28 with owner approval — all six residue tables verify at zero in
production** (58 feedback / pursuit chain / invitation chain deleted; one
follow-up run removed the inbound message orphaned by a driver bug, see
Issues). The corporate-family derivation is materialised: the nightly chain
persisted 1401 families / 354 pairs to production, and the web now reads the
table (281ms stamp probe steady-state, ~1s full read) instead of paying a
29–79s cold seam derivation. The e2e suite wipes its own mutations at the
start of every run: three consecutive runs, no reseed, 29/29 each — and now
stamps its POST payloads (Task 4, owner-approved).

## Assessment vs reality

| Metric | Predicted (plan) | Actual |
|---|---|---|
| Complexity | Medium | Medium |
| Confidence | 8/10 | Landed in one pass; two small scope additions from FK reality |
| Files changed | 9 | 11 (+ report) |

## Tasks completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Phase-2 residue purge | **Done — APPLIED with owner approval** | Dry-run matched 58/1/1; applied; all six tables verify 0 in production |
| 2 | Materialise family derivation | Done | `0037`, `deriveCorporateFamilies` on the chain, table-first web read; production populated 2026-07-28 06:13Z |
| 3 | e2e mutation wipe | Done | 29/29 × 3 with no reseed; first wipe removed real drift from earlier sessions |
| 4 | Stamp e2e POST payloads | **Done — owner-approved** | Payload-only edits, no assertions changed; outcome stamp uses `reasonCode` (see Deviations); 29/29 |

## Validation results

| Level | Status | Notes |
|---|---|---|
| Typecheck (db, intelligence, worker, web) | Pass | |
| Lint | Pass | |
| Unit tests | Pass | 1247/1247 across 120 files; 5 new tests |
| e2e | Pass | 29/29 three consecutive runs, no reseed |
| Production migrate + maintenance run | Pass | `corporateFamilies {families: 1401, pairsNew: 354, pairsStrong: 258}` in the chain log |
| Persisted-read verification | Pass | Blob counts match summary counts; family/pair jsonb key sets match the TS types; stamp 281ms, full read 707ms over WAN |

## Files changed

| File | Action |
|---|---|
| `apps/worker/src/cli/purge-e2e-rows.ts` | UPDATE — phase-2 sections, refusal tripwire, FK-ordered deletes |
| `packages/db/src/schema.ts` | UPDATE — `corporate_family_summary`, `corporate_family_pairs` |
| `packages/db/migrations/0037_corporate_family_summary.sql` | CREATE — additive only, no backfill |
| `packages/db/migrations/meta/_journal.json` | UPDATE — idx 37 |
| `packages/intelligence/src/corporate-family.ts` | UPDATE — `buildCorporateFamilySnapshot`, `deriveCorporateFamilies`, readers |
| `packages/intelligence/src/corporate-family.test.ts` | UPDATE — 5 tests (trim, counts, jsonb round-trip, 2 skip guards) |
| `apps/worker/src/schedules.ts` | UPDATE — derive beside the seam block, reusing fetched rows |
| `apps/web/lib/registry-families.ts` | UPDATE — table-first, SWR fallback |
| `apps/web/app/app/admin/corporate-families/page.tsx` | UPDATE — comment only (read path unchanged: `familySnapshot()`) |
| `apps/web/e2e/global-setup.ts` | UPDATE — step 4 wipe, below the guard |
| `docs/testing.md` | UPDATE — wipe + purge phase status |

Commits: `806d2ed` (T1), `04c006f` (T2), `0c915b3` (T3).

## Deviations from plan

- **Pursuit FK children**: the plan listed `pursuit_transitions → pursuit_tasks`;
  the schema also has `pursuit_notes`, and `roi_events` / `opportunity_outcomes`
  / `relationship_interactions` carry nullable `pursuit_id` FKs. The purge
  deletes notes and pursuit-linked roi_events as same-POST residue and REFUSES
  if outcomes or relationship interactions reference the candidate (human
  usage the suite never produces). The wipe list gained
  `relationship_interactions`, `pursuit_notes`, `bid_invitation_events`,
  `bid_documents` for the same children-first reason.
- **Summary table carries the snapshot blobs** (`families_json`, `dropped_json`,
  `rows_json`), not just counts: the families page renders family groups and
  entity names, so counts alone could not retire the cold derivation.
- **"Seam killed mid-derivation leaves previous rows"** was validated by unit
  test (both skip paths provably touch nothing; persistence is one
  transaction) rather than by re-running the production chain with the seam
  severed.
- **Cold-start "<2s populated card"** was validated by timing the persisted
  reads directly (281ms + 707ms) rather than booting a production-pointed web
  process; the e2e suite covers the seam-offline fallback path.

## Issues encountered

- **The first `--apply` failed at its LAST statement** (`inbound_messages`)
  with `22P02` — drizzle hands a JS-array parameter to pg as a plain string
  and Postgres's `array_in` rejects it. Every earlier delete had already
  committed (no wrapping transaction), stranding one orphaned message that the
  invitation-join anchor could no longer find. Fixed (`c33f4ca`): one bound
  parameter per id, plus a sender-based orphan predicate so a half-applied
  run stays re-runnable. Second apply removed the orphan; final dry-run shows
  every section at zero.
- Scratchpad `.ts` under tsx resolved as CJS (top-level await error) and ESM
  resolution could not find `pg` outside the repo — verification ran as inline
  `node -e` from `packages/db` instead.
- `vitest` is hoisted at the root; `pnpm --filter @otn/intelligence exec vitest`
  fails with MODULE_NOT_FOUND. Run `pnpm vitest run` from the root.

## Observations for the owner

- **Family count is now 1401** (was 217 when measured 2026-07-23). Same
  unchanged `buildFamilies` over the same live fetch — the registry contract
  view has grown, this is not introduced by the materialisation. **2 groups are
  dropped over the size cap** — the agent-filter regression signal the page
  surfaces; worth a look.
- The maintenance chain logs 5 recurring `record_resolutions` insert failures
  in `reevaluatePendingReviews` (pre-existing, spun off as a separate task).

## Deviations (Task 4)

- The outcome stamp is `reasonCode: "e2e"`, not the planned `notes: "e2e"`:
  the outcomes API (`apps/web/app/api/app/outcomes/route.ts`) accepts
  `reasonCode` and silently drops unknown fields — a stamp the endpoint
  discards would leave the row bare while the spec looked stamped. This
  mirrors the `reason: "e2e"` convention corrections and suppressions already
  use, and a stamped outcome no longer matches the purge script's bare shape.

## Next steps

- [x] Phase-2 purge applied and verified: all six residue tables at 0.
- [x] Task 4 shipped with owner approval.
- [ ] After the next production deploy, glance at the cockpit family card:
      populated, fresh `derived_at`, first load fast.
