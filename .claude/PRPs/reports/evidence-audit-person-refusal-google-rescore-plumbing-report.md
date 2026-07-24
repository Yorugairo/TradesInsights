# Implementation Report: Evidence audit, person-shape report, Google re-score plumbing

Executed 2026-07-24 in order **A → C → D → B**, while the Google Place scrape ran
unattended (0 blocked throughout).

## Summary

Four tasks landed across both repos: a documentation correction, a report-only
person-shape measurement, the registry contract view + Insights scorer that make
the re-score a one-command job, and an audit that checks linked evidence using the
publication gate's own functions.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Medium | Medium — as scoped |
| Estimated files | ~11 | 11 (1 registry, 10 Insights) |
| Tasks | 4 | 4 complete |
| Tests added | ~11 cases | 26 (10 scorer, 8 person-shape, +8 existing files extended) |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| A | Correct the false "redundant index" comments | Complete | DDL untouched; comments only |
| C | Person-shape **report** (descoped from refusal) | Complete | `registry-observations.ts` untouched, as required |
| D | Google Place contract view + Insights scorer | Complete | View applied live; scorer validated read-only |
| B | `--audit` against the gate's own checks | Complete | 6,007/6,007 passing; reconciliation balances |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static analysis | Pass | `db`, `resolution`, `intelligence`, `worker` — zero errors |
| Unit tests | Pass | **455 passed / 30 files** |
| Database | Pass | `pnpm db:migrate` a clean no-op; registry view applied |
| Seam | Pass | `otn_insights_reader` SELECT granted and verified |
| Integration | Pass | Audit, report and scorer all run against live data |

## Files Changed

| File | Action |
|---|---|
| `packages/db/migrations/0033_opportunity_evidence_indexes.sql` | UPDATED (comments) |
| `packages/db/src/schema.ts` | UPDATED (comment) |
| `packages/resolution/src/principal-person.ts` | UPDATED (+`isPersonShapedOrgName`) |
| `packages/resolution/src/principal-person.test.ts` | UPDATED (+8 tests) |
| `packages/resolution/src/google-place-scrape.ts` | CREATED |
| `packages/resolution/src/google-place-scrape.test.ts` | CREATED (10 tests) |
| `packages/resolution/src/index.ts` | UPDATED (barrel) |
| `packages/intelligence/src/gate/gate.ts` | UPDATED (2 exports) |
| `packages/intelligence/src/link-opportunity-evidence.ts` | UPDATED (+audit) |
| `apps/worker/src/cli/person-shape-report.ts` | CREATED |
| `apps/worker/src/cli/link-evidence.ts` | UPDATED (`--audit`) |
| `<registry>/.../20260726010000_google_place_scrape_contract_view.sql` | CREATED |

## Results

### Task A — the index is NOT redundant
`EXPLAIN` on the populated table: the planner picks the narrow 960 kB `opp_ix` for
full-row lookups by `opportunity_id`, because the 4,504 kB unique index does not
cover `claim_type`/`confirmed`/`confidence`. The unique index wins where it covers
the projection (index-only, 0 heap fetches). **Nothing was dropped.**

### Task C — person-shape report (read-only)
| Measure | Value |
|---|---|
| Unbound orgs | 3,777 |
| Person-shaped | 2,376 |
| **Person-shaped that MATCH a registry entity** | **33** |
| Business-shaped that match | 223 |
| Share of all matches a refusal would destroy | **12.9%** |
| Primary contractors person-shaped | 21 of 215 |

### Task D — Google Place scorer (read-only against live data)
| Verdict | Rows |
|---|---|
| Observations | 31,179 |
| `phone_and_name` (real confirmation) | **2,827** |
| `phone_only` (circular, never promoted) | 1,420 |
| `name_only` | 2,171 |
| `none` | 24,761 |
| Confirmations on shared places | 1,514 |
| **Contested place ids** (>1 licence confirms) | **243** |

Skipped: 0 unusable status, 0 unknown entity.

### Task B — evidence audit
9,128 opportunities · 6,007 projects · **6,007 passing** · 0 failing either check ·
reconciliation balances (67,650 linked + 8,058 capped = 75,708). Runtime 2m53s.

## Deviations from Plan

1. **Task C descoped from refusal to report-only** *(owner decision, pre-implementation)*.
   Measurement showed a refusal would destroy 12.9% of available name matches, and
   the safeguard that would make it safe is unavailable at 35.7% L&I coverage
   (~6% for general contractors). `registry-observations.ts` deliberately untouched.
2. **`isPersonShapedOrgName` placed in `principal-person.ts`, not `normalize.ts`**
   — that is where `parsePersonName`, `BUSINESS_TOKENS` and `personCoreKey` live.
   Splitting one decision across two modules would invite drift.
3. **The index was not dropped** — the plan's conditional ("if genuinely without
   value") resolved to "it has value", proven by `EXPLAIN`.

## Issues Encountered

**None during this run.** The bug worth recording happened just before it: the
first live `link-evidence:apply` linked 67,650 rows, and a second run added 2,792
more because already-linked rows were subtracted *before* the cap, so each rerun
capped a shrinking remainder. Fixed by ranking the full set first
(`planOpportunityWrites`), with four tests asserting the rerun invariant. Table
rebuilt from empty; verified 67,650 rows, max 50 per opportunity, rerun inserts 0.

## Tests Written

| Test file | Tests | Coverage |
|---|---|---|
| `google-place-scrape.test.ts` | 10 | Confirmation verdicts, circular phone, contested places, skips |
| `principal-person.test.ts` | +8 | Person/business split, documented misclassifications, allowlist narrowing |

## Next Steps

- [ ] **Morning**: re-run `person-shape:report` and the Google scorer once the
      scrape drains (~14,978 places pending at hand-off) — the plumbing is ready,
      no build required.
- [ ] **243 contested place ids** need a human resolution path; a listing cannot
      belong to two companies.
- [ ] **Roadmap P6 (L&I load)** gates enabling the person-shape refusal.
- [ ] Not built, still open: Task 3.1 (binding audit baseline), Task 3.4
      (primary-contractor review lane), Task 3.3 (targeted matching), the ROI
      `confirmed = false` mislabel.
