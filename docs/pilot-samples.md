# M3.8 — Reviewed pilot samples (2026-07-16)

Internal review of current opportunities per pilot account, drawn from the live corpus (top of each
routing lane by score). Every fact below is quoted verbatim from a stored, A-grade evidence row
(official government record) with its original source URL; retrieval date 2026-07-15 for all
evidence cited. **None of these have been delivered to a customer**: the §15 publication gate holds
every opportunity in `blocked_on_verifier` until model keys enable the independent verifier — this
review is the human layer on top of that.

Reviewer: internal (session review against stored evidence rows). Verdicts use the M3.7 disposition
vocabulary. Where sources disagree, the discrepancy is stated — never resolved by guessing.

## Lacey Glass at Home (route: residential_glass · King excluded)

All five primary samples are Lewis County issued single-family permits (weekly_digest band,
score 70.5): new SFRs are window/door/shower prospects at `permit_issued` timing. Source for all
five: Lewis County issued-permit reports (grade A).

| # | Project | Jurisdiction | Stage | Evidence-backed facts | Reviewer verdict |
|---|---|---|---|---|---|
| 1 | B25-00527 — SFR at 137 Jordan Rd, Winlock | Lewis County | permit_issued | permit no. `B25-00527`; report of 05.17.2026 (lewiscountywa.gov) | relevant — new SFR, in territory |
| 2 | B26-00240 — SFR at 280 Paradise (Onalaska) | Lewis County | permit_issued | `B26-00240`; “Valuation: 76192.48” | relevant |
| 3 | B26-00299 — SFR 1059-24 Hwy 603 | Lewis County | permit_issued | `B26-00299`; “Valuation: 76097.8”; report of 06.21.2026 | relevant |
| 4 | B26-00356 — SFR at 118 Matheny Dr | Lewis County | permit_issued | `B26-00356`; “Valuation: 11348.58” | relevant but small — valuation suggests a partial/accessory scope, not a full new build; **calibration note:** minimum-job-size rule pending (§22) |
| 5 | B26-00390 — SFR at 132 Richer Dr | Lewis County | permit_issued | `B26-00390`; “Valuation: 13602.75” | same note as #4 |
| 6 | #25-0261 — 41st Ave, Lacey (joint_review, archive band 49.5) | City of Lacey + WA SEPA | entitlement | Lacey project page: “Resource Management Solutions, LLC is proposing to develop 213,000 square-foot, mixed-use development to include 198-apa…” (cityoflacey.org/projects/25-0261-41st-ave); SEPA 202602825: “180 residential units across eight buildings — seven 3-story, 24-unit walkup apartment buildings…” | correct joint_review route + correct cross-source merge (Lacey ↔ SEPA). **Discrepancy stated, not resolved:** Lacey page says 198 apartments, SEPA description says 180 units — sources differ; neither is asserted as the confirmed count. Early stage → archive band is right for At Home today |
| 7 | SEPA 202601756 (joint_review, archive) | WA SEPA register | entitlement | SEPA register id 194297 (apps.ecology.wa.gov) | multifamily joint-review candidate, early stage — archive correct |

## Lacey Glass Commercial (route: division_08 · Seattle/King routes here)

| # | Project | Jurisdiction | Stage | Evidence-backed facts | Reviewer verdict |
|---|---|---|---|---|---|
| 1 | CDUP25-0004 — SpaceX SE06 (Redmond campus), priority 98 | Unincorp. King County | permit_issued | one facility-project merged from ~24 King permit records (ADDC/FIRP/NONB/DEMO series, e.g. `ADDC25-0746`, `FIRP26-0147`); “JOB VALUE: 3000000” (largest); statuses “Permit Issued”/“Reviews In Process” (cdn.kingcounty.gov monthly reports; notice page kingcounty.gov) | relevant — active commercial campus with continuing TI/addition flow; the cluster-as-one-opportunity behavior is working as designed (one facility, one brief, not 24 leads). **Reviewer caveat:** merge breadth is address/name-driven; if SpaceX phases need separating later, the M2.5 split workflow applies |
| 2 | FIRP26-0088 — SPACE SE04 chamber demo (same campus family), 98 | Unincorp. King County | permit_issued | `ADDC26-0310`, `FIRP26-0119`, …; “JOB VALUE: 1100000” | relevant, same campus caveat as #1 |
| 3 | 7126700-CN — Lakeside School athletic field, 85 | City of Seattle (+ SEPA 202602224) | permit_applied | Seattle: “Construct alterations to athletic field including fences, netting and scoreboard”; LU: “replace existing natural grass with new synthetic turf”; “estprojectcost: 32000000.0000” | **not relevant — wrong_trade.** Correct cross-source merge (CN ↔ LU ↔ SEPA) and every fact supported, but a turf field has no Division 08 scope; the commercial classifier over-weights `commercial + high valuation` without a glazing signal. **Calibration action:** logged as the routing false-positive example for the §22 pass — division_08 trade_fit needs a negative filter for site/field work |
| 4 | DEMO26-0005 — KCIA demo (King County Int'l Airport), 85 | Unincorp. King County | permit_applied | `DEMO26-0005`, `FIRP26-0153…`; “JOB VALUE: 1717900” | monitoring-grade: demolition precedes rebuild; watch for the follow-on building permits rather than pursue now |
| 5 | ADDC25-0677 — Vashon Medical clinic, 83 | Unincorp. King County | permit_issued | `ADDC25-0677`, `FIRP26-0210/0287`; “JOB VALUE: 3355938” | relevant — clinic addition/alteration is storefront/glazing-plausible; needs scope confirmation (flagged for missing-fact verification once model keys land) |
| 6 | 7096544-CN — Boylston Ave school conversion (joint_review, 77.5) | City of Seattle | permit_applied | “Change of use from general retail sales and services to elementary school… Construct substantial alte[rations]”; “estprojectcost: 8878048.0000” (services.seattle.gov) | relevant joint-review — substantial alteration at $8.9M plausibly carries storefront/glazing packages |
| 7 | 7117725-PH — 425 Pontius Ave N office→multifamily (joint_review, 77.5) | City of Seattle | permit_applied | “Phased project. Change of use from office to multifamily residential… substantial alteration[s]”; “estprojectcost: 32854630.0000” | relevant joint-review — conversion of this size is a strong Division 08 candidate |

## Solis Interiors (route: interior_trades)

| # | Project | Jurisdiction | Stage | Evidence-backed facts | Reviewer verdict |
|---|---|---|---|---|---|
| 1 | 7132282-CN — 5335 Ballard Ave NW, priority 100 | City of Seattle | permit_issued | “Change of use from general sales and service to restaurant… Construct interior non-structural altera[tions]”; “estprojectcost: 150000.0000”; status “Issued” | relevant — issued interior TI at a good package size |
| 2 | 7135171-CN — 700 Broadway, 100 | City of Seattle | permit_issued | “Construct soft demolition, demising walls and interior alterations for (2) separate tenant spaces on L-3 of a commercial [building]”; “estprojectcost: 184000.0000” | relevant — demising walls + interior alterations is core drywall scope |
| 3 | 7144530-CN — 300 Pine St, 4th floor tenant space, 100 | City of Seattle | permit_issued | “Construct interior non-structural alterations for 4th floor tenant space [E-BIKE SMART FACTORY]”; “estprojectcost: 600000.0000” | relevant — large downtown TI |
| 4 | 7144976-CN — 3816 40th Ave NE, 100 | City of Seattle | permit_issued | “Interior remodel of a basement dwelling unit Subject To Field Inspection (STFI)”; “estprojectcost: 50000.0000” | marginal — residential basement remodel; **calibration note:** STFI residential remodels may sit below Solis's minimum job size (§22 pending); disposition would be `too_small` if confirmed |
| 5 | 7146553-CN — Port of Seattle gatehouse TI, 100 | City of Seattle | permit_issued | “Construct interior tenant improvements to portion of Port of Seattle gatehouse (STFI)”; “estprojectcost: 90000.0000” | relevant — public-work TI; flag Solis public-work constraints (§22) before pursuit |
| 6 | 7096544-CN — Boylston school conversion (gc_relationship_radar, archive 64.5) | City of Seattle | permit_applied | same evidence as Commercial #6 | correct radar route: $8.9M substantial alteration is oversized for direct pursuit — track the GC award instead. Note this same project routes `joint_review` for Commercial: distinct per-account interpretation of one evidence graph, as designed |
| 7 | 7117725-PH — Pontius office→multifamily (gc_relationship_radar, archive) | City of Seattle | permit_applied | same evidence as Commercial #7 | correct radar route — 32.8M conversion, GC relationship play |

## Review summary

- **Facts audited:** every fact quoted above matched its stored evidence text and source URL
  exactly (grade A, retrieved 2026-07-15). Zero unsupported facts in the samples; corpus checks:
  0 active records without evidence rows, 0 live model extractions (none claimed), 0 delivered
  items, 0 opportunities at `bidding_confirmed` (a permit is never a bid).
- **Distinct routing proven on shared evidence:** project 7096544-CN routes `joint_review` (77.5,
  weekly_digest) for Lacey Commercial and `gc_relationship_radar` (64.5, archive) for Solis; Lewis
  SFRs route only to At Home; King routes to Commercial and never to At Home.
- **Misses found and logged (working as intended — this is what review is for):**
  1. Lakeside turf field routed `division_08` at 85 — wrong_trade; §22 calibration item
     (negative filter for site/field work in commercial trade_fit).
  2. Low-valuation Lewis SFR permits and STFI residential remodels score into digest bands —
     minimum-job-size rules await customer calibration (§22), already listed as pending.
  3. 41st Ave Lacey unit count differs between the Lacey page (198) and SEPA (180) — recorded as a
     discrepancy, not resolved; the brief must present both citations.
- **Delivery posture:** all sampled opportunities remain `blocked_on_verifier` — nothing publishes
  until the independent verifier runs (model keys) and passes, which is the gate working as
  specified, not a defect.
