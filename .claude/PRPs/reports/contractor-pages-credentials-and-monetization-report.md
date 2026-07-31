# Implementation Report: Contractor pages — credential parity + monetization wiring

**Date:** 2026-07-31
**Plan:** `.claude/PRPs/plans/completed/contractor-pages-credentials-and-monetization.plan.md`
**Code repo:** BJJRegistry monorepo, branch `release/trades-staging` (npm)
**Commits:** `eca20d07` (ingestion, backfill, contract view, mirror guard) · `88493510` (credential card, empty state, monetization) · `4e162a2f` (principals + disclosure-policy hardening)
**Hosted DB:** `arbmeioglflvzoffgtii`

## Summary

Bond, general-liability insurance and L&I principals now render on every
contractor profile, flow through the Insights contract view, and the lead → claim
→ upsell loop the pages feed is wired. **All 8 tasks shipped.** Task 5 was held
for a day on an over-broad written boundary, then shipped once the owner narrowed
it — and the narrowing was made canonical and testable so it cannot drift back.

## Assessment vs reality

| Metric | Plan | Actual |
|---|---|---|
| Complexity | Large | Large — as scoped |
| Confidence | 8.5/10 | Justified; every load-bearing premise held except the two noted below |
| Files changed | ~10 | 17 (7 new, 10 modified) |
| Tasks | 8 | 8 shipped (T5 after an owner ruling) |

## Tasks

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Insurance ingestion (`ciwg-agsx`) | Complete | 76,180 source rows → 70,087 current policies |
| 2 | Settings-merge backfill | Complete | 75,845 checked, 69,491 insured; idempotent at `toWrite: 0` |
| 3 | Contract view + baseline mirror | Complete | 36 cols; mirror drift repaired + gated |
| 4 | Credential card | Complete | Verified on three live fixtures |
| 5 | Principals section | Complete (`4e162a2f`) | Held, then shipped after the owner narrowed the policy |
| 6 | Percentile + empty state | Complete, **deviated** | See "Deviations" |
| 7 | Monetization wiring | Complete | Two latent defects found and fixed |
| 8 | Close-out | Complete | All gates green |

## What the measurements changed

**The owner's correction was right and reordered the plan.** Bond data has been
ingested since OTN-4 at 99% coverage; it was never projected. The original
"no bond data exists" finding came from an `information_schema.columns` sweep,
which cannot see inside jsonb. Bond was a projection gap, not an ingestion
project.

**The expiry filter is currently a no-op — stated, not claimed as a save.** The
plan treated "drop expired policies" as the load-bearing difference from bonds.
Probed live: `ciwg-agsx` publishes **zero** rows with a past expiration date,
both at `licensestatus='A'` and unfiltered. L&I keeps only the current policy per
licence. The filter stays because the code must not depend on an unstated
publication invariant, but it saved nothing today.

What *was* load-bearing and unplanned: ~6k licences carry more than one active
policy, Socrata's `$order=contractorlicensenumber` does not break ties, and the
naive "latest expiration" comparison therefore picked whichever row pagination
yielded first. Two runs over identical data disagreed on 289 rows. Fixed with a
deterministic tiebreak on (expiration, effective, insurer).

**The join key needed normalizing on the tenant side.** `value_normalized`
strips non-alphanumerics; the tenant literal is the raw L&I spelling, which
includes `*` (`NEXTF**758MM` → `NEXTF758MM`). Plain `upper()` joins 63,172 of
75,845 identifier rows and silently loses 12,673 contractors. Stripping to
alphanumerics joins 75,845 of 75,845.

**The expression index is not optional.** The credential LATERAL is correlated
and its join key is computed, so the first build made a full view scan exceed the
statement timeout. With the index: 3.1s for 72,952 rows across 36 columns.

**The baseline mirror had already drifted five columns.** Migrations
20260724001000 and 20260725040000 changed `trades_identity_v1` without
re-mirroring, so a fresh `supabase db push` would have provisioned a contract
missing `aliases`, `brands`, `principals` and `google_name` — silently, since a
view that exists and returns rows looks healthy. Repaired, and
`npm run audit:contract-mirror` now enforces the rule.

## Coverage

| Fact | Coverage |
|---|---|
| Licensed tenants checked for insurance | 75,845 (100%) |
| …with a current policy | 69,491 (91.6%) |
| Entities with `bond_amount` via the contract | 72,261 of 72,952 (99.1%) |
| …meeting 2024 minimums | 66,807 |
| Entities with `insurance_amount` | 68,295 (93.6%) |
| Source licences with no matching tenant | 596 |

## Deviations from plan

**1. Percentile denominator (Task 6) — deliberate.** The plan specified "more
active than X% of 72,952 licensed WA trades contractors".
`contractor_activity_score_v1` holds **881 rows**; a score exists only where
public permit evidence does. Against 72,952 the *lowest*-scoring business would
read "more active than 98% of Washington contractors" — a number that measures
our source coverage and reports it as the contractor's performance. The rank is
computed against the scored population and the copy names that set explicitly.

**2. Task 5 — held one day, then shipped under a narrowed policy. See below.**

**3. Two fixes outside the written scope**, both discovered while executing 7a's
VERIFY-FIRST and both defects in the path the task had to use:
- `/api/leads` resolved the notification address from `settings` keys only.
  L&I-ingested tenants carry no email key of any kind, so a claimed contractor's
  lead would have been captured and never announced. Now falls back to
  `profiles.email` via `tenants.owner_id`.
- The endpoint's transactional copy was BJJ-only. A homeowner requesting a
  drywall estimate would have received "Welcome to the mats!" from "National BJJ
  Registry". BJJ strings preserved verbatim; other verticals get neutral copy
  under their own brand; sender address moved to `LEADS_FROM_EMAIL`.

## Task 5 — held, then shipped (`4e162a2f`)

The plan asks for an L&I principals section on the public contractor page at
99.99% coverage, matching BuildZoom's employees card.

Migration `20260724000000_registry_entity_principals.sql` states in its own
header: *"principals are private individuals … only NON-AGENT rows are ever
exposed, and then only to `otn_insights_reader`, the Insights seam role, whose
surfaces are all authenticated. **No public registry page, pSEO surface, or
unauthenticated route may read a principal.**"* A grep of `apps/registry/src`
confirms zero public renders today, so the boundary is intact and deliberate.

`/contractor/[slug]` is a public, indexable pSEO surface, so this was raised
rather than shipped unilaterally.

**Owner ruling (2026-07-31):** the sentence was written overly broadly. The true
intent was that we must not publish personal information *derived inside Trades
Insights*; L&I principals are public information. Shipped accordingly:

- Display-only list, attributed to L&I, scoped to the one business by UBI.
- `NOT pp.is_agent` — registered agents and law firms are never shown as officers.
- `principal_display`, never `principal_normalized` (a match key and inference
  input, not a name).
- **No cross-entity linking.** "Also runs 8 other companies" is an inference we
  built, not a fact L&I published about this business; it stays review-only.
- Section omitted entirely when L&I filed no principal.

**The durable output is the anti-drift work, not the section.** The rule now
lives in exactly one canonical place
(`docs/data/TRADES_PUBLIC_DATA_POLICY.md`), including the history and the
transferable lesson: *scope a prohibition to the RISK, not to the TABLE — if a
rule needs an exception within a week, it was written about the wrong noun.* The
original header carries its correction inline (comments only, no DDL change),
migration `20260731020000` puts the current rule on the table's `COMMENT`, and
six new security-suite assertions enforce the mechanical half. Those assertions
were negative-controlled: removing `NOT pp.is_agent` fails the suite.

Verified live on three shapes: one principal (Solis Interiors), six with the
plural heading (Advanced Alarm Systems), and correct omission (24/7 Electrical).
No `principal_normalized` and no policy number in rendered HTML.

## Verification

Live pages checked against hosted data:

| Fixture | State | Result |
|---|---|---|
| `solis-interiors-llc-lacey` | Bond + insurance | $15,000 Western Surety "Meets current WA minimum"; "Insured up to $1,000,000 — Ohio Security Ins Co · policy expires Feb 2027" |
| `1-2-3-plumbing-llc-tacoma` | Legacy bond | "$6,000 … Below current WA minimum" + the 2024-rules explanation |
| `2020-electric-company-llc-greenbank` | Neither | Both honest-absence rows render; JSON-LD omits both credentials |

- Unclaimed teaser: seeded one lead → "1 estimate request waiting", correct
  singular grammar, claim link carries `?from=contractor-profile&slug=…`.
  **Lead name and email appear nowhere in the HTML.** Test row deleted; `leads`
  back to 0.
- `policyno` / `insurancepolicyno`: **0 occurrences** in rendered HTML.
- Backfill idempotency: consecutive runs settle to `toWrite: 0`.

## Gates

| Gate | Result |
|---|---|
| `npm run build --workspace apps/registry` | Pass |
| `npm run test:security` | 70/70 pass (6 new policy assertions) |
| `npm run audit:pseo-quality` | Pass, 0 failures / 0 warnings |
| `npm run audit:contract-mirror` (new) | Pass — mirror identical, 8,077 bytes |
| `tsc --noEmit` (registry) | Clean |
| `eslint` on changed files | 0 errors (repo has 62 pre-existing elsewhere, none in these files) |

## Files changed

| File | Action |
|---|---|
| `apps/registry/scripts/lni-socrata.mjs` | CREATE |
| `apps/registry/scripts/backfill-lni-insurance.mjs` | CREATE |
| `apps/registry/supabase/migrations/20260731010000_trades_identity_bond_insurance.sql` | CREATE |
| `scripts/contract-baseline-mirror-audit.mjs` | CREATE |
| `apps/registry/scripts/ingest-wa-lni-contractors.mjs` | UPDATE |
| `db/baseline-v1.2/26_registry_public_trades_identity_v1_enrichment.sql` | UPDATE (drift repair) |
| `package.json` | UPDATE (`audit:contract-mirror`) |
| `apps/registry/src/lib/public-pages/gymProfilePageData.ts` | UPDATE (settings whitelist) |
| `apps/registry/src/app/contractor/[slug]/page.tsx` | UPDATE |
| `apps/registry/src/components/ContractorProfilePage.tsx` | UPDATE |
| `apps/registry/src/components/ContractorProfilePage.module.css` | UPDATE |
| `apps/registry/src/app/api/leads/route.ts` | UPDATE |
| `docs/data/TRADES_PUBLIC_DATA_POLICY.md` | CREATE (canonical policy) |
| `apps/registry/supabase/migrations/20260731020000_registry_entity_principals_public_policy.sql` | CREATE |
| `apps/registry/supabase/migrations/20260724000000_registry_entity_principals.sql` | UPDATE (comments only — correction in place) |
| `tests/security-regression-static.test.ts` | UPDATE (6 policy assertions) |
| `AGENTS.md` | UPDATE ("Traps this repo has already paid for") |

## Notes for next session

- **0 claimed trades tenants, 0 trades leads.** The notify path has no live
  recipients yet; it matters at the first claim. `RESEND_API_KEY` is absent from
  the registry's local env — confirm the hosted deploy carries it (and set
  `LEADS_FROM_EMAIL`) before relying on lead email.
- No MV refresh was required: the profile path reads `tenants` live, proven by
  the browser rendering just-backfilled insurance.
- Activity coverage remains fuel-capped (`unbound_with_strong_key = 0`). Growing
  the 0.86% needs licence-publishing sources, which is a separate plan.
