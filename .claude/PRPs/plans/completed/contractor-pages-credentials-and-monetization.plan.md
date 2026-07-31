# Plan: Contractor pages — credential parity with BuildZoom + monetization wiring

> **Working doc + source of truth.** Every number was measured live on 2026-07-28 during
> planning (hosted DB `arbmeioglflvzoffgtii` + live Socrata probes). One planning claim was
> made, disproven, and corrected the SAME DAY — it is recorded in GROUND TRUTH because the
> correction is load-bearing for the implementer.

## Summary

Bring `/contractor/[slug]` to credential parity with BuildZoom's profile pages on
**every** page (not just the 0.86% with permit activity), then wire the monetization loop
that the pages feed: lead capture → claim → WaaS/Insights upsell. The decisive discovery:
**bond data already exists at 99% coverage** in `tenants.settings` jsonb (projection gap,
not ingestion), and the missing insurance data is one more Socrata dataset (`ciwg-agsx`)
on the **same join key the bond pull already uses** — BuildZoom's insurance widget is
demonstrably rendered from this exact dataset.

## User Story

As **a homeowner or GC evaluating a contractor** I want licence, bond, insurance and
principal facts on the profile page, so I can trust it enough to request an estimate —
and as **the owner**, I want that trust surface to feed leads, claims, and Insights
subscriptions.

## Problem → Solution

Profile pages render licence + Google + sparse permit activity; bond sits unprojected in
a jsonb blob, insurance was never ingested, principals (99.99% coverage) never render. →
Credential-complete pages at ~full coverage, with the lead/claim/upsell loop instrumented.

## Metadata

- **Complexity**: Large (~2 scripts, 1 migration + baseline mirror, ~6 component/API files, 2 repos)
- **Repo(s)**: REGISTRY monorepo (**npm**, branch `release/trades-staging`) for everything;
  TradesInsights only hosts this plan file.
- **Branch GOTCHA**: the existing registry worktree checkout is on the gobjj branch, NOT
  `release/trades-staging`. Create/use a worktree on `release/trades-staging` before
  touching code. Never target `main` ([[main-branch-dead-staging-is-trunk]] applies to the
  BJJ side; trades trunk is `release/trades-staging`).

---

## GROUND TRUTH — measured 2026-07-28

### The correction that reorders everything

The first planning pass declared "no bond/insurance data exists anywhere" from an
`information_schema.columns` sweep. **WRONG — a column-name sweep cannot see inside
jsonb.** `ingest-wa-lni-contractors.mjs` has stored bond facts in `tenants.settings`
since OTN-4/5. Measured live:

| Metric | Value |
|---|---|
| Trades tenants | 75,845 |
| …with `settings.bond` ({amount, surety, effectiveDate, meetsCurrentMinimum}) | **75,092 (99%)** |
| …meeting the 2024 $30k/$15k minimums | 67,619 |
| …with any insurance key | **0** |

### Insurance: source verified live

`https://data.wa.gov/resource/ciwg-agsx.json` — "L&I Contractor License Data - Insurance",
**76,180 rows at `licensestatus='A'`**, keyed `contractorlicensenumber` (identical to the
bond dataset `bzff-4fmt` join). Fields: `insurancecompany`, `insuranceamt`,
`effectivedate`, `expirationdate` (**real dates** — unlike bonds' `'Until Canceled'`
sentinel — so expired rows must be filtered), `insuranceagencyname`, `insurancepolicyno`.
The `$limit=1` probe returned **"Ohio Security Ins Co / $1,000,000" — byte-identical to
BuildZoom's Solis sidebar.** Their insurance widget IS this dataset.

### Page + coverage reality (why credentials-first, not activity-first)

| Field | Coverage of 72,952 trades entities |
|---|---|
| UBI + registered address | 100% |
| Bond (post-projection) | 99% |
| Principals (`registry_internal.registry_entity_principals`, 74,193 rows) | **99.99%** |
| trade_codes | 97% |
| Insurance (post-ingestion) | ~90%+ est. |
| Google rating | 4.8% |
| **Permit activity** (`trades_activity_v1`) | **0.86% (624 rows)** |

`ContractorProfilePage.tsx` (trades-staging) renders: Verified credentials, Claim band,
Permit activity, Contact, Google business profile, Website, Request an estimate. It has
**9** activity-score refs and **0** principal refs. `/api/leads` already exists: zod
schema, per-tenant origin allow-list, `INSERT INTO leads`. Lead **capture** works; lead
**notification, teaser, and funnel instrumentation** do not exist.

### Binding is FUEL-capped (scope boundary)

Of 2,659 business-named Insights orgs: 509 bound and **`unbound_with_strong_key = 0`** —
every org with a UBI/licence number is already bound. Activity coverage grows ONLY via
licence-publishing sources (PALS-class), which is a separate sources plan. This plan
treats 0.86% activity as fixed and designs around it.

---

## UX Design

| Touchpoint | Before | After |
|---|---|---|
| Credential card | licence + status | + bond (amount, surety, **meets-2024-minimum badge**), + insurance (insurer, insured up to $X, expires), honest "No active bond on file with L&I" when absent — absence is information |
| New: Principals section | — | L&I principals (public record, display-only), ~every page |
| Activity section | renders sparse/empty for 99% | credentials-first layout; activity only when ≥1 row; percentile framing on the existing score refs: "more active than X% of 72,952 licensed WA trades contractors" (say the denominator is trades-scoped; BuildZoom's 128,670 is all licence types) |
| Estimate form (exists) | insert-only | claimed tenant notified; unclaimed sees claim-band teaser "N estimate requests waiting — claim to respond" |
| Claim band (exists) | static CTA | instrumented funnel: view → estimate → claim → WaaS/Insights |
| Claimed profile | — | Insights upsell band ("See every project in {county} before it breaks ground") |

**Monetization constraint (hard):** never pay-to-rank — the methodology page commitment
stands. We sell leads, sites, and intelligence; never position.

---

## Mandatory Reading

| Priority | File (registry repo, `release/trades-staging`) | Why |
|---|---|---|
| P0 | `apps/registry/scripts/ingest-wa-lni-contractors.mjs` | The bond join to mirror verbatim for insurance; `ON CONFLICT DO NOTHING` gotcha lives here; header documents the 53100 disk-space refresh failure + `--skip-refresh` |
| P0 | `apps/registry/supabase/migrations/20260720150000_surface_google_and_trades_in_trades_identity_v1.sql` | Additive contract-view pattern (cols append, positions keep, grant re-asserted) AND the drift rule: **body must stay byte-identical with `db/baseline-v1.2/26_…_enrichment.sql`** |
| P0 | `apps/registry/src/components/ContractorProfilePage.tsx` | Section markup/style pattern; where credential card, principals, and empty-state changes land |
| P0 | `apps/registry/src/app/api/leads/route.ts` | Zod + per-tenant origin allow-list + insert — T7 extends, never re-derives |
| P1 | `apps/registry/scripts/entity-resolution/backfill-lni-principals.mjs` | How principals were loaded; the table T5 reads |
| P1 | `apps/registry/src/lib/public-pages/serviceDirectoryData.ts` | Where page data is fetched; new fields flow through here |
| P1 | registry `AGENTS.md` | Scoped refresh calls only (`source_mvs` then `state:WA`, never `all`); use `scripts/refresh-registry-source-mvs.mjs` (`d7d3696f`) — one statement at a time |
| P2 | `apps/registry/src/app/api/badges/contractor/[slug]/route.ts` | Badge/claim surface conventions |

## Patterns to Mirror

### THE_BOND_JOIN (extend for insurance — same shape, different sentinel)
```js
// SOURCE: apps/registry/scripts/ingest-wa-lni-contractors.mjs (verbatim)
//   bzff-4fmt: licensestatus='A' AND bondexpirationdate='Until Canceled'
//   fields: contractorlicensenumber,bondamt,bondfirmname,bondeffectivedate
const bondByLicense = new Map();
for (const bond of bonds) {
  const key = bond.contractorlicensenumber;
  const existing = bondByLicense.get(key);
  if (!existing || String(bond.bondeffectivedate) > String(existing.bondeffectivedate)) {
    bondByLicense.set(key, bond);
  }
}
// settings: { ..., bond: { amount, surety: titleCase(bond.bondfirmname), effectiveDate,
//                          meetsCurrentMinimum: bondAmount >= requiredMinimum } }
```
Insurance differs in exactly one way: **no `'Until Canceled'` sentinel** — filter
`expirationdate > now` and keep the latest by `expirationdate`.

### CONTRACT_VIEW_ADDITIVE
CREATE OR REPLACE `registry_public.trades_identity_v1`; existing columns keep
name/type/position; new columns append; `otn_insights_reader` grant re-asserted;
migration body copied byte-identical into `db/baseline-v1.2/`.

### LEAD_ENDPOINT (extend)
`/api/leads`: zod parse → `isAllowedLeadOrigin(origin, tenantId)` (reads
`tenant_websites`/`tenant_website_domains`) → parameterized INSERT. New behavior is added
AFTER the existing insert, never replacing the validation stack.

---

## Files to Change (registry repo unless noted)

| File | Action | Justification |
|---|---|---|
| `apps/registry/scripts/ingest-wa-lni-contractors.mjs` | UPDATE | `ciwg-agsx` pull + `settings.insurance` for future runs |
| `apps/registry/scripts/backfill-lni-insurance.mjs` | CREATE | Settings-MERGE backfill for the 75,845 existing tenants (see T2 gotcha) |
| `apps/registry/supabase/migrations/<ts>_trades_identity_v1_bond_insurance.sql` | CREATE | Project bond + insurance through the contract view |
| `db/baseline-v1.2/<n>_trades_identity_v1_bond_insurance.sql` | CREATE | Byte-identical mirror (the 20260720 header's own rule) |
| `apps/registry/src/lib/public-pages/serviceDirectoryData.ts` | UPDATE | Fetch bond/insurance/principals |
| `apps/registry/src/components/ContractorProfilePage.tsx` | UPDATE | Credential card, principals section, credentials-first empty state, percentile copy |
| `apps/registry/src/app/api/leads/route.ts` | UPDATE | Post-insert notification hook (T7) |
| `apps/registry/src/components/` (claim band / upsell band) | UPDATE/CREATE | Teaser counts, Insights band, funnel events |
| TradesInsights `docs/STATUS.md` + this plan | UPDATE | Close-out |

## NOT Building

- **No activity-coverage expansion** — fuel-capped (`unbound_with_strong_key = 0`);
  licence-publishing sources are a separate plan.
- **No native reviews.** Google rating stays the only third-party signal.
- **No pay-to-rank anything** — placement is never sold; the methodology page commitment
  is a hard constraint on every monetization task.
- **`insurancepolicyno` is never rendered** on a public page (store-nothing preferred;
  it has no display use).
- **No new lead marketplace** — leads route to the profiled contractor only.
- **No Insights-side changes** — the seam consumes the widened view when it wants to;
  cols are additive so nothing breaks.

---

## Step-by-Step Tasks

### Task 1: Insurance ingestion (`ciwg-agsx`)
- **ACTION**: Extend `ingest-wa-lni-contractors.mjs` with the insurance dataset alongside bonds.
- **IMPLEMENT**: Fetch `licensestatus='A'` with
  `$select=contractorlicensenumber,insurancecompany,insuranceamt,effectivedate,expirationdate`;
  keep latest per licence by `expirationdate`, **drop rows with `expirationdate <= now`**;
  write `settings.insurance = {company: titleCase, amount: Math.round(Number(insuranceamt)),
  effectiveDate, expirationDate}`. No policy number.
- **MIRROR**: THE_BOND_JOIN, same pagination (`SOCRATA_PAGE_SIZE`), same stats line (`insured: N`).
- **GOTCHA**: real expiration dates ≠ bonds' sentinel — an unfiltered "latest effective"
  would happily surface a lapsed policy as current.
- **VALIDATE**: `--dry-run` prints sample settings with both `bond` and `insurance`; counts ≈ 76k source rows → ~70k+ current.

### Task 2: Settings-merge backfill for EXISTING tenants
- **ACTION**: `backfill-lni-insurance.mjs` — because the ingest insert is
  `ON CONFLICT DO NOTHING`, **extending Task 1 alone changes zero existing rows**.
- **IMPLEMENT**: Build the same insurance map, then batched
  `UPDATE tenants SET settings = settings || $ins WHERE settings->>'licenseNumber' = $lic`
  (VERIFY the exact settings licence key name in the ingest script first — locate, don't
  assume). Dry-run default; report {matched, updated, alreadyCurrent, licenceNotFound}.
- **MIRROR**: CLI conventions of the sibling backfill scripts (`backfill-lni-principals.mjs`).
- **GOTCHA**: merge (`||`), never replace — `settings` carries licence/bond/tags; a SET to
  a fresh object destroys the page. Also [[trades-db-missing-migration-ledger]]: effects
  must be verifiable by query, so log before/after counts.
- **VALIDATE**: hosted dry-run ≈75k matches; apply; re-run reports ~0 updated (idempotent);
  spot-check 3 tenants incl. one with no insurance row (settings untouched).

### Task 3: Project bond + insurance through `trades_identity_v1`
- **ACTION**: Contract-view migration appending `bond_amount, bond_surety,
  bond_meets_minimum, insurance_company, insurance_amount, insurance_expires`.
- **IMPLEMENT**: LATERAL join from entity `contractor_numbers` to `tenants` settings
  (first matching licence wins, mirroring how the view already picks per-entity values).
  Re-assert `otn_insights_reader` grant. Mirror body into `db/baseline-v1.2/`.
- **MIRROR**: CONTRACT_VIEW_ADDITIVE (the 20260720150000 file IS the template, including
  its drift-capture header discipline).
- **GOTCHA**: additive only — Insights reads this view by column; and keep both copies
  byte-identical or the next `db push` silently drops the enrichment (that exact drift
  already happened once; the 20260720 header documents it).
- **VALIDATE**: view returns 27+ cols; count with `bond_amount IS NOT NULL` ≈ 75k-scale;
  `security_invoker = false` preserved.

### Task 4: Credential card on the contractor page
- **ACTION**: Render bond + insurance in the Verified-credentials section.
- **IMPLEMENT**: Bond: "$12,000 bond — RLI Ins Co" + badge `Meets 2024 minimum` /
  `Below current minimum` (from `meetsCurrentMinimum`; the legacy $12k/$6k explanation is
  one line of muted copy). Insurance: "Insured up to $1,000,000 — Ohio Security Ins Co ·
  expires Jun 2027". Absent: "No active bond on file with L&I" — never hide the row.
- **MIRROR**: existing `<section aria-label=…>` + `styles.card` markup.
- **GOTCHA**: L&I remains the stated authority ("per WA L&I, updated nightly") — that
  provenance line is the beat-BuildZoom move (theirs says "as of July 2026").
- **VALIDATE**: build renders Solis's real slug with bond+insurance; a no-bond fixture
  renders the honest-absence row.

### Task 5: Principals section
- **ACTION**: New section from `registry_internal.registry_entity_principals` via a
  public-safe read path (add to the contract view or a sibling `_v1` view — decide by
  mirroring how the page reads other registry_internal-derived data in
  `serviceDirectoryData.ts`).
- **IMPLEMENT**: Name + role list, matching BuildZoom's "employees" card at 99.99%
  coverage. Display-only.
- **GOTCHA**: principal↔person DISCOVERY stays review-only ([[corporate-family-tier]]) —
  no links between entities via shared principals on the public page. That inference is
  the thing we deliberately do not ship.
- **VALIDATE**: Solis page lists its L&I principals; an entity with zero rows omits the
  section (not an empty card).

### Task 6: Percentile framing + credentials-first empty state
- **ACTION**: Extend the existing activity-score rendering (9 refs already in the page).
- **IMPLEMENT**: "More active than X% of 72,952 licensed WA trades contractors" with the
  trades-scoped denominator stated; when `trades_activity_v1` has no row, the activity
  section collapses to a one-line "No permit activity observed in our coverage window"
  under the credential card — never an empty chart.
- **GOTCHA**: 99.1% of pages take the empty path — it is the DEFAULT layout, design it as
  such; the 624 rich pages are the exception.
- **VALIDATE**: both layouts in a browser; percentile matches a hand SQL check for 2 entities.

### Task 7: Monetization wiring
- **ACTION**: Close the loop the pages feed. Three seams, all behind the existing
  never-pay-to-rank line:
  - **7a Lead notify (claimed)**: post-insert hook in `/api/leads` → email the claimed
    tenant. **VERIFY-FIRST**: locate the registry repo's transactional email path and
    whether prod env carries its keys ([[gobjj-staging-email-auth-config]] was a CONFIG
    failure — do not repeat it silently). If keys are absent, ship the write + an
    owner-gated TODO in STATUS, and the in-app teaser still works.
  - **7b Unclaimed teaser**: claim band shows `COUNT(leads WHERE tenant_id=…)` — "2
    estimate requests waiting — claim your profile to respond." No lead content shown.
  - **7c Funnel events + Insights band**: instrument view→estimate→claim; claimed
    profiles get the Insights upsell band linking to the trades cockpit.
- **MIRROR**: LEAD_ENDPOINT stack untouched; teaser reads via the same tenant-scoped
  query patterns as `teaser-metrics/route.ts`.
- **GOTCHA**: notification must never fail the lead insert (the GoBJJ
  `recordMemberNotification` contract: capture is the business transaction).
- **VALIDATE**: lead POST inserts + (keys permitting) sends; unclaimed page shows count
  without leaking content; events land.

### Task 8: Close-out
- Registry gates: `npm run build` (registry workspace), security suite, pSEO gate
  (the phase-3.5 precedent), any new tests **registered on the root `test:security`
  explicit file list** if security-adjacent.
- Run ingest+backfill against hosted; apply migration; scoped MV refresh only via
  `scripts/refresh-registry-source-mvs.mjs` (never `all`; 53100 disk history).
- STATUS + memory close-out; archive plan + report (in THIS repo's PRPs dirs, and note
  the cross-repo commits inline per [[valuation-truth-and-plan-closeout]]'s close-out rule).

---

## Validation Commands

```bash
node apps/registry/scripts/ingest-wa-lni-contractors.mjs --dry-run
```
```bash
node apps/registry/scripts/backfill-lni-insurance.mjs           # dry-run default
```
```bash
npm run build --workspace apps/registry
```
Plus: registry security suite + pSEO gate (locate exact script names in root
`package.json` on trades-staging before running — npm, not pnpm).

## Acceptance Criteria
- [ ] `settings.insurance` present at ~90%+ of trades tenants after backfill; idempotent re-run
- [ ] `trades_identity_v1` carries bond+insurance columns; baseline mirror byte-identical
- [ ] Solis's page shows licence + bond + insurance + principals — superset of BuildZoom's sidebar, with fresher provenance
- [ ] 99%-case page (no activity) looks complete, not hollow
- [ ] Leads notify claimed tenants (or owner-gated TODO recorded); unclaimed teaser live; zero lead-content leakage
- [ ] No pay-to-rank surface introduced; policy numbers nowhere in HTML
- [ ] All gates green on `release/trades-staging`

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Settings licence-key name assumed wrong in backfill | Med | High (0 rows match) | T2 locate-first; dry-run match count ≈75k is the gate |
| Baseline mirror drifts from migration | Med | High (silent contract loss on next push) | The 20260720 header's byte-identical rule; diff in CI-less repos by hand at close-out |
| Email keys absent in registry prod | Med | Med | 7a VERIFY-FIRST; teaser path independent |
| Expired policies rendered as current | Low (encoded) | High (false trust claim) | expiration filter + test fixture |
| MV refresh disk blowup on full run | Known | Med | `--skip-refresh` + scoped per-statement driver (`d7d3696f`) |

## Notes

BuildZoom's Solis page vs ours after this plan: they win on reviews (we don't compete
yet) and nationwide permit history; we win on licence freshness (nightly vs dated
snapshot), bond minimum-compliance framing, principals coverage, trade-scoped percentile
honesty, and — on the 624 activity-rich pages — permit depth with stated valuations.
Monetization stays layered: free claim → WaaS site → Insights subscription, with leads as
the hook, never the product sold to the searcher.

## Plan history

**2026-07-28 — v1.** Measurement-first. The bond "ingestion project" premise from the
inline Phase-0 was disproven by the owner's recollection + a jsonb-aware re-measure
(99% coverage already stored); insurance confirmed one dataset away on the same join key.
Recorded in [[contractor-page-competitive-ceiling]] with the column-sweep lesson.

---

## SHIPPED 2026-07-31 — registry `eca20d07` + `88493510` (`release/trades-staging`)

Tasks 1, 2, 3, 4, 6, 7, 8 complete. Report:
`.claude/PRPs/reports/contractor-pages-credentials-and-monetization-report.md`.

**Task 5 (public principals section) is NOT shipped — HELD for an owner
decision.** Migration `20260724000000_registry_entity_principals.sql` states in
its own header that no public registry page, pSEO surface, or unauthenticated
route may read a principal, and a grep confirms zero public renders exist today.
`/contractor/[slug]` is exactly such a surface, so shipping it would put ~74,193
named private individuals onto indexable pages against a written policy, and it
is not reversible once crawled. The data is already available as column 29 of
`trades_identity_v1` if the owner approves.

**Task 6 deviated deliberately.** The specified denominator (72,952 licensed
contractors) would have made the lowest-scoring business read "more active than
98% of Washington contractors", because `contractor_activity_score_v1` holds only
881 rows — one per business with permit evidence. The rank is against the scored
population, and the copy says so.

**Corrections to this plan's own premises, recorded rather than dropped:** the
insurance expiry filter is currently a no-op (L&I publishes zero expired rows);
the real hazard was tied expiration dates, which Socrata's ordering does not
break. The tenant-side join key needs non-alphanumerics stripped or 12,673
contractors are silently lost. The baseline mirror had already drifted five
columns before this plan started.
