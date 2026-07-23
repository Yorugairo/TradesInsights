# Implementation Report: Organization alias capture + alias-aware binding

**Date**: 2026-07-23 · **Branch**: `claude/tmux-install-320aiz` · **Repo**: TradesInsights

## Summary
Built the name/alias arm of the cross-platform identity graph: `organization_aliases`
gained a unique index and its first writers, the resolver now records the name
variants it previously discarded on collapse, and the binding matcher tries an
org's aliases against the registry name index under a new `binding_alias_exact`
rule (review-only — never auto-binds).

## ⚠️ Headline finding: the lane is correct but currently unfueled

The live backfill dry-run examined **3,901 org-attributed party names and found 0
variants**. This is a true result, not a defect — verified three ways:

- All **9,608** party rows are unambiguous (one distinct name per record+role), so
  the precision guard is not the limiter — `ambiguous_pairs = 0`.
- Historic variants can only exist where a *collapse* happened (source-entity-id
  or strong-key tiers). Those tiers rarely fire, because Insights orgs hold almost
  no strong keys.
- The only orgs sharing a strong key are `PATRIOT FIRE PROTECTION` and
  `PATRIOT FIRE PROTECTION INC` — which fold to the **same** `crossNameKey` (`INC`
  is a stripped legal suffix). Correctly excluded as a restatement, not an alias.

**Implication for sequencing:** the alias fuel is not in Insights history. It is
the **306 registry-side L&I variants** identified in the Phase 2 PRP. Those match
the *opposite* direction (Insights canonical → registry alias) and need the
registry contract to expose an `aliases` column first. Phase 2 is therefore the
higher-value next build; this PR is the receiving end that makes it pay off, plus
forward capture that fires as identifier coverage grows.

## Assessment vs Reality
| Metric | Predicted | Actual |
|---|---|---|
| Complexity | Medium–Large | Medium |
| Confidence | 8/10 | Single-pass; 3 deviations, all deliberate |
| Files changed | ~7 | 13 (+2 created) |

## Tasks
| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Unique index on `organization_aliases` | Complete | Deviated — hand-authored migration (see below) |
| 2 | `persistOrganizationAlias` | Complete | |
| 3 | `loadOrganizationAliases` + `crossNameKey` relocation | Complete | No circular import; 102 pre-existing tests stayed green |
| 4 | Resolver alias capture | Complete | Deviated — `RecordRow.sourceId` did not exist; threaded it |
| 5 | `binding_alias_exact` rule | Complete | Deviated — phone-aware identifier, not fixed 0.5 |
| 6 | Tier the alias rule | Complete | |
| 7 | Alias backfill CLI | Complete | Deviated — precise role-join instead of accepting over-capture |
| 8 | Business-address-city locality (OPTIONAL) | **Not built** | Deferred to its own PRP, per the plan's own note |

## Validation
| Level | Status | Notes |
|---|---|---|
| Static analysis | Pass | `pnpm -r run typecheck` — 0 errors across all packages |
| Lint | Pass | 0 errors in all 13 changed files (79 repo-wide errors are pre-existing, untouched files) |
| Unit tests | Pass | 105 in `packages/resolution` (+3 new) |
| Integration tests | Pass | 776/776 across 90 files (+5 new), Docker PG 5433 |
| Build | Pass | `next build` — **fixed a pre-existing break**, see below |
| Migration | Pass | 0031 applied; unique index verified live in the test DB |
| Live preview | Pass | `strict-bind:preview` — 0 new auto-binds, no regression |

## Deviations from Plan
1. **Migration hand-authored, not `drizzle-kit generate`.** The repo's migrations
   are hand-written with explanatory headers and a hand-maintained `_journal.json`
   (`when` increments by exactly 1000; snapshots stop at 0012). Running `generate`
   would have produced a large spurious diff against the drifted live schema.
2. **`RecordRow.sourceId` did not exist** (the plan's flagged unknown). Added it as
   optional and threaded it through both production query paths plus the review
   re-resolution path, so aliases carry real provenance instead of null.
3. **Backfill uses a precise role-join, rejecting the plan's "accept minor
   over-capture".** A permit lists several parties in one array; "every name on a
   record this org appears on" would have given a plumber the developer's name and
   manufactured false binding candidates. A name is claimed only when the
   (record, role) pair resolves to exactly one distinct name.
4. **Alias rule's identifier component is phone-aware** (corroborates 1 /
   contradicts 0 / neutral 0.5) rather than the planned flat 0.5 — mirroring the
   canonical exact-name path, so a contradicting phone correctly sinks the trust.

## Bonus fix (pre-existing, unrelated to this plan)
`apps/web/.../registry-review/actions.tsx` is a `"use client"` component that
imported the **value** `REVIEW_TIER_LABELS` from `@otn/resolution`, pulling the
server barrel — and `pg` — into the browser bundle. `next build` failed on HEAD
before any of my changes (verified by stashing). Fixed by making the import
type-only and restating the two button labels locally.

## Files Changed
| File | Action |
|---|---|
| `packages/db/migrations/0031_organization_aliases_unique.sql` | CREATED |
| `apps/worker/src/cli/alias-backfill.ts` | CREATED |
| `packages/db/migrations/meta/_journal.json` | UPDATED (idx 31) |
| `packages/db/src/schema.ts` | UPDATED (unique index) |
| `packages/resolution/src/normalize.ts` | UPDATED (`crossNameKey` now lives here) |
| `packages/resolution/src/registry-observations.ts` | UPDATED (re-export, alias rule, tier) |
| `packages/resolution/src/identifiers.ts` | UPDATED (persist + load aliases) |
| `packages/resolution/src/resolver.ts` | UPDATED (capture + `sourceId`) |
| `packages/resolution/src/review.ts` | UPDATED (`sourceId` threading) |
| `apps/worker/package.json` | UPDATED (`alias:backfill` scripts) |
| `apps/web/.../registry-review/page.tsx` | UPDATED (`matched_alias` evidence) |
| `apps/web/.../registry-review/actions.tsx` | UPDATED (evidence line + client-boundary fix) |
| `packages/resolution/src/registry-observations.test.ts` | UPDATED (+3 tests) |
| `apps/worker/test/resolution.test.ts` | UPDATED (+2 tests) |
| `apps/worker/test/registry-observations.test.ts` | UPDATED (+3 tests) |

## Tests Written
| File | Tests | Coverage |
|---|---|---|
| `packages/resolution/src/registry-observations.test.ts` | 3 | alias tier1/tier2; alias NEVER auto-binds |
| `apps/worker/test/resolution.test.ts` | 2 | capture on collapse + provenance; same-key skip; idempotency; blank alias |
| `apps/worker/test/registry-observations.test.ts` | 3 | no candidate pre-alias; `binding_alias_exact` review-only; ambiguous-alias skip |

## Governance preserved
- No alias auto-binds — `evaluateStrictBind` admits only canonical-name rules, and
  a test asserts an alias is refused even with every other signal perfect.
- Unknown = null: blank aliases rejected; absent source id stored as null, never guessed.
- Ambiguous alias (2+ entities) skipped, same guard as a canonical name.

## Next Steps
- [ ] **Phase 2 (registry L&I aliases)** — the lane with 306 real variants waiting
- [ ] Index registry-side aliases into `byNameKey` once the contract exposes them
- [ ] Optional Task 8 (business-address-city locality) as its own PRP
- [ ] `alias:backfill:apply` is safe to run but currently a no-op (0 variants)
