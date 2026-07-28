# Data quality audit — baseline, 2026-07-28

Produced by `pnpm audit:data` against HOSTED production (Supabase `arbmeioglflvzoffgtii`,
schema `insights`) immediately after data-hygiene round 2 shipped: migrations 0039/0040
applied, `pnpm orgs:backfill-quality` run, `pnpm review reclassify --apply` run.

This file is the DIFF BASELINE. Round 3 starts by re-running the command and comparing,
not by re-deriving the numbers. Regenerate with:

```bash
pnpm audit:data
```

```
Invariants (a failure here is a bug, not a fact)
------------------------------------------------
  corroboration NULL                 0
  duplicate events (0035 key)        0
  unresolved and unqueued            2 (tolerance 10)

Coverage
--------
  projects                           16231
  located                            15031 (92.6%)
  unlocated: never asked, HAS address 2  ← the only backlog
  unlocated: no address to geocode   552
  unlocated: asked, no match         646
  project events                     41305

Organization name quality
-------------------------
  organizations                      6220
    person_or_unknown                3503 (56.3%)
    business                         2659 (42.7%)
    junk                             58 (0.9%)
  NOTE person_or_unknown is a sole proprietor, not a defect — it is excluded
       from GC-NAME surfaces and from nothing else.
  name-collision groups (top 15, review only — never a merge input):
      2  christian s roofing
      2  erie construction mid west llc
      2  lindsay johnson mechanical
      2  macdonald miller fac solns llc
      2  mario lyse kustom us
      2  my interior pro inc cont 
      2  n a
      2  pierce county parks
      2  roto rooter services co

Junk-org safety sweep (T5)
--------------------------
  junk-named organizations           58
  …carrying registry_ref             2
  …carrying identifiers              16
  …in an account relationship        0
  VIOLATORS (owner decision — nothing is deleted, ever):
    114 PARADISE LLC  [identifiers]  2f600da8-b665-4ca8-a84c-c5174976a70b
    123 ELECTRIC SERVICE INC  [registry_ref + identifiers]  06586fc2-2916-4162-a258-6466413ce6a3
    2022 INVESTMENTS LLC  [identifiers]  41ecf97c-26ed-487a-b3a4-f1e8759dcb9f
    2219 112TH ST E LLC  [identifiers]  b0de9ea0-861f-4c02-aac8-3019ef6e0fc1
    365 PLUMBING  [registry_ref + identifiers]  ebc2a511-cfc2-4df2-8446-689769af465c
    416 11TH ST CT E OWNER LLC  [identifiers]  74355033-37c9-4303-977c-3dde96a54f13
    7702 RIVER ROAD PARCEL C OWNER LLC  [identifiers]  a3f0380e-5cd0-464c-8ddb-91cfdc1f74aa
    AUBURN SCHOOL DISTRICT NO 408  [identifiers]  355c2b03-dd65-4f28-b71d-add60bb33c5f
    BETHEL SCH DIST #403  [identifiers]  ba44b088-5855-43a0-a4b5-ed710494db2f
    BETHEL SCHOOL DIST #403  [identifiers]  e2b9a1d9-91c4-4686-b1be-4d589df1b90c
    KENT SCHOOL DISTRICT 415  [identifiers]  1e48b733-e5f0-4306-a462-2ea8cef6ea32
    LINDSAY HIGHLINE SCHOOL DIST 401  [identifiers]  d31771a1-acbf-4dda-8ae9-36f48081fa47
    N/A  [identifiers]  b0b91083-29b8-48ba-b72f-daab8dc97f64
    SNOQUALMIE VALLEY SCHOOL DISTRICT #410  [identifiers]  13f868fd-e59b-4d54-ad39-31a111e124b4
    UNKNOWN* RENTON 140 LLC  [identifiers]  59da161b-3a3d-4e6c-9e4e-a2c230a824c1
    WEST SEATTLE 8320 LLC  [identifiers]  51447394-566a-4580-96f5-d46f3573b5d3

Review queue
------------
  pending                            2490
    proximity_org                    1622
    address_name                     815
    parcel_overlap                   53
  by awaiting-tag:
    (untagged)                       2326
    org_evidence                     164
  upgraded to org-role comparison    16

Trade tagging
-------------
  projects tagged                    2694 (16.6%)
  untagged                           13537
  …of which untaggable               3126 (no public permit type at all)
  top unmatched permit types (top 15 — NOT a vocabulary to-do list):
      3573  BUILDING
       853  BF
       678  RIGHT-OF-WAY
       541  NEW STRUCTURE
       462  BK
       407  REMODEL
       397  UTILITY CONNECTION
       305  EPERMIT
       283  SITE
       275  TJ
       243  BUILDING/RESIDENTIAL BUILDING/ADDITION-IMPROVEMENT/NA
       202  EA
       195  BN
       156  FRANCHISE UTILITY
       137  RENTAL REGISTRATION - ONE TO FOUR UNITS (1-4)

Stated valuation
----------------
  weekly_digest                      2603 opportunities, 974 without a stated valuation (37.4%)
  priority_review                    1648 opportunities, 1090 without a stated valuation (66.1%)
  per PUBLIC source (parser targets rank by this — nothing is ever invented):
    pierce_permits_arcgis           6423 records  75.2% without valuation
    tacoma_permits_arcgis           4393 records  31.0% without valuation
    bellevue_permits_arcgis         4018 records  100.0% without valuation
    everett_permits_socrata         2976 records  13.1% without valuation
    seattle_building_permits        2246 records  0.8% without valuation
    king_permit_reports             1920 records  75.6% without valuation
    puyallup_permits_arcgis         1228 records  100.0% without valuation
    olympia_smartgov_reports        1023 records  100.0% without valuation
    wa_sepa                          599 records  100.0% without valuation
    pierce_pals_contractor           439 records  100.0% without valuation
    lewis_issued_permits             394 records  41.9% without valuation
    centralia_permit_reports         220 records  1.8% without valuation
    king_public_notices              171 records  100.0% without valuation
    seattle_land_use_permits         117 records  53.0% without valuation
    tumwater_development_review       80 records  100.0% without valuation
    lacey_project_pages               79 records  100.0% without valuation
    lacey_projects_rest               79 records  100.0% without valuation
    thurston_active_notices           65 records  100.0% without valuation
    tumwater_sepa                     59 records  100.0% without valuation
    lacey_permit_reports              50 records  20.0% without valuation
    tumwater_development_arcgis       44 records  100.0% without valuation
    lewis_inspections                 17 records  100.0% without valuation
    lewis_current_planning            17 records  100.0% without valuation
    tacoma_solicitations              14 records  100.0% without valuation
    lewis_source_canary                1 records  100.0% without valuation
    seattle_source_canary              1 records  100.0% without valuation

INVARIANTS OK — everything above is a measurement, not a verdict.
```

## What this run settled that the plan had guessed at

Three of the plan's assumptions did not survive contact with the measurement.
Recorded here so they stay dead.

**1. The review queue is not mostly evidence-starved — it is mostly comparable.**
The plan expected ≈784 rows to be tagged `awaiting org_evidence`. Measured: of
776 pending `same_address_name_mismatch` reviews, **596 (77%) DO have
organization names on the candidate project** and were left actionable; only
**164** have no organization to compare against at all. A further **16** were
upgraded because the project's org names genuinely agree with the record —
`"City of Ruston Grid Resilience Project"` against `CITY OF RUSTON`,
`"Big Mountain Enterprises LLC …"` against `BIG MOUNTAIN ENTERPRISES`. Those 16
were invisible to the old comparison and no threshold change could have found
them; the comparison was against the wrong string, exactly as round 1 concluded.

**2. The junk tier is NOT clean, and the digit rule is why.** The T5 sweep found
**16 junk-classified organizations carrying identifiers, 2 of them registry-bound**.
They are not junk:

```
123 ELECTRIC SERVICE INC        365 PLUMBING          114 PARADISE LLC
AUBURN SCHOOL DISTRICT NO 408   BETHEL SCH DIST #403  KENT SCHOOL DISTRICT 415
SNOQUALMIE VALLEY SCHOOL DISTRICT #410      2219 112TH ST E LLC     …
```

Every one is a false positive of the inherited `[0-9]{3,}` rule — a real company
or school district whose NAME contains a number. This is not a regression: the
identical regex has excluded them from GC surfaces since migration 0025. What
changed is that the exclusion is now *visible and named* instead of buried in a
view body. **Owner decision, deliberately not automated:** narrowing the digit
rule (e.g. only when the digits are the whole token, or only alongside a
placeholder word) would recover ~16 real organizations. Nothing was deleted.

**3. "1,200 unlocated projects" was never a 1,200-row backlog.** It is 552 rows
with no address to geocode, 646 geocoded that came back empty, and **2** rows
that are genuinely waiting. The first version of this audit reported a single
conflated "never attempted: 554" and read like a fleet failure. The four buckets
now partition the project set, and a unit test asserts that they sum.

## Round-3 seeds, ranked by what this run measured

1. **Narrow the junk digit rule** (finding 2) — smallest change, recovers real
   organizations, and the violator list is the test set.
2. **Valuation parsers**, ranked by the per-source table above: `bellevue_permits_arcgis`
   (4,018 records, 100% null), `puyallup_permits_arcgis` (1,228, 100%),
   `olympia_smartgov_reports` (1,023, 100%), `pierce_permits_arcgis` (6,423, 75%),
   `king_permit_reports` (1,920, 76%). Those five are most of the 1,090
   priority-band opportunities with no stated valuation.
3. **The strict view predicate swap** (`name_quality = 'business'`), now that
   production has carried the column through a full cycle.
4. **Cryptic permit codes** `BF` (853), `BK` (462), `TJ` (275), `EA` (202),
   `BN` (195) — decode against official jurisdiction domain tables ONLY. Never
   guess, and never teach the matcher that `BUILDING` is a trade.
5. **The 9 name-collision groups** listed above — owner review, not a merge
   pipeline (the registry disproved merges at 853 groups sharing zero UBIs).
