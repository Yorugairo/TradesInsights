# Implementation Report: Brand-vs-enterprise identity

**Date**: 2026-07-23 · **Registry**: `d0999bc2` on `release/trades-staging` · **Insights**: `77196f6` on `claude/tmux-install-320aiz`

## Summary
Insights now models the **operating brand**; the registry stays authoritative for
the **legal entity**; they link many-to-one via `registry_ref`. The enabling
mechanism is a brand-scoped identity backfeed — an accept stamps only the matched
brand's licence instead of the entity's whole array.

## Proof it works (live)
The two Apollo orgs now carry **different** brand licences, so accepting both
keeps them apart:

| Insights org | Entity | Matched brand | Licence |
|---|---|---|---|
| `APOLLO MECHANICAL CONTRACTORS` | Apollo Heating & A/C | Apollo Mechanical Contractors | `APOLLMC795NR` |
| `APOLLO SHEET METAL` | Apollo Heating & A/C | Apollo Sheet Metal Inc | `APOLLSM006J6` |
| `DEAR ELECTRIC` | Dear Services | Dear Electric Inc | `DEAREEI864PN` |
| `DEAR SERVICES` | Dear Services | Dear Services | `DEARSS*798ND` |
| `2 SONS PLUMBING LLC` | Fischer Services | 2 Sons Plumbing | `2SONSSP759CF` |

Conversely `Christian's Roofing Corp` has exactly **one** brand, so its three
spelling variants share a licence and still collapse — the owner-approved outcome.

## Assessment vs Reality
| Metric | Predicted | Actual |
|---|---|---|
| Complexity | Large | Large |
| Confidence | 9/10 | Single-pass; 3 deviations, all justified |
| Files | ~12 | 11 |

## Tasks
| # | Task | Status | Notes |
|---|---|---|---|
| D1 | `brands` on the contract | Complete | 28 cols, 25,545 rosters, 228 multi-brand |
| C1 | Insights reads `brands` | Complete | 3-step 42703 ladder |
| C2 | Record which brand matched | Complete | payload + snapshot |
| C3 | `registry_brand_ref` column | Complete | migration 0032, nullable |
| C4 | Brand-scoped backfeed | Complete | Deviated — added single-licence fallback |
| A1 | Narrow collapse to licence | Complete | UBI arm dropped |
| B1 | Enterprise rollup | Complete | Deviated — TS reader, no view |

## Deviations from Plan
1. **B1 ships as a TS reader, not a migration + view.** Views in this repo live in
   `insights_public` and exist for *registry* consumption; the enterprise rollup
   is Insights-internal, and its closest sibling `orgActivityRollup` queries
   tables directly. Migration 0033 was dropped as unnecessary surface.
2. **C4 gained a single-licence fallback** the plan didn't specify. Strict-bind
   fixtures (and any pre-`brands` contract) carry no brand, which would have left
   those orgs with no licence at all — silently disabling the WS-B.4 collapse for
   the single-brand majority. When an entity holds **exactly one** licence there
   is no ambiguity, so that licence is used; two or more ⇒ unknown ⇒ none. This is
   a no-guess rule, not a relaxation.
3. **Two existing tests changed meaning, deliberately.** The WS-B.4 test and the
   Phase-1 alias-capture test both collapsed via **UBI**. They now exercise the
   licence, and the WS-B.4 test gained an explicit assertion that a shared UBI
   must **not** collapse two orgs.

## Validation
| Level | Status | Notes |
|---|---|---|
| Static analysis | Pass | 0 type errors; 0 lint errors in changed files |
| Unit + integration | Pass | **784/784**, 4/4 consecutive clean runs |
| Build | Pass | `next build` compiled |
| Migration | Pass | 0032 applied via the test harness |
| Contract | Pass | 28 cols, `brands` last, reader grant verified |
| End-to-end | Pass | 21 candidates regenerated with brand attribution, 0 auto-bound |

## Issues Encountered
- **Local test-DB pollution twice.** Orphaned `organization_identifiers` blocked
  `resetSource`, and 5 leftover `test_*` account profiles broke
  `accounts.test.ts` ("three seeded pilot accounts") deterministically 3/3. Both
  were residue from a run whose `afterAll` errored — not code defects. Cleaned,
  and the alias block's `afterAll` now deletes the identifiers its new test
  stamps.
- **All 255 pending candidates predated brand attribution.** 21 sat on
  multi-brand entities, where accepting would have been safe but incomplete (no
  brand pin, no licence). Those 21 — unreviewed `pending` rows only, no human
  decision discarded — were deleted and regenerated with brand data. The 234 on
  single-brand entities were left alone: the single-licence fallback pins them
  correctly without regeneration.

## Tests Written
| File | Tests | Coverage |
|---|---|---|
| `apps/worker/test/registry-observations.test.ts` | 1 | brand-scoped accept stamps ONE licence, pins `registry_brand_ref`, keeps enterprise UBI |
| `apps/worker/test/resolution.test.ts` | updated | licence collapses; **UBI must not**; alias capture via licence |

## Next Steps
- [ ] Owner: review the 21 brand-attributed candidates at `/app/admin/registry-review`
- [ ] Decide on retroactive treatment of orgs bound before this shipped (they keep
      their legacy licence arrays; NULL-only rules never removed them)
- [ ] Surface `enterpriseRollup` in the UI/digest when there's a consumer
- [ ] Phase 4 — free Google Places enrichment for unbound orgs
