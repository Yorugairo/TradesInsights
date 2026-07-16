# Lacey Glass — sample opportunity briefing (S6)

> Sales-ready sample produced from the **live scored corpus** using the shared
> project graph, scoring, and decision-memo services — **no Lacey-specific
> product code**. Home and Commercial are configuration profiles
> (`config/account-profiles.yaml`); route selection dispatches on the account
> key, never a hard-coded organization id (guarded by the "S6 Lacey cost
> control" tests in `packages/intelligence/src/scoring.test.ts`). Every fact
> below is a stored, sourced record; scores are the deterministic §12
> calculation. Model-authored prose is intentionally absent (no keys) — these
> are the deterministic facts a customer sees today.

Generated: 2026-07-16. Scores are `SCORING_ALGORITHM_VERSION` 1.2.0.

## Lacey Glass at Home (residential glass) — 3 samples

| # | Opportunity | County / jurisdiction | Stage | Score / route | Why it fits | Source |
|---|---|---|---|---|---|---|
| 1 | Summit Place 2 Preliminary Plat (SEPA 202601712) | Thurston | entitlement (SEPA) | 82.5 · residential_glass | subdivision plat → repeatable SFR window/door/shower opportunity; in-territory | [Thurston Active Notices / WA SEPA](https://apps.ecology.wa.gov/separ/Main/SEPA/Record.aspx?SEPANumber=202601712) |
| 2 | Fredrickson Townhomes Preliminary Plat (SEPA 202601315) | Pierce | entitlement (SEPA) | 82.5 · residential_glass | townhome plat → repeatable glazing; Pierce is in the At Home territory | [WA Ecology SEPA Register](https://apps.ecology.wa.gov/separ/Main/SEPA/Record.aspx?SEPANumber=202601315) |
| 3 | The Cove At Long Lake (#25-0237) | Thurston | project page | 82.5 · residential_glass | named residential development on the City of Lacey current-projects listing | [cityoflacey.org](https://cityoflacey.org/projects/25-0237-the-cove-at-long-lake/) |

**At Home caveat (honest):** these are **entitlement-stage** plats — the glass
work is 12–24 months out. They are correctly scored as *radar / early pipeline*
(strong repeatable-units fit, early timing), not imminent bids. That is exactly
the "get in before the GC is selected" signal the profile targets.

## Lacey Glass Commercial (Division 08 glazing) — 2 samples

| # | Opportunity | County / jurisdiction | Stage | Score / route | Why it fits | Source |
|---|---|---|---|---|---|---|
| 4 | Vashon Medical clinic (ADDC25-0677) | King | permit applied | 83.0 · division_08 | commercial medical clinic addition/alteration → storefront/entrance glazing; King routes to Commercial | [King County permit reports](https://cdn.kingcounty.gov/-/media/king-county/depts/local-services/permits/reports/kingcounty-new-applications-2026-06.xlsx) |
| 5 | Alcott Elementary School CUP (CDUP25-0001) | King | entitlement (CUP) | 75.5 · division_08 (radar) | public-work institutional project → curtain wall / translucent systems; **v1.2.0 correctly moved this to weekly-digest/radar** — a bare CUP has no confirmed glazing scope yet | [King County public notices](https://kingcounty.gov/en/dept/local-services/buildings-property/public-notices-permit-records-search/public-notices) |

## Reviewed miss — filter shipped (scorer v1.2.0)

The S6 review flagged demolition/entitlement projects over-scoring `division_08`.
The **v1.2.0 negative filter** (`packages/intelligence/src/scoring.ts`) now
demotes them, with **no eval regression** (dev 100%/96.8%, holdout 100%/93.5% —
identical to the M4.2 baseline; it demotes false positives, never a labeled
positive):

- **Clean demolitions** (removal, no new envelope) → `division_08_system_fit`
  0.2 — e.g. Seattle "– Demolition" permits dropped from priority to
  weekly-digest (65). **182** commercial projects reclassified.
- **Bare entitlement actions** (CUP/rezone/variance, no construction scope) →
  0.4 radar — e.g. Alcott (above) moved 83 → 75.5. **243** projects
  reclassified.

**Honest residual (not force-demoted, and correctly so):** the SpaceX SE04 /
SE06 and KCIA "DEMO" records that first looked like clean demolitions turned out
on inspection to be **mixed campus clusters** — a demolition co-resolved with a
cleanroom **tenant-improvement / interior remodel** and fire permits on the same
site. Those genuinely carry building scope, so the filter (rightly) leaves them
alone. Their remaining over-score is a *different* problem — a `hasGlazing`
keyword firing on campus text plus large valuation — logged as a separate
`§22` item (glazing-precision / cluster-scope), **not** something to fix by
weakening the demolition rule and risking real glazing work. The honest miss is
part of the deliverable.

## What this sample demonstrates

- The same shared pipeline that serves Solis produces Lacey Home and Commercial
  briefings with **zero bespoke Lacey code** (S6 exit gate).
- Every delivered fact is sourced; scores are deterministic; early-stage items
  are labeled as pipeline/radar, not imminent bids (a permit/plat is not a bid).
- Where the scorer is wrong, the review says so and files a calibration item
  rather than shipping a confident false positive.

**Not built for Lacey (per addendum §2):** no Lacey-only adapters, dashboards,
private integrations, or workflows — those wait on a paid commitment.
