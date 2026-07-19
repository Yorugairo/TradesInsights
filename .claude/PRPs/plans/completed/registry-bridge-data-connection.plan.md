# Plan: Connect captured-but-unused source data into the OTN Insights ↔ L&I registry bridge

## Summary
Six additive workstreams that promote business/contact data our adapters already capture (but drop) into the normalized record, then activate the address match against the L&I registry. The identifier-class foundation (`organizations[].address` + `sourceEntityId`, migration 0024, resolver clustering, Pierce emission) already shipped this session; and the trades registry contract view now exposes `registered_address` + `registered_postal_code`. This plan wires the demand-side matcher and harvests the remaining high-value dropped fields across wa_sepa, King, Seattle, Pierce/Tacoma ArcGIS, Centralia, and Thurston.

## User Story
As the Insights resolution pipeline, I want every published business identifier (mailing address, contractor company, stable source entity id) and project-size signal promoted into normalized records and matched against the registry, so that a permit contact resolves to its L&I entity even when it has no phone/UBI and its name drifts.

## Problem → Solution
Today only phone/ubi/license reach `organization_identifiers`, and each adapter drops several published fields into `rawFields`/`evidence` or discards them; the registry address the matcher needs was never surfaced. → Promote the dropped identifiers/geo/size fields (never guessing), surface the registry address (done), and add an address binding rule so no-phone parties resolve.

## Metadata
- **Complexity**: XL (6 workstreams; recommend implementing as 6 sequenced commits, one per workstream)
- **Source PRD**: N/A (session audit + owner directive "Full: new identifier class")
- **PRD Phase**: N/A
- **Estimated Files**: ~12 source + ~8 test/fixture

---

## UX Design
Internal change — no user-facing UX transformation. The only human-facing surface is the operator review queue (`registry_observations`), which gains a new `binding_address_match` row type identical in shape to existing binding rows.

---

## Mandatory Reading

Read these BEFORE implementing the indicated workstream. File:line anchors are from this session's reads/audits.

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `packages/resolution/src/registry-link.ts` | 24-35, 68-123, 156-172 | `RegistryIdentityRow`, `fetchRegistryIdentityRows` SELECT, pure-matcher pattern to mirror for WS1 |
| P0 | `packages/resolution/src/registry-observations.ts` | 43-105, 227-315 | `TrustComponents`/weights, `loadOrganizationPhones` use, the `binding_name_match` loop to clone for `binding_address_match` (WS1) |
| P0 | `packages/resolution/src/identifiers.ts` | 13-118, 39-78, 81-110 | `normalizeAddressUS`/`normalizeSourceEntityId`, `persistOrganizationIdentifiers`, `loadOrganizationPhones` (clone → `loadOrganizationAddresses`, WS1) |
| P0 | `packages/adapters/src/pierce-pals-contractor.ts` | 207-310 | Canonical org-emission with the new `address`/`sourceEntityId` spreads — mirror for WS2/WS3/WS4 |
| P0 | `packages/adapters/src/lewis-issued-permits.ts` | 51-159 | Positional-PDF column-band + wrapped-row parse — mirror for Centralia (WS5) |
| P1 | `packages/adapters/src/wa-sepa.ts` | 36-53 (schema), 137-165 (emit) | WS2: promote applicantcontactinfo + geo; fields are passthrough-retained |
| P1 | `packages/adapters/src/king-permit-reports.ts` | 161-201 | WS3a: split address out of the name blob |
| P1 | `packages/adapters/src/seattle-socrata.ts` | 27-50 (schema), 161-198 (emit), 74 (stageFor), 166/190/192 (issueddate) | WS3b/c: contractorcompanyname emit + decisiondate bug |
| P1 | `packages/adapters/src/pierce-permits-arcgis.ts` | 59-82 (schema), 203, 233 | WS4: projectId → sourceEntityId |
| P1 | `packages/adapters/src/tacoma-permits-arcgis.ts` | 57-80 (schema), 195, 224-232 | WS4: globalid_1 → sourceEntityId |
| P1 | `packages/adapters/src/centralia-permit-reports.ts` | 62-72 (row type), 145-161 (colOf drops digits), 542 (units null) | WS5: unit-count matrix → units |
| P1 | `packages/adapters/src/thurston-active-notices.ts` | 20-42 (parseNoticeHeading), 150, 171-178 | WS6: noticeDate + lots/acreage |
| P1 | `packages/domain/src/normalized-record.ts` | 51-73 | org identifier shape (address/sourceEntityId already present) |
| P2 | `packages/adapters/src/pierce-pals-contractor.test.ts` | all | Golden-set + failure-fixture test convention |
| P2 | `packages/resolution/src/identifiers.test.ts` | all | Pure-function normalizer test convention |

## External Documentation
No external research needed — every workstream uses established internal patterns (positional PDF parse, Socrata `.passthrough()` schema, registry pure-matcher, Zod-validated NormalizedSourceRecord). ArcGIS/Socrata field semantics are already captured in each source's committed fixtures.

---

## Patterns to Mirror

### ORG_EMISSION_WITH_IDENTIFIERS
```ts
// SOURCE: packages/adapters/src/pierce-pals-contractor.ts:220-243
organizations.push({
  name: applicantNm,
  role: "applicant",
  evidenceText: `Applicant of record on PALS permit ${id}: ${applicantNm}`
    + (applicantAddress ? `, address ${applicantAddress}` : ""),
  ...(applicantPhone ? { phone: applicantPhone } : {}),
  ...(applicantAddress ? { address: applicantAddress } : {}),
  ...(applicantEntityId ? { sourceEntityId: applicantEntityId } : {}),
});
// Rule: additive spreads — a field is emitted ONLY when present; unknown → omitted, never "".
```

### PURE_MATCHER_WITH_INJECTED_ROWS
```ts
// SOURCE: packages/resolution/src/registry-link.ts:104-123 + 156-172
// fetchRegistryIdentityRows SELECTs named columns; the matcher is a pure fn over rows,
// unit-tested by constructing RegistryIdentityRow[] directly (no DB). Mirror this for
// the address index + binding_address_match: build a Map keyed on street+zip, test with
// hand-authored rows carrying registered_address/registered_postal_code.
```

### BINDING_RULE_SHAPE
```ts
// SOURCE: packages/resolution/src/registry-observations.ts:240-315
// For each unbound org: compute a hit + ruleKey + TrustComponents{name,identifier,locality,
// role,corroboration,ruleHistory}, push a PendingInsert with dedupeKey `bind:${org.id}:${hit.entityId}`.
// binding_address_match: identifier=1 when the org address key matches a UNIQUE registry
// address key AND name similarity ≥ PHONE_MATCH_MIN_NAME_SIMILARITY (0.3); drop non-unique
// address keys (shared buildings) exactly like the unique-phone guard at :231-235.
```

### EVIDENCE_BACKED_IDENTIFIER_LOAD
```ts
// SOURCE: packages/resolution/src/identifiers.ts:81-92 (loadOrganizationPhones)
// Clone to loadOrganizationAddresses: SELECT value_normalized WHERE identifier_type='address',
// return Map<orgId, Set<addressKey>>. Address key = normalizeAddressUS(street)+" "+zip5.
```

### POSITIONAL_PDF_PARSE
```ts
// SOURCE: packages/adapters/src/lewis-issued-permits.ts:56-159
// findColumns() locates header cells → x-midpoint bands; parseLewisPermitPage() anchors rows
// and attaches wrapped lines by y-block. Centralia mirrors this to read the unit-count matrix
// columns; validate parsed per-category totals against the printed totals (checkInvariants).
```

### SOCRATA_PASSTHROUGH_SCHEMA
```ts
// SOURCE: packages/adapters/src/seattle-socrata.ts:27-50
// SocrataRowSchema is z.object({...}).passthrough(); dropped columns (contractorcompanyname)
// survive in rawFields. To promote: add the column to the schema and read it in the emit block.
```

---

## Files to Change

| File | Action | Workstream |
|---|---|---|
| `packages/resolution/src/registry-link.ts` | UPDATE | WS1 — add registered_address/postal to row + SELECT |
| `packages/resolution/src/registry-observations.ts` | UPDATE | WS1 — binding_address_match rule + address index |
| `packages/resolution/src/identifiers.ts` | UPDATE | WS1 — loadOrganizationAddresses + addressMatchKey helper |
| `packages/resolution/src/registry-observations.test.ts` (or new) | UPDATE/CREATE | WS1 — injected-row matcher tests |
| `packages/adapters/src/wa-sepa.ts` | UPDATE | WS2 |
| `packages/adapters/src/wa-sepa.test.ts` | UPDATE | WS2 |
| `packages/adapters/src/king-permit-reports.ts` | UPDATE | WS3a |
| `packages/adapters/src/seattle-socrata.ts` | UPDATE | WS3b + WS3c bug |
| `packages/adapters/src/*.test.ts` (king, seattle) | UPDATE | WS3 |
| `packages/adapters/src/pierce-permits-arcgis.ts` | UPDATE | WS4 |
| `packages/adapters/src/tacoma-permits-arcgis.ts` | UPDATE | WS4 |
| `packages/adapters/src/centralia-permit-reports.ts` | UPDATE | WS5 |
| `packages/adapters/src/thurston-active-notices.ts` | UPDATE | WS6 |

## NOT Building
- Fetching Lacey project-page application PDFs (the likely UBI/license carrier) — separate download-class workstream, out of scope here.
- Backfilling the empty `registry_entity_locations` table on the registry side (registry-owned; the address is sourced from `registry_normalized_records` instead).
- Auto-binding on address alone — address is a REVIEW signal, never an auto-accept (mirror phone: never auto-binds).
- Person/homeowner PII into the bridge — org-vs-person gating drops individuals from matchable identifiers.
- Olympia + Tumwater parsers (task #3) — separate line of work.

---

## Step-by-Step Tasks

### WS1 — Address matcher (do first; activates data already surfaced on both sides)
- **ACTION**: Read the two new registry columns; add an address binding rule.
- **IMPLEMENT**:
  1. `registry-link.ts`: add `registeredAddress: string | null` + `registeredPostalCode: string | null` to `RegistryIdentityRow`; add `registered_address, registered_postal_code` to the `fetchRegistryIdentityRows` SELECT and the row map.
  2. `identifiers.ts`: export `addressMatchKey(street, zip)` = `${normalizeAddressUS(street)} ${(zip||'').slice(0,5)}` (null if either side missing / normalizeAddressUS null); add `loadOrganizationAddresses(db)` mirroring `loadOrganizationPhones`.
  3. `registry-observations.ts`: build `byAddress: Map<string, RegistryIdentityRow|null>` (unique keys only — null on collision, like `byPhone`); in the unbound loop add a `binding_address_match` branch (ruleKey `binding_address_match`) when the org has an address key hitting a UNIQUE registry key AND `nameSimilarity ≥ PHONE_MATCH_MIN_NAME_SIMILARITY`; identifier component = 1; dedupeKey stays `bind:${org.id}:${hit.entityId}` so one org+entity yields one suggestion regardless of which rule found it.
- **MIRROR**: PURE_MATCHER_WITH_INJECTED_ROWS, BINDING_RULE_SHAPE, EVIDENCE_BACKED_IDENTIFIER_LOAD.
- **IMPORTS**: `addressMatchKey`, `loadOrganizationAddresses` from `./identifiers.js`; `nameSimilarity` already imported.
- **GOTCHA**: Registry `registered_address` is STREET-ONLY + separate zip; the org `address` identifier is a FULL mailing string. Both must fold through `addressMatchKey`, and the org side must extract its own zip5 (regex `/\b(\d{5})(?:-\d{4})?\b/`). PO-BOX registered addresses will simply never match a permit site address — correct. Never auto-bind (address rule stays in the review queue; only non-binding types auto-accept).
- **VALIDATE**: New test builds `RegistryIdentityRow[]` with `registeredAddress:"1210 HOMANN DR SE", registeredPostalCode:"98503"` and an org with address id `"1210 HOMANN DRIVE SE, LACEY WA 98503"` → expect a `binding_address_match` insert; a shared-building address (2+ entities) → dropped; a foreign-name same-address → below name gate, no insert.

### WS2 — wa_sepa (biggest supply-side win)
- **ACTION**: Promote applicant contact + site geo + lead-agency file number.
- **IMPLEMENT**: Extend `SepaRowSchema` to read `applicantcontactinfo, siteparcelnumber, siteline1address, siteline2address, sitecityname, sitezipcode, sitelatitudedecimal, sitelongitudedecimal, leadagencyfilenumber`. Parse `applicantcontactinfo` (newline-delimited block: name / title / street+city+zip / email) → set the applicant org's `address` (join street lines) and `phone` if a phone appears; keep person-vs-business gating (only attach address/phone identifiers when the applicant is a business — LLC/INC/CORP/company suffix or agency). Set `parcelIds` from `siteparcelnumber` (split on comma), `addressRaw` from site lines, `geometry` = Point from lat/long when both present. Add `leadagencyfilenumber` to `evidence` (factPath `externalRef`) + rawFields.
- **MIRROR**: ORG_EMISSION_WITH_IDENTIFIERS; geometry Point shape from `packages/domain/src/normalized-record.ts:5-8`.
- **GOTCHA**: `applicantcontactinfo` mixes businesses and private individuals — do NOT attach `.address`/`.phone` for a person (PII); still emit the name. Coordinates are lon/lat order in GeoJSON `[lng, lat]`. Only ~334/407 rows have contact info; unknown → null.
- **VALIDATE**: Golden fixture `fixtures/wa_sepa/window-90d.json`; assert a business row gets `organizations[].address`+`.phone` and `parcelIds`/`geometry`; a person row gets name only; add a malformed-contact-block fixture that yields name-only (no throw).

### WS3 — King + Seattle
- **WS3a (king-permit-reports)**: ACTION — split the mailing address out of the `APPLICANT NAME & ADDRESS` / `OWNER NAME & ADDRESS` cell. IMPLEMENT — the cell is `"<name>, <street>\n<city, ST ZIP>"`; parse name = text before the first comma-then-digits / newline boundary, address = remainder → `organizations[].name` gets the clean name, `.address` gets the postal string (business rows only). MIRROR ORG_EMISSION_WITH_IDENTIFIERS. GOTCHA — homeowner rows are PII (name only); some cells are name-only (no address) → address omitted. VALIDATE — golden XLSX fixture asserts a business applicant gets split name+address; individual gets name only.
- **WS3b (seattle-socrata contractorcompanyname)**: ACTION — add `contractorcompanyname` to `SocrataRowSchema` and emit it as `organizations[]` role `primary_contractor` when present (building dataset only). MIRROR SOCRATA_PASSTHROUGH_SCHEMA + ORG_EMISSION_WITH_IDENTIFIERS. GOTCHA — sparse (4/514) and absent from land-use; guard on presence.
- **WS3c (seattle_land_use decisiondate BUG)**: ACTION — for the land-use config, drive `issueDate` + stage off `decisiondate` (not `issueddate`, which land-use never publishes). IMPLEMENT — add `decisiondate` to schema; in the emit block prefer `r.issueddate ?? r.decisiondate` for the date, and let `stageFor` see the decision date so the `approved` branch (`seattle-socrata.ts:74`) can fire. GOTCHA — do NOT break the building config (which uses issueddate); key the behavior off the config, not a global change. VALIDATE — land-use golden fixture now yields non-null issueDate + a non-`entitlement` stage for a decided row; building fixture unchanged (regression guard).

### WS4 — Source-entity-id cluster keys
- **ACTION**: Promote stable source ids as `sourceEntityId` so the resolver clusters permits by publisher authority.
- **IMPLEMENT**: `pierce-permits-arcgis.ts` — add `projectId` to the feature schema; emit `sourceEntityId: pierce_pals_project:${projectId}` on the record's org(s), or (since organizations is []) attach to a minimal applicant-less cluster carrier is N/A — instead thread it so `resolver` clustering sees it: emit it on any org present; if none, it feeds project-cluster logic via rawFields (document as a follow-up if no org exists). `tacoma-permits-arcgis.ts` — add `globalid_1`; the applicant org already exists → add `sourceEntityId: tacoma_accela:${globalid_1}`.
- **MIRROR**: ORG_EMISSION_WITH_IDENTIFIERS + `palsEntityId` namespacing helper (`pierce-pals-contractor.ts` mailingAddress/palsEntityId region).
- **GOTCHA**: Pierce ArcGIS emits `organizations: []` (no party), so a party-level `sourceEntityId` has no org to attach to — `projectId` is a PROJECT cluster key, not a party key; prefer feeding it to the permit-cluster/project layer rather than forcing a fake org. Tacoma `globalid_1` identifies the permit record, not the applicant entity — attach to the applicant org only if it genuinely represents that applicant across permits; otherwise keep as record evidence. Confirm the intended clustering semantics before emitting (see NOT Building — no fake orgs).
- **VALIDATE**: Golden ArcGIS fixtures; assert namespaced id shape and that `normalizeSourceEntityId` accepts it (`resolver` clustering test with two records sharing the id → one org).

### WS5 — Centralia unit-count matrix → units
- **ACTION**: Read the per-row dwelling unit-count columns into `units`.
- **IMPLEMENT**: Extend the positional parser to map the category columns right of COMMENTS (New Single Family, New Townhouse #, New 2/3/4/5 Unit Buildings, # of New Units 5+ bldgs, ADU) to their printed digit; `units` = the row's dwelling count (sum or the single populated category). Add a `checkInvariants` reconciliation against the printed per-category totals.
- **MIRROR**: POSITIONAL_PDF_PARSE (lewis-issued-permits column bands).
- **GOTCHA**: `colOf()` currently discards lone digits right of comments as "category marks" (`centralia-permit-reports.ts:155-161`) — that logic must become column-aware, not a blanket drop. Positional extraction is the reason it was dropped; validate against printed totals so a mis-banded digit fails loudly.
- **VALIDATE**: Golden `february-2026.pdf` fixture; a Century Communities SFR row yields `units:1`; parsed category totals equal the printed totals (checkInvariants empty).

### WS6 — Thurston dates + lots/acreage
- **ACTION**: Promote the already-parsed `noticeDate` and extract deterministic lot/acreage counts.
- **IMPLEMENT**: Set `applicationDate`/`issueDate`/`sourceUpdatedAt` from the parsed `noticeDate` per notice type (issuance → issueDate; hearing → leave dates null or applicationDate per heading semantics). Extract `lots` from patterns `/\b(\d+)[- ]lot(s)?\b/i`, `/into (\d+) lots/i`, `/(\d+) .*residential lots/i`; leave null when absent. Business-vs-homeowner gating on the paren project name before emitting it as an org.
- **MIRROR**: `parseNoticeHeading` already computes noticeDate (`thurston-active-notices.ts:20-42`); just thread it to the record.
- **GOTCHA**: Most project names are homeowner surnames (PII) — only emit an org for clearly-business names (Quarry/Village/Development/LLC). Acreage is not a schema field; keep in evidence, not a numeric slot.
- **VALIDATE**: Golden `landing.html` fixture; an issuance notice yields issueDate; an "11-lot" description yields `lots:11`; a homeowner notice yields no org.

---

## Testing Strategy

### Unit Tests (representative)
| Test | Input | Expected | Edge? |
|---|---|---|---|
| addressMatchKey | `"1210 HOMANN DR SE, LACEY WA 98503"` | `"1210 HOMANN DR SE 98503"` | |
| binding_address_match | reg row street+zip == org addr key, unique, name sim ≥0.3 | one insert, ruleKey `binding_address_match` | |
| address collision | 2 reg entities same key | key dropped, no insert | ✔ |
| wa_sepa business contact | applicantcontactinfo block, LLC name | org.address+phone set | |
| wa_sepa person contact | individual name | name only | ✔ |
| seattle land-use date | decisiondate present, issueddate absent | issueDate set, stage ≠ entitlement | ✔ |
| centralia units | SFR row | units:1; totals reconcile | |
| thurston lots | "11-lot residential plat" | lots:11 | |

### Edge Cases Checklist
- [ ] Empty / missing field → null (never 0/"")
- [ ] PO-BOX registered address → no site match (WS1)
- [ ] Homeowner / private individual → no identifier attached (WS2/WS3/WS6)
- [ ] Shared-building address → dropped as match key (WS1)
- [ ] Malformed contact block / unparseable cell → name-only, no throw
- [ ] Idempotent rerun (same fixture → same output, same dedupe no-op)

---

## Validation Commands

### Static Analysis
```bash
pnpm --filter @otn/resolution --filter @otn/adapters --filter @otn/domain run typecheck
```
EXPECT: Zero type errors

### Unit Tests (per workstream, fast)
```bash
pnpm -C "C:/Users/Snipe/Downloads/TradesInsights" exec vitest run \
  packages/resolution/src/registry-observations.test.ts \
  packages/adapters/src/wa-sepa.test.ts \
  packages/adapters/src/seattle-socrata.test.ts
```
EXPECT: All pass

### Full Test Suite
```bash
pnpm -C "C:/Users/Snipe/Downloads/TradesInsights" exec vitest run
```
EXPECT: No regressions

### Manual Validation
- [ ] Query `registry_public.trades_identity_v1` returns `registered_address` (already verified live 2026-07-19).
- [ ] After WS1, a shadow resolver run surfaces `binding_address_match` candidates for known no-phone owners.

---

## Acceptance Criteria
- [ ] All 6 workstreams implemented as sequenced commits
- [ ] Typecheck + vitest green per workstream; full suite no regressions
- [ ] Each adapter change has golden + malformed fixtures; idempotent rerun holds
- [ ] `binding_address_match` never auto-accepts; address collisions dropped
- [ ] No homeowner PII promoted to matchable identifiers

## Completion Checklist
- [ ] Additive only — no existing field semantics changed except the Seattle land-use decisiondate bug fix (guarded by config)
- [ ] Unknown → null everywhere; no guessed/zeroed values
- [ ] Person-vs-business gating applied on every contact-bearing source
- [ ] Tests follow the golden-set + pure-function conventions
- [ ] Registry migration already on release/trades-staging + live DB (WS1 dependency satisfied)

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Address key format mismatch (registry street-only vs org full string) | Med | Med | `addressMatchKey` folds both through normalizeAddressUS + zip5; test both directions with Lacey Glass live values |
| Homeowner PII leaks into identifiers | Med | High | Explicit business-suffix gate on every contact source; person → name only |
| Centralia positional mis-banding | Med | Med | checkInvariants against printed per-category totals fails loudly |
| Pierce projectId has no org to attach to | High | Low | Treat as project-cluster key, not party id; do not fabricate an org |
| Seattle date-bug fix regresses building config | Low | Med | Key behavior off config; building-fixture regression test |

## Notes
- Sequence: WS1 → WS2 → WS3 → WS4 → WS5 → WS6. WS1 first because the registry `registered_address` (live) + Pierce org addresses (shipped) are inert until the matcher exists.
- Registry-side dependency for WS1 is DONE: `registry_public.trades_identity_v1` exposes `registered_address`+`registered_postal_code` (migration on release/trades-staging `20260719120000...`, applied live to project arbmeioglflvzoffgtii). The base view + `otn_insights_reader` grant come from the seam migration on `claude/insights-integration-seam`.
- Governing rule throughout: capture only what the source publishes; unknown = null; never bypass access controls (all fixtures are genuine-visitor captures).
