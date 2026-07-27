# Implementation Report: Data Quality, Connections, and Observability (Phases 1, 2, 3, 5)

Branch `claude/tmux-install-320aiz`, 2026-07-27.

## Summary

Event writes are idempotent, the review queue re-asks itself when authoritative
evidence arrives, the Google Place staging boundary is documented and re-stageable,
and resolver failures now survive the run that produced them.

Two of the plan's own premises turned out to be wrong and are corrected below.
One task is blocked by a repo protection hook and was not worked around.

## Assessment vs Reality

| Metric | Predicted | Actual |
|---|---|---|
| Complexity | Large | Large — Phase 2 dominated, as predicted |
| Confidence | 8/10 | Justified; no task needed a redesign, two needed a corrected premise |
| Files changed | ~12 | 13 (11 source/test, 2 docs) + 1 migration + journal |
| Tests | — | 1135 passing (was 1127), +8 new, 0 regressions |

## Tasks

| # | Task | Status | Notes |
|---|---|---|---|
| 1.1 | Verify PG ≥ 15 | Complete | Local 16.4, **prod 17.6** — `NULLS NOT DISTINCT` available both sides |
| 1.2 | Migration 0035 | Complete | Applied to local **and production** (owner instruction, 2026-07-27) |
| 1.3 | `emitEvent` idempotent | Complete | Also added to `createProject`'s two inserts for uniformity |
| 1.4 | Drizzle schema | Complete — deviated | drizzle 0.44 cannot express `NULLS NOT DISTINCT`; documented drift |
| 2.1 | `previewResolution` | Complete — deviated | Extracted `decideResolution` instead of writing a parallel ladder |
| 2.2 | `reevaluatePendingReviews` | Complete | Dry-run default; strong rules only; `reviewIds` filter added for test isolation |
| 2.3 | CLI | Complete | `pnpm review reevaluate [--apply] [--limit N]` |
| 2.4 | Nightly chain | Complete | After resolve/update, before `scoreAll`; counts in the summary payload |
| 2.5 | Measure name collapse | Complete | **Answer: 0 of 784. Proposal killed — see Findings** |
| 3.1 | `--restage` | Complete | Payload only; `trustDrift` counted, never applied |
| 3.2 | Review export | Complete | `--report` groups by (name_basis, contested) |
| 3.3 | Document the seam | Complete | `docs/architecture.md` |
| 5.1 | Durable resolver errors | Complete | `{sourceRecordId, error}[]` + `resolver_errors` alert |
| 5.2 | Retry the insert loop | Complete | Stated blocker did not exist, as the plan predicted |
| 5.3 | `pnpm lint` | **BLOCKED** | `config-protection` hook forbids editing `eslint.config.mjs` |

## Validation

| Level | Status | Notes |
|---|---|---|
| Typecheck | Pass | `pnpm typecheck`, zero errors, all 9 packages |
| Unit/integration | Pass | 1135/1135, 111 files |
| Migration | Pass | Applied to local **and production**; index verified `NULLS NOT DISTINCT` on both — see below |
| Production dry-runs | Pass | `review reevaluate` and `review name-audit`, both read-only |
| Lint | Blocked | 97 errors, unchanged — see below |

## Findings that change the plan

**1. The 784 same-address name mismatches are not a name-matching problem.**
Task 2.5 asked how many collapse under `crossNameKeyLoose` + `classifyNameAgreement`
containment. The answer is **0 of 784 — 100% `none`**, and the reason is structural,
not a threshold to tune. The strings being compared are permit titles, not company
names:

```
[none] "20260190 – SFR - Remodel"   vs  "20260325 – Plumbing"
[none] "20260141 – SFR - Remodel"   vs  "20260325 – Plumbing"
```

`classifyNameAgreement` exists to compare an L&I registration against a Google
listing. Pointing it at permit titles is a category error and no loosening of it
will ever help. These rows need organization names carried on the records, or
parcel evidence — a different signal entirely. The follow-up work the plan
contemplated for this class should not be built.

**2. The lint premise was wrong, and the task is blocked anyway.**
The plan states "All 97 current errors are in `.worktrees/`". Measured: **69 are
in `.worktrees/`, 28 are in tracked `scripts/*.mjs`** (`no-undef` on `console`,
`process`, `setTimeout`). Ignoring `.worktrees/` would have left 28 real errors, not
the "residual" the plan implies. Separately, a `config-protection` hook hard-blocks
any edit to `eslint.config.mjs`:

> BLOCKED: Modifying eslint.config.mjs is not allowed. … If this is a legitimate
> config change, disable the config-protection hook temporarily.

That hook exists deliberately and disabling it is the owner's call, so the task is
left undone rather than circumvented. The real fix is two changes to that file: add
`"**/.worktrees/**"` to `ignores`, and give `scripts/**` a Node globals block.

**3. Re-evaluation clears 15 today, not thousands.** Live dry-run: 2,000 scanned,
15 would resolve (8 `official_id`, 7 `explicit_reference`), 0 errors, 0 mismatched.
The plan called Phase 2.2 "the compounding one", which is right about its purpose
but should not be read as a large immediate drain — the 46 were already repaired by
hand, and the remaining queue is dominated by rows no strong rule will ever clear
(1,605 awaiting evidence, plus the 784 above). Its value is preventing pass-1b holds
from accumulating from here on.

## Deviations

**Task 2.1 — extracted the pass ladder instead of duplicating it.** The plan allowed
either a parallel read-only walk of the passes or extraction, and flagged drift as
its highest-likelihood risk ("**High** over time"). A preview that disagrees with the
apply is worse than no preview because it gets trusted, so there is now exactly one
pass sequence: `decideResolution` returns a verdict, `resolveRecord` executes it,
`previewResolution` reports it. Drift is structurally impossible rather than
test-guarded. One subtlety this surfaced and preserves: on a multi-candidate parcel
match the review row stores the first candidate while the outcome reports `null`, so
the decision type carries `candidateProjectId` and `outcomeProjectId` separately.

**Task 1.4 — the index is declared without its qualifier.** drizzle 0.44's
`uniqueIndex` builder has no `.nullsNotDistinct()` (only the `unique()` *constraint*
builder does, which would create the wrong object). The index is declared so
drizzle-kit will not propose dropping it, with a comment marking the qualifier as
deliberate, documented drift pointing at migration 0035. Snapshots in
`migrations/meta/` stop at 0012, so `drizzle-kit generate` is already unused here and
migrations are hand-written with manual journal entries — 0035 follows that.

**Task 1.3 test — the plan's reproduction does not reproduce.** "Call `resolveRecord`
twice on the same record" fails at `persistResolution` with
`record_resolutions_active_ux`, before `emitEvent` is ever reached. The real duplicate
source is the non-transactional gap the old code comment described: the event commits,
the resolution does not, and the next run re-emits. The test simulates that by deleting
the resolution row between calls, which is the state a mid-write fault leaves behind.

**Task 2.2 — added a `reviewIds` filter.** `reevaluatePendingReviews` scans every
pending review globally, which makes it unsafe in a shared test database. Mirrors
`applyRecordUpdates`'s existing `sourceRecordIds` escape hatch, same rationale.

**Task 3.1 — `trust_score` is not rewritten.** The plan said to backfill `name_basis`
onto the 3,578 applied rows. Those rows are already applied, and silently re-scoring a
decision the loader has acted on is a retroactive edit rather than a backfill, so
`--restage` rewrites `payload` only and reports any disagreement as `trustDrift`.

## Files changed

| File | Action |
|---|---|
| `packages/db/migrations/0035_project_events_unique.sql` | CREATED |
| `packages/db/migrations/meta/_journal.json` | UPDATED |
| `packages/db/src/schema.ts` | UPDATED |
| `packages/resolution/src/resolver.ts` | UPDATED |
| `packages/resolution/src/review.ts` | UPDATED |
| `packages/resolution/src/google-place-rescore.ts` | UPDATED |
| `packages/delivery/src/alerts.ts` | UPDATED |
| `apps/worker/src/schedules.ts` | UPDATED |
| `apps/worker/src/cli/review.ts` | UPDATED |
| `apps/worker/src/cli/google-place-rescore.ts` | UPDATED |
| `apps/worker/test/resolution.test.ts` | UPDATED (+2 tests) |
| `apps/worker/test/review.test.ts` | UPDATED (+6 tests) |
| `apps/worker/test/bid-inbox.test.ts` | UPDATED (assertion shape) |
| `docs/architecture.md`, `docs/STATUS.md` | UPDATED |

## Production migration (applied 2026-07-27 on owner instruction)

Prod was at 35/35 migrations beforehand, so 0035 was the only pending one and no
unrelated DDL rode along with it. The predicted numbers held exactly:

| | Before | After |
|---|---|---|
| `project_events` rows | 44,111 | **41,250** (−2,861, as predicted) |
| duplicates on the 5-column key | 2,861 | **0** |
| duplicates on the naive 4-column key | 2,997 | **136** |
| rows with null `event_date` | 383 | 377 |

That third row is the safety property, and it is the one worth checking: the 4-column
key still reports 136 because those are the legitimate `applyRecordUpdates` re-emits.
Every one survived; only same-instant repeats collapsed. Had `observed_at` been left
out of the key, those 136 real stage changes would have been deleted instead.

The null-`event_date` count moving 383 → 377 means 6 of the collapsed pairs were
precisely the rows a unique index without `NULLS NOT DISTINCT` would have let
duplicate forever.

## Open, owner-gated

1. **`pnpm review reevaluate --apply` against production** — 15 reviews, previewed
   clean. The nightly chain now does this automatically on the next `maintenance:run`,
   so no manual action is needed unless you want it sooner.
3. **`--restage` against the registry** to backfill `name_basis` on 3,578 rows.
4. **Phase 5.3** needs the `config-protection` hook disabled, or an owner edit to
   `eslint.config.mjs`.
5. **The 840 containment + 22 contested Google Place rows** still need adjudication,
   and the 3,882 unapplied rows still need the OneTradeNetwork loader.
