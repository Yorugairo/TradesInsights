# Plan: Source Fleet Flow Verification + Scheduling

## Summary

The fleet has 36 registered sources, 29 enabled, and **no scheduler running in
production**. `registerSchedules()` exists and is correct, but the `pgboss` schema does
not exist in the database, so it has never initialized — every run in `source_runs` was
manually invoked. Two sources have never succeeded, three fail ~64% of runs, and nine
have never run at all. This plan verifies flow source-by-source, fixes what is broken,
and puts cadence under an actual scheduler.

## User Story

As the operator, I want every enabled source to actually run on its declared cadence and
to be told when one stops producing, so that "enabled: true" in config means data is
flowing rather than that someone remembered to run it by hand.

## Problem → Solution

`config/sources.yaml` declares 29 enabled sources with `daily` / `weekly` / `monthly`
cadences. Reality: ~2 runs per source across 6 days, all manual. → A scheduler that
honours `cadenceCron()`, plus a per-source flow assertion that distinguishes *broken*
from *quiet*.

## Metadata

- **Complexity**: Medium (verification + fixes) + **owner infrastructure decision** (host)
- **Source PRD**: N/A — from the 2026-07-27 production fleet audit
- **Estimated Files**: ~8

---

## Measured baseline, production, 2026-07-27 — do not re-derive

Fleet is **6 days old** (first runs 2026-07-21).

### Scheduling: none

| Mechanism | State |
|---|---|
| `pgboss` schema | **Does not exist.** `registerSchedules()` has never initialized against prod |
| `pg_cron` (`cron.job`) | 3 jobs, **all `registry_internal` read-model refresh** — zero source ingestion |
| `.github/workflows/` | **Directory does not exist.** No CI scheduling at all |
| Actual runs | Manual only. Daily sources average ~2 runs in 6 days |

### Flow status — 36 sources

**Broken (ran, never succeeded, zero records ever):**

| Source | Runs | OK | Errors | Discovered | First run |
|---|---:|---:|---:|---:|---|
| `bellevue_permits_arcgis` | 2 | 0 | 2 | 0 | 2026-07-27 |
| `spokane_permits_arcgis` | 1 | 0 | 1 | 0 | 2026-07-27 |

**Flaky — identical 11/4/7 signature, so likely one shared cause:**

| Source | Runs | OK | Failed | Errors | Parsed total |
|---|---:|---:|---:|---:|---:|
| `olympia_smartgov_reports` | 11 | 4 | 7 | 14 | 1,449 |
| `tumwater_development_review` | 11 | 4 | 7 | 7 | 80 |
| `tumwater_sepa` | 11 | 4 | 7 | 7 | 59 |
| `thurston_active_notices` | 3 | 2 | 1 | 2 | 64 |

**Never ran (9):** `auburn_permits_socrata`, `customer_bid_inbox_solis`, `fake_source`,
`fake_source_required`, `pierce_environmental_determinations`, `seattle_design_review`,
`thurston_hearing_examiner`, `thurston_land_use_rezone`, `wa_lni_verify`.
Of these, `customer_bid_inbox_solis` and `fake_source` are **enabled in config**; both are
`on_demand`, so this may be correct. `seattle_design_review` has a committed adapter **and
test** but has never executed.

**Healthy and producing (top by volume):** `pierce_permits_arcgis` 6,694 ·
`tacoma_permits_arcgis` 4,963 · `king_permit_reports` 3,082 · `puyallup_permits_arcgis`
3,039 · `everett_permits_socrata` 2,976 · `seattle_building_permits` 2,352 ·
`olympia_smartgov_reports` 1,449 · `wa_sepa` 601 · `lewis_issued_permits` 395 ·
`pierce_pals_contractor` 410 · `centralia_permit_reports` 221 · `king_public_notices` 171.

### Two traps found while measuring

**1. Success status is `'succeeded'`, not `'completed'`.** A first-pass audit query
filtering `status = 'completed'` returned NULL for **every** source and read as "nothing
has ever succeeded." Observed status vocabulary: `succeeded`, `failed`,
`completed_with_errors`. Any production code filtering on `'completed'` is silently
wrong — the same predicate-mismatch class as the `ENOTFOUND` retry that never fired
(`docs/` + the pooler-durability pass).

**2. `parsed_count = 0` on the last run does not mean broken.** 13 of 29 enabled sources
showed 0 on their most recent run; aggregating across all runs showed most had produced
records and simply had nothing new that day. Only `bellevue` and `spokane` are genuinely
empty. **Any health check that judges a single run's `parsed_count` will produce false
alarms on weekly/monthly sources.**

**3. `rejected_count` is 0 for all 36 sources across ~27,000 parsed records.** Either
validation never rejects anything, or the reject path is not wired to the counter. Worth
one deliberate check — a rejection counter that structurally cannot increment is a blind
spot, not a clean bill of health.

---

## Mandatory Reading

| Priority | File | Why |
|---|---|---|
| P0 | `apps/worker/src/schedules.ts:64-120` | `scheduledQueueName`, `stagger`, `cadenceCron` — the scheduling contract that exists but never runs |
| P0 | `apps/worker/src/schedules.ts:363-400` | `registerSchedules(boss, logger)` — reconciles desired vs actual pg-boss schedules |
| P0 | `packages/source-sdk/src/health.ts` | `evaluateSourceHealth` — confirm which status strings it treats as success |
| P0 | `packages/source-sdk/src/runner.ts` | Terminal writes; where `parsed_count` / `rejected_count` are set |
| P1 | `config/sources.yaml` | 36 entries; `cadence` and `enabled` per source |
| P1 | `apps/worker/src/cli/source-run.ts` | The manual entry point a cron would call |
| P1 | `packages/source-sdk/src/reap.ts` | `reapOrphanedRuns` — orphans read GREEN unless excluded |
| P2 | `apps/worker/src/cli/maintenance-run.ts` | What `maintenance:run` currently chains |

---

## Task 0 — OWNER DECISION: where does the scheduler live?

Adapters are Node/TypeScript with real dependencies, so **pg_cron cannot invoke them** —
it runs SQL only. That rules out the mechanism already proven in this database. Four
options:

| Option | Pros | Cons |
|---|---|---|
| **A. pg-boss worker as a long-running process** | Code already written and correct; staggered crons; queue semantics, retries | **Needs a host that stays up.** Vercel hosts the web app, not a daemon |
| **B. GitHub Actions scheduled workflow** | No host to run; secrets managed; free | **`schedule:` fires only from the DEFAULT branch** — a trap this org has already hit. Repo currently sits on `claude/tmux-install-320aiz`. Also needs `DATABASE_URL` as a secret |
| **C. Windows Task Scheduler on the operator machine** | Precedent exists (the OTN watchdog already runs this way) | Machine must be awake; the watchdog's `-RepoRoot` once pointed at a diverged worktree and ran the wrong code silently |
| **D. Supabase Edge Function + pg_cron** | Fully managed | Deno runtime; adapters are Node with heavy deps. Poor fit |

**Recommendation: B for durability, C as the immediate stopgap.** B is the only option
with no machine to babysit, and the default-branch constraint is a one-time fix (merge to
the default branch, or change the default). C can be standing within an hour and buys time.

Do not pick A without naming the host — the code being ready is not the same as somewhere
to run it.

---

## Step-by-Step Tasks

### Task 1: Assert the status vocabulary is used consistently
- **ACTION**: Grep for `'completed'`, `'succeeded'`, `'completed_with_errors'` across
  `packages/source-sdk`, `packages/delivery`, `apps/worker`, `apps/web`.
- **GOTCHA**: A filter on the wrong literal fails **open** — no error, just a permanently
  empty result that reads as healthy. This is the single highest-value grep in the plan.
- **VALIDATE**: List every site and the literal it uses. Any mismatch is a bug fixed here.

### Task 2: Fix `bellevue_permits_arcgis` and `spokane_permits_arcgis`
- **ACTION**: Run each with `pnpm source:run --source <key>` and read the actual error.
  Both are `arcgis` access_class and both discovered **zero** artifacts, which points at
  endpoint/layer configuration rather than parsing.
- **MIRROR**: A working ArcGIS source — `pierce_permits_arcgis` (6,694 parsed) or
  `puyallup_permits_arcgis` (3,039).
- **GOTCHA**: Both were added 2026-07-27 and have never succeeded, so this is almost
  certainly a bad `access_url` or a layer index, not a regression.
- **VALIDATE**: A run parses > 0 records, or the source is set `enabled: false` with the
  reason recorded in `notes`. Do not leave a permanently-failing source enabled.

### Task 3: Diagnose the shared 11/4/7 failure signature
- **ACTION**: Read the error text from failed runs of `olympia_smartgov_reports`,
  `tumwater_development_review`, `tumwater_sepa`.
- **IMPLEMENT**: Query `insights.source_runs.metrics_json` for those failures rather than
  re-running blind.
- **GOTCHA**: All three are `on_demand` / `dynamic_lookup` / `html` and share an identical
  4-ok/7-failed split. Treat one shared cause as the hypothesis and try to falsify it —
  three independent bugs producing identical ratios is unlikely.
- **VALIDATE**: Named root cause, plus either a fix or a documented reason.

### Task 4: Decide the never-ran nine
- **ACTION**: For each, classify: (a) correctly `on_demand`, (b) disabled on purpose,
  (c) should be running but isn't.
- **GOTCHA**: `seattle_design_review` has an adapter and a test but zero runs — the most
  likely (c). `fake_source` / `fake_source_required` are fixtures; leave them.
- **VALIDATE**: Every one of the nine has a written disposition.

### Task 5: Verify `rejected_count` can increment
- **ACTION**: Trace the reject path in `runner.ts`; add a test that feeds an invalid
  record and asserts the counter rises.
- **GOTCHA**: 0 rejects across 27k records is either true or a dead counter. Do not
  assume which.
- **VALIDATE**: A test proves a rejected record increments `rejected_count`.

### Task 6: Cadence-aware flow assertion
- **ACTION**: Add a check that flags a source when it has produced **no records across a
  full cadence window**, not on a single zero run.
- **IMPLEMENT**: daily → 48h, weekly → 10d, monthly → 40d. Compare against the source's
  own history, not a global threshold.
- **GOTCHA**: This is precisely where the baseline's trap #2 bites — a single-run check
  would have flagged 13 sources today, 11 of them wrongly. Also **exclude orphans**: a
  run whose counters were never written is *unknown*, not zero.
- **MIRROR**: The existing volume-drop / zero-records logic in `health.ts`, which already
  had to solve the orphan case.
- **VALIDATE**: Backtest against the 6 days of history — the check must flag `bellevue`
  and `spokane` and must **not** flag `lacey_permit_reports` (monthly, 50 records, 0 today).

### Task 7: Stand up the scheduler (per Task 0)
- **ACTION**: Implement the chosen option; schedule per `cadenceCron()` so the existing
  stagger (02:xx / 03:xx, hashed per key) is preserved.
- **GOTCHA (option B)**: `schedule:` triggers **only** from the repository's default
  branch. Verify the default branch and that the workflow file exists *there*, or it will
  silently never fire — which is the exact failure this plan is fixing.
- **GOTCHA**: Do not schedule `on_demand` sources. `cadenceCron` returns `null` for those;
  honour it.
- **VALIDATE**: After one full cycle, every `daily` source shows a run within 24h.
  **This is the acceptance test for the whole plan.**

### Task 8: Alert on the gap
- **ACTION**: Wire the Task 6 assertion into the existing alert path so a stalled source
  raises, and include "no run at all within cadence" as a distinct condition from
  "ran but produced nothing."
- **GOTCHA**: A source that never runs produces no `source_runs` row, so a check that only
  inspects rows cannot see it. Iterate the **config**, then left-join runs.
- **VALIDATE**: Deleting a schedule entry raises an alert within one cadence window.

---

## Testing Strategy

| Test | Input | Expected |
|---|---|---|
| Status literal audit | grep | zero uses of `'completed'` as a success filter |
| Cadence window check — broken | `bellevue` history | flagged |
| Cadence window check — quiet monthly | `lacey_permit_reports` history | **not** flagged |
| Cadence window check — orphan | run with null counters | skipped, not judged zero |
| Never-ran detection | config entry with no runs | flagged |
| Reject counter | invalid record | `rejected_count` increments |
| `cadenceCron` | each cadence value | valid cron or null for `on_demand` |

## Validation Commands

```bash
pnpm typecheck
```
EXPECT: zero errors

```bash
pnpm --filter @otn/source-sdk test
```
EXPECT: green, new health tests included

```bash
pnpm source:run --source bellevue_permits_arcgis
```
EXPECT: parses > 0, or a named error and a config disposition

## Acceptance Criteria
- [ ] Every `daily` source has a run within 24h of the previous one, sustained over 3 days
- [ ] `bellevue` and `spokane` either produce records or are disabled with a written reason
- [ ] The 11/4/7 failure signature has a named root cause
- [ ] All nine never-ran sources have a written disposition
- [ ] Flow assertion is cadence-aware and backtested against the 6 days of real history
- [ ] No code filters `source_runs` on a status literal that does not exist
- [ ] `rejected_count` is proven able to increment

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| GH Actions `schedule:` silently never fires from a non-default branch | **High** | **High** | Verify default branch explicitly; assert a run appears within 24h before closing the task |
| Single-run zero-record check floods false alarms | **High** | Medium | Task 6 is cadence-windowed and backtested |
| Enabling the scheduler triples load and trips source rate limits | Medium | Medium | Stagger already exists in `cadenceCron`; PALS has a measured ≈53/window budget — respect it |
| Fixing `bellevue`/`spokane` reveals the ArcGIS engine needs per-source config | Medium | Low | Mirror a working ArcGIS source |
| Operator-machine scheduling runs a diverged worktree | Medium | **High** | Precedent exists: the watchdog once defaulted to a diverged copy. Pin an absolute repo path |

## Notes

- **The scheduler code is not the problem — its absence in production is.**
  `cadenceCron()` and `registerSchedules()` are written, staggered and sensible. Nothing
  ever created the `pgboss` schema. Resist rewriting the scheduling logic.
- **The fleet is 6 days old.** Low run counts are partly youth, not only absence of
  scheduling. The `2 runs / 6 days` figure for `daily` sources is still the proof.
- **This plan deliberately does not add sources.** WEBS/OMWBE is a separate plan
  (`webs-omwbe-solicitation-ingestion.plan.md`). Adding sources to a fleet that does not
  run on cadence compounds the problem.
- The user's framing — "we can create crons to fetch what we need if they don't have
  APIs" — is right, but the binding constraint turned out to be that **nothing is
  scheduled at all**, including the sources that already work. Scheduling the existing 29
  is worth more than any new source.
