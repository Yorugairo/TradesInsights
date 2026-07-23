# Implementation Report: Registry entity aliases from L&I → surfaced on the contract

**Date**: 2026-07-23 · **Repos**: registry `release/trades-staging` (`8f1beb6b`), TradesInsights `claude/tmux-install-320aiz` (`e07dbd5`, `fc23528`, plus work inside `c9a6058`)

## Summary
Populated `registry_entity_aliases` (0 → **253 rows across 228 entities**) from L&I
records already held, surfaced them as `trades_identity_v1.aliases`, and taught
Insights to match them. Result, verified live: **12 new binding candidates that
were previously unreachable**, all review-gated, none auto-bound.

## The payoff, in real rows
| Insights org (from a permit) | Registry entity it now reaches |
|---|---|
| `2 SONS PLUMBING LLC` | Fischer Services |
| `RESCUE ROOTER` | Blue Flame Htg Air & Electric |
| `DEAR ELECTRIC` | Dear Services |
| `APOLLO MECHANICAL CONTRACTORS` | Apollo Heating & A/C |
| `FAST HOME SERVICES` | Fast Plumbing And Drain |
| `BOWERS PLUMBING LLC` | Bowers Home Services LLC |

None of these share a canonical name with their entity. Before this, they could
never bind.

## Assessment vs Reality
| Metric | Predicted | Actual |
|---|---|---|
| Complexity | Medium | Medium |
| Confidence | 8/10 | Single-pass; 4 deviations, all forced by verified facts |
| Alias yield | ~306 / ~275 entities | **253 / 228** (normalizer-exact; the 306 counted raw names, some of which normalize identically) |
| Files | ~6 | 6 |

## Tasks
| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Unique index for idempotent writes | **Dropped — unnecessary** | PK is already `(entity_id, alias_type, alias_normalized)` |
| 2 | Backfill script | Complete | 253 inserted; rerun inserts 0 (proven live) |
| 3 | Ongoing capture at mint | Complete | Deviated — set-based reconcile, not loop-threaded |
| 4 | Surface `aliases` on the contract | Complete | 27 cols, appended last, reader grant intact |
| 5 | Insights consumes aliases | Complete | + a safety gate the plan didn't anticipate |

## Deviations from Plan
1. **Task 1 dropped.** The table's PK already enforces
   `(entity_id, alias_type, alias_normalized)`. The planned stricter index on
   `(entity_id, alias_normalized)` would have *wrongly forbidden* the same name
   under two alias types (e.g. both `dba` and `partner_observed`).
2. **`alias_type = 'dba'`, not `'lni_business_name'`.** The CHECK constraint
   permits only `name|dba|legal|partner_observed` — the planned value would have
   been rejected outright. `'dba'` is also semantically exact: L&I documents
   `businessname` as the doing-business-as name.
3. **Top risk eliminated rather than mitigated.** The plan's High risk was
   "normalizer mismatch → thousands of junk aliases". Instead of re-implementing
   `normalizeName` in the script, the backfill compares two **stored** columns
   (`registry_normalized_records.business_name_normalized` vs
   `registry_business_entities.canonical_name_normalized`) — both written by the
   same normalizer at mint. Drift is structurally impossible.
4. **Mint hook is a set-based reconcile** appended after the existing
   `record_count` reconcile, rather than threaded through the clustering loop —
   same statement as the backfill, mirrors an established pattern in that file,
   and is idempotent by construction.

## Safety issue found and fixed (not in the plan)
Registry aliases enter the **same** name index as canonical names, so an alias
hit arrives at the strict auto-bind gate as `binding_name_exact` with name
component 1 — auto-bind-eligible. It was blocked only *incidentally*, by the
`canonical_name_normalized` equality check, **which the gate skips when that
column is null**. All 25,545 live entities have it populated, so nothing was
mis-bound — but a governance-critical property must not rest on current data.
Fixed in `fc23528` with an explicit, structurally-derived `viaRegistryAlias`
gate input plus two unit tests.

## Validation
| Level | Status | Notes |
|---|---|---|
| Static analysis | Pass | 0 type errors across all packages; 0 lint errors in changed files |
| Unit tests | Pass | 43 in registry-observations (+3) |
| Integration | Pass | **782/782**, 90 files (+5 new) |
| Build | Pass | `next build` compiled |
| Backfill dry-run | Pass | 253/228, matched the live apply exactly |
| Idempotency | Pass | mint-hook statement re-run live → **0 reinserted**, still 253 |
| Contract | Pass | 27 cols, `aliases` last, 228 rows populated, `otn_insights_reader` SELECT verified |
| End-to-end | Pass | live generation → **12 candidates, all pending, strictAutoBound 0** |

## Issues Encountered
- **`strict-bind:preview` reports `bindingCandidates: 0` in dry-run by design** —
  [registry-observations.ts:1003](packages/resolution/src/registry-observations.ts:1003)
  `if (opts.dryRun) continue` sits before the counter. The first preview's 0 was a
  measurement artifact, not an absence of matches. Worth knowing: preview cannot
  measure queue yield.
- **A concurrent agent in the same worktree swept my uncommitted edits into its
  commit `c9a6058`** ("divergent Google phone lane"). The alias-index change and
  4 integration tests are correct and tested but live under that commit message.
  Not rewriting — `c9a6058` is pushed and is the shared handoff point.
- `apps/worker/test/org-activity.test.ts:233` is **flaky, pre-existing and
  unrelated** — it failed once in 7 runs of identical code (both "baseline" and
  "branch" runs contained the same committed tests). Worth a separate fix.
- The registry worktree has no privileged trades `DATABASE_URL`
  (`REGISTRY_DATABASE_URL` is the least-privilege reader and correctly cannot see
  `registry_internal`), so the live apply went through the Supabase MCP path, as
  this session's earlier geo work did.

## Next Steps
- [ ] Owner: review the 12 alias-derived candidates at `/app/admin/registry-review`
- [ ] Owner decision (deferred by design): should any alias tier earn auto-bind?
- [ ] Fix the `org-activity` flake
- [ ] Phase 4 — free Google Places enrichment for unbound orgs (last unscoped phase)
