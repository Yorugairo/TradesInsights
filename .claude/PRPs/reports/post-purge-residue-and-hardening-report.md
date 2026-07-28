# Implementation Report: Post-purge residue, family materialisation, e2e determinism

## Summary

All three tasks implemented and validated. The phase-2 purge sections exist and
dry-run at exactly the predicted 58/1/1 — **`--apply` remains owner-gated and
has NOT been run**. The corporate-family derivation is materialised: the
nightly chain persisted 1401 families / 354 pairs to production, and the web
now reads the table (281ms stamp probe steady-state, ~1s full read) instead of
paying a 29–79s cold seam derivation. The e2e suite wipes its own mutations at
the start of every run: three consecutive runs, no reseed, 29/29 each.

## Assessment vs reality

| Metric | Predicted (plan) | Actual |
|---|---|---|
| Complexity | Medium | Medium |
| Confidence | 8/10 | Landed in one pass; two small scope additions from FK reality |
| Files changed | 9 | 11 (+ report) |

## Tasks completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Phase-2 residue purge sections | Done — **apply owner-gated** | Dry-run prints 58 feedback / 1 pursuit / 1 invitation; refusal tripwire on >1 opportunity OR >1 user; phase-1 sections verify 0/0 |
| 2 | Materialise family derivation | Done | `0037`, `deriveCorporateFamilies` on the chain, table-first web read; production populated 2026-07-28 06:13Z |
| 3 | e2e mutation wipe | Done | 29/29 × 3 with no reseed; first wipe removed real drift from earlier sessions |
| 4 | Stamp e2e POST payloads | **Not done — owner call by design** | Ships only with explicit approval (spec edit) |

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

## Next steps

- [ ] **Owner: review the phase-2 dry-run (58/1/1) and, if approved, run
      `pnpm purge:e2e-rows --apply`** — then verify all three counts are 0 and
      `/app/pursuits` for Solis shows an empty board.
- [ ] Owner call on Task 4 (stamp e2e POST payloads with `notes: "e2e"`).
- [ ] After the next production deploy, glance at the cockpit family card:
      populated, fresh `derived_at`, first load fast.
