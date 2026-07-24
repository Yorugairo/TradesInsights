# Implementation Report: Queue cockpit — Phase C (the cockpit shell)

## Summary
Phase C of `queue-cockpit.plan.md` — the front door that unifies all six
identity/enrichment review lanes into one landing page at `/app/admin/cockpit`,
ordered by the owner's priority (work-now → chunk-it-down → match-lanes). This is
the direct Solis-facing value and the reason Phase A was backlogged to reach it
sooner. The plan stays in `plans/` (phased — B and D remain; revised order
C → B → D).

## Assessment vs reality
| Metric | Plan | Actual |
|---|---|---|
| Complexity | part of Large–XL plan | Phase C alone = Small |
| Files changed | 3 groups (C1/C2/C3) | 2 created, 4 updated |
| New questions during impl | 0 (self-contained) | 0 |

## Tasks completed
| # | Task | Status | Notes |
|---|---|---|---|
| C1 | `cockpit-summary.ts` (+ test) | Complete | `queueSummary(db, pool)`; one canonical count per lane |
| C2 | `/app/admin/cockpit` page | Complete | mission panel + owner-ordered cards |
| C3 | breadcrumbs | Complete | "← cockpit" on review, registry-review, corporate-families |

## What was built
| File | Action | Purpose |
|---|---|---|
| `packages/intelligence/src/cockpit-summary.ts` | CREATE | `queueSummary` — resolution/registry/families/googlePlace/lanes, each from the same source its queue page reads |
| `packages/intelligence/src/cockpit-summary.test.ts` | CREATE | 2 unit tests: null-pool contract + canonical sum / cluster-cap |
| `packages/intelligence/src/index.ts` | UPDATE | export the new module |
| `apps/web/app/app/admin/cockpit/page.tsx` | CREATE | the landing page |
| `apps/web/app/app/admin/review/page.tsx` | UPDATE | "← cockpit" breadcrumb |
| `apps/web/app/app/admin/registry-review/page.tsx` | UPDATE | "← cockpit" prepended to existing crumbs |
| `apps/web/app/app/admin/corporate-families/page.tsx` | UPDATE | "← cockpit" prepended to existing crumb |

## Key design decisions (verified live, not assumed)
1. **`googlePlace` is `null` today, by construction — not a bug and not a zero.**
   The live catalog exposes only `registry_public.{trades_activity_v1,
   trades_identity_v1, trades_taxonomy_v1}` (queried this session). The Place
   queue lives in `registry_internal`, which Insights must never read; the
   `registry_public.google_place_review_v1` view that would expose it is a
   Phase D deliverable (Task D2). `googlePlaceSummary` probes that view name and
   catches the missing-relation error → `null`. When Phase D ships the view with
   the three integer columns, this section lights up with **no change to C1**.
   The card shows the three chunk *definitions* + a clearly-dated manual snapshot
   (2026-07-24: ~272 / 926 / 1,081), never a live-looking number.
2. **`families` is also `null` without the seam** — it derives from the registry
   identity view, so it degrades the same honest way `googlePlace` does. The
   plan only annotated `googlePlace` nullable; `families` shares the same
   dependency and the same "null, never zeroed" discipline.
3. **One canonical count per lane.** `resolutionReview` = sum over
   `triageReviewQueue` clusters (the exact bulk-decision surface the review page
   uses); `registryReview` = a pending-observations group-by; `families` = the
   same `buildFamilies` + `matchPrincipalsToPeople` the families page runs. No
   page-local recount that could drift.
4. **`enrichmentPhoneCandidates30d` counts the live phone-match lane**
   (`binding_phone_match` + `binding_google_phone_match`, last 30d) — an honest
   `0` today (unfueled; Phase A backlogged). The field name is kept from the plan
   so Phase A's fuel lands in the same lane with no rename.
5. **Privacy preserved:** the cockpit renders aggregate integers only — no
   principal or person names — so the family data's admin-only, names-never-leave
   contract is intact even though the cockpit summarizes it.

## Validation
| Level | Result |
|---|---|
| Typecheck (`@otn/intelligence`, `@otn/web`) | clean |
| ESLint (new/edited files) | clean |
| Unit (`packages/intelligence`) | 160/160 pass (2 new) |
| Build (`@otn/web`) | clean; `/app/admin/cockpit` = `ƒ` dynamic |
| Edge cases | null pool ⇒ families+googlePlace null; empty DB ⇒ zeros; clusters capped at 5; thousands-formatted |

## Deviations
- **`families` made nullable** (plan annotated only `googlePlace`). Reason: it
  structurally needs the registry pool; a fake zero would misrepresent an
  offline seam. Consistent with the plan's own null-not-zeroed rule.
- **No live Google Place counts wired** — impossible until Phase D builds the
  `registry_public` view (verified against the live catalog). C1 is written to
  consume it the instant it exists.

## Next steps
- [ ] Phase B — corporate-family accept → registry relationship export (closes
      the loop: accepted pairs feed `registry_observations` → the export lane).
- [ ] Phase D — Google Place: build the 926-row auto-resolver + the
      `registry_public.google_place_review_v1` view (lights up the cockpit's
      Place card) + the `/app/admin/google-place-review` UI (+ its "← cockpit"
      breadcrumb, the deferred half of C3).
- [ ] BACKLOGGED: Phase A (PALS + Google enrichment), Phase E (domain).
