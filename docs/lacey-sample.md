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

Generated: 2026-07-16. Scores are `SCORING_ALGORITHM_VERSION` 1.3.0.

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

**Follow-up — per-record classification (scorer v1.3.0).** The mixed campus
clusters (SpaceX SE04/SE06, KCIA) drove a structural fix: scope classification
now runs **per source record** and aggregates by max, instead of over one
concatenated text blob — so a glazing keyword in a demolition or fire record can
no longer borrow a sibling record's construction scope. Tracing SpaceX SE04 to
the record that actually carried "window" revealed it was an **HVAC/ductwork
permit** ("ductwork penetration through existing window. **no change to
exterior.**") — a window as a penetration point, not glazing work. Added a
high-precision `noEnvelope` negative (real glazing *is* exterior work), which
correctly dropped SE04's `division_08_system_fit` 1 → 0.7. Eval unchanged
(byte-identical blob path; dev 100%/96.8%, holdout 100%/93.5%).

**Honest residual (the regex boundary):** SE04 still sits at ~90 in priority —
but now on **scale alone** (a $5M+ commercial site at the generic 0.7
"commercial, no confirmed glazing" fit), no longer *claiming* glazing scope.
That's a legitimate large-commercial radar call, not a fabricated glazing bid.
Cases like the SE06 2nd-floor CUP (whether a permit genuinely carries glazing
scope vs. an incidental noun) are keyword-semantics questions the spec (§13)
deliberately assigns to the **key-gated model extraction/verification layer** —
further regex tuning would risk demoting the real large-commercial glazing work
Lacey wants. The honest miss is part of the deliverable.

## What this sample demonstrates

- The same shared pipeline that serves Solis produces Lacey Home and Commercial
  briefings with **zero bespoke Lacey code** (S6 exit gate).
- Every delivered fact is sourced; scores are deterministic; early-stage items
  are labeled as pipeline/radar, not imminent bids (a permit/plat is not a bid).
- Where the scorer is wrong, the review says so and files a calibration item
  rather than shipping a confident false positive.

**Not built for Lacey (per addendum §2):** no Lacey-only adapters, dashboards,
private integrations, or workflows — those wait on a paid commitment.
