# OTN Insights — Greenfield Agent Build Specification

**For:** Codex / Claude Code  
**Build type:** Self-contained greenfield repository  
**Launch market:** Thurston, Pierce, Lewis, and King counties, Washington  
**Pilot accounts:** Lacey Glass and Solis Interiors  
**Source research verified:** July 14, 2026

## 0. Agent directive

Build the product in this document from a fresh repository. Use the prescribed architecture unless a dependency is unavailable. Work in the numbered implementation order. Complete tests and acceptance checks with each task; do not defer them to the end.

Before enabling a live source, verify its official landing page, current format, access rules, and expected fields. Preserve every fetched artifact. Never fabricate a source field, project stage, scope, company role, contact, bid date, or citation.

At each milestone report only:

1. Outcome.
2. Files and migrations changed.
3. Tests run and exact results.
4. Sources verified and sample counts.
5. Remaining blockers/assumptions.
6. Next task ID.

## 1. Product

OTN Insights monitors public construction sources, resolves related records into projects, matches projects to a contractor's actual capabilities, and delivers sourced opportunity briefs and stage-change alerts.

The system must:

- Collect official planning, permit, SEPA, procurement, and license records.
- Store immutable raw evidence plus retrieval metadata and hashes.
- Normalize jurisdiction-specific records.
- Resolve permits and notices into development → phase/project → event relationships.
- Separate confirmed facts from inferences.
- Route and score opportunities per account.
- Produce an internal review queue, account dashboard, and idempotent weekly digest.
- Record feedback and improve versioned rules.
- Monitor source freshness, schema changes, and failures.

### Out of scope

- Public market/location/trade pages.
- Autonomous prospecting or contact outreach.
- Bid submission, pricing, estimating, or legal commitments.
- Cleaning-company intelligence in the first release.
- Bypassing authentication, CAPTCHA, MFA, paywalls, or access controls.

## 2. Required stack

Use current stable releases and lock dependencies.

- TypeScript with strict mode.
- `pnpm` workspaces.
- Next.js App Router for the authenticated web application.
- Node.js TypeScript worker for ingestion and scheduled processing.
- PostgreSQL with PostGIS.
- Drizzle ORM and versioned SQL migrations.
- `pg-boss` or equivalent PostgreSQL-backed durable jobs; do not add Redis initially.
- S3-compatible object storage; MinIO for local development.
- Vitest for unit/integration tests.
- Playwright for application E2E tests and only approved dynamic-source adapters.
- Zod schemas at every external boundary.
- Structured JSON logs with trace/source-run/job IDs.
- Docker Compose for PostgreSQL/PostGIS, MinIO, and Mailpit.

### Repository layout

```text
apps/
  web/                   # Next.js UI and authenticated APIs
  worker/                # collectors, parsers, resolution, scoring, delivery
packages/
  db/                    # Drizzle schema, migrations, repositories
  source-sdk/            # adapter interfaces, fetch policy, artifact store
  adapters/              # jurisdiction/source adapters
  documents/             # PDF, Word, Excel, HTML extraction
  domain/                # normalized schemas and stage/event taxonomy
  resolution/            # address, organization, project matching
  intelligence/          # routing, scoring, evidence verification
  delivery/              # digest and email rendering
  config/                # typed source/account config loader
config/
  sources.yaml
  account-profiles.yaml
fixtures/
  <source-key>/
docs/
  architecture.md
  data-dictionary.md
  source-policy.md
  operations.md
docker-compose.yml
.env.example
```

## 3. Local developer contract

Provide these commands:

```text
pnpm install
pnpm infra:up
pnpm db:migrate
pnpm db:seed
pnpm dev
pnpm worker
pnpm test
pnpm test:e2e
pnpm lint
pnpm typecheck
pnpm source:run <source-key>
pnpm source:backfill <source-key> --from YYYY-MM-DD --to YYYY-MM-DD
```

`.env.example` must document:

```text
DATABASE_URL=
OBJECT_STORAGE_ENDPOINT=
OBJECT_STORAGE_REGION=
OBJECT_STORAGE_BUCKET=
OBJECT_STORAGE_ACCESS_KEY=
OBJECT_STORAGE_SECRET_KEY=
APP_BASE_URL=
AUTH_SECRET=
EMAIL_FROM=
SMTP_HOST=
SMTP_PORT=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
LLM_MONTHLY_BUDGET_USD=
SOURCE_USER_AGENT=
```

The application must boot locally without model keys. Model-dependent jobs should enter a visible blocked/skipped state.

## 4. System flow

```text
official source
  → scheduled source run
  → immutable raw artifact + metadata + SHA-256
  → format parser
  → normalized source record
  → address/parcel/organization normalization
  → project resolution
  → project event timeline
  → account route + deterministic score
  → evidence verifier
  → review queue
  → digest/alert
  → customer feedback
```

AI interprets captured evidence. AI is never the system of record.

## 5. Source adapter contract

```ts
export interface SourceAdapter {
  readonly key: string;
  discover(ctx: RunContext): Promise<DiscoveredArtifact[]>;
  fetch(item: DiscoveredArtifact, ctx: RunContext): Promise<RawArtifact>;
  parse(raw: RawArtifact, ctx: RunContext): Promise<ParsedSourceRecord[]>;
}
```

Every adapter must provide:

- Deterministic idempotency keys.
- Bounded concurrency, explicit user agent, timeouts, and retry classification.
- Conditional requests when supported.
- Immutable raw body/file storage before parsing.
- Canonical URL, parent landing page, HTTP metadata, retrieved time, content type, byte size, and hash.
- Stable external record ID where available.
- Separate source-published, source-updated, first-seen, last-seen, and retrieved times.
- Parser version and fixture version.
- Paginated/checkpointed backfill with an overlap window.
- Dead-letter state that can reproduce the failure.
- Metrics: discovered, fetched, unchanged, parsed, rejected, duplicate, and error counts.

Adapters write source records and evidence only. They must not create customer opportunities directly.

### Source activation checklist

For each source:

1. Verify official publisher and landing page.
2. Record current access URL/format/cadence in `config/sources.yaml`.
3. Review robots, terms, authentication, and reasonable rate.
4. Capture representative raw fixtures.
5. Define mandatory and optional fields.
6. Implement parser and failure fixtures.
7. Manually compare a sample to the published source.
8. Run in shadow mode.
9. Enable only after parser and health tests pass.

Discovery preference: documented API/JSON/CSV → downloadable report → static HTML → authorized email → permitted dynamic lookup → headless browser.

## 6. Source catalog

Priority:

- **P0:** required for the four-county pilot.
- **P1:** add after P0 is stable.
- **Lookup:** enrich a known record; never the sole alert source.
- **Context:** market/entity corroboration; not opportunity discovery.

### 6.1 Thurston County

| Pri | Key | Source | Format / cadence | Required output |
|---|---|---|---|---|
| P0 | `lacey_projects_rest` | [Lacey Projects REST](https://cityoflacey.org/wp-json/wp/v2/projects?per_page=100&orderby=modified&order=desc&_fields=id,date,modified,link,title) | JSON / daily | ID, title, created, modified, project URL |
| P0 | `lacey_project_pages` | [Lacey Current Projects](https://cityoflacey.org/current-projects/) | HTML/docs / daily | Stage, project ID, description, address/parcel, applicant/developer, linked records |
| P1 | `lacey_permit_reports` | [Lacey Permit Reports](https://cityoflacey.org/permit%20reports/) | PDF index / monthly | Permit ID/type, address, issue date, units, valuation |
| P0 | `thurston_active_notices` | [Thurston Active Notices](https://www.thurstoncountywa.gov/departments/community-planning-and-economic-development/permitting/comment-project) | HTML/docs / daily | Project number, scope, location, notice date, linked SEPA/plat documents |
| P1 | `thurston_activity_reports` | [Thurston Project Status](https://www.thurstoncountywa.gov/departments/community-planning-and-economic-development/permitting/project-status) | PDF/report / weekly-monthly | New building permits and land-use applications |
| Lookup | `thurston_laserfiche` | [Thurston CPED Laserfiche](https://weblink.co.thurston.wa.us/CPED/Welcome.aspx) | Repository | Known-project documents and report backfill |
| P0 | `tumwater_development_arcgis` | [Tumwater FeatureServer](https://services6.arcgis.com/ovypB8ighP2NPfFE/arcgis/rest/services/DevelopmentProjectsTumwater/FeatureServer/1/query?where=1%3D1&outFields=*&returnGeometry=false&f=json) | ArcGIS JSON / daily | Object ID, permit, description, development type, stage, update time |
| P0 | `tumwater_development_review` | [Tumwater Development Review](https://www.ci.tumwater.wa.us/departments/community-development-department/permitting-building/development-review) | Agendas/docs / weekly | Feasibility/preapplication/site plan, parties, parcel, scope |
| P0 | `tumwater_sepa` | [Tumwater NOA/SEPA](https://www.ci.tumwater.wa.us/departments/community-development-department/permitting-building/notice-of-applications-sepa-determinations) | HTML/docs / weekly | Application, determination, project/location, date |
| P1 | `olympia_smartgov_reports` | [Olympia SmartGov Reports](https://ci-olympia-wa.smartgovcommunity.com/Public/ReportsView) | Public reports / weekly | Recent applications and issued permits |
| Context | `thurston_property` | [Thurston Property Search](https://tcproperty.co.thurston.wa.us/propsql/front.asp) | Lookup | Parcel, owner, address |

Migration canary: verify [Thurston permitting changes](https://www.thurstoncountywa.gov/departments/community-planning-and-economic-development/permitting/whats-new-thurston-county-permitting-and-development) because a new system was announced for September 2026.

### 6.2 Lewis County

| Pri | Key | Source | Format / cadence | Required output |
|---|---|---|---|---|
| P0 | `lewis_issued_permits` | [Lewis Building Permit Data](https://lewiscountywa.gov/departments/community-development/building-permit-data/) | PDF index / weekly | Application number, issued date, type/address, parcel, applicant, primary contractor, valuation |
| P0 | `lewis_current_planning` | [Lewis Current Planning](https://lewiscountywa.gov/departments/community-development/current-planning-applications/) | HTML/docs / daily | File number, project, type, linked planning/environmental documents |
| P0 | `lewis_source_canary` | [Lewis Community Development](https://lewiscountywa.gov/departments/community-development/) | Landing page / daily | Current official links to planning, permits, records, and portal |
| Lookup | `lewis_permit_records` | [Lewis Permit Records](https://docs.lewiscountywa.gov/permits/Welcome.aspx?cr=1) | Laserfiche | Known-property permit history; source warns completeness varies |
| P1 | `lewis_smartgov` | Discover from official county page | Dynamic/public reports | Application/status/inspection; do not guess hostname |
| P1 | `lewis_inspections` | [Lewis Daily Inspections](https://lewiscountywa.gov/departments/community-development/building-inspections/daily-building-inspections/) | HTML / daily | Late-stage inspection signal with strict freshness check |

Golden PDF fixture: [June 28, 2026 issued permits](https://lewiscountywa.gov/documents/19644/06.28.2026_Issued_Permits_with_Valuation.pdf). Test wrapped rows and applicant versus primary-contractor separation.

### 6.3 Pierce County and Tacoma

| Pri | Key | Source | Format / cadence | Required output |
|---|---|---|---|---|
| P0 | `pierce_environmental_determinations` | [Pierce Environmental Determinations](https://www.piercecountywa.gov/905/Environmental-Decisions) | Annual HTML / daily diff | Issue date, project, document type, PALS ID, location |
| Lookup | `pierce_pals` | [Pierce PALS](https://pals.piercecountywa.gov/palsonline/) | Dynamic search | Known PALS application detail/status |
| Lookup | `pierce_property_hub` | [Pierce Parcel/Property Information](https://www.piercecountywa.gov/969/Parcel-Property-Information) | Link hub | PALS, assessor, GIS, recorded-document paths |
| P1 | `tacoma_accela` | [Tacoma Accela](https://aca-prod.accela.com/TACOMA/Default.aspx) | Dynamic search | Tacoma permit/application status after terms and technical validation |
| Context | `pierce_arcgis_catalog` | [Pierce Open GeoSpatial Portal](https://gisdata-piercecowa.opendata.arcgis.com/) | ArcGIS catalog | Geography/parcel enrichment only until a stable permit layer is verified |

Golden HTML fixtures:

- Fredrickson Townhomes, PALS `1032039`, published April 1, 2026.
- Trailside Apartments, PALS `1049051`, published January 23, 2026.

Fixture facts prove parsing only; live status must be rechecked.

### 6.4 King County and Seattle

| Pri | Key | Source | Format / cadence | Required output |
|---|---|---|---|---|
| P0 | `king_public_notices` | [King Public Notices](https://kingcounty.gov/en/dept/local-services/buildings-property/public-notices-permit-records-search/public-notices) | HTML/docs / daily | Permit number, project, notice type, parcels, linked documents/record |
| P0 | `king_permit_reports` | [King Permit Reports](https://kingcounty.gov/en/dept/local-services/certificates-permits-licenses/permits/permits-inspections-codes-buildings-land-use/permit-forms-application-materials/reports) | Excel/Word / monthly | Issued permits and new applications with applicant information |
| P0 | `seattle_building_permits` | [Seattle Building Permits](https://data.seattle.gov/Built-Environment/Building-Permits/76t5-zqzr) | Socrata / daily | Source ID, description, location, status, application/issue/update dates |
| P0 | `seattle_land_use_permits` | [Seattle Land Use Permits](https://data.seattle.gov/Built-Environment/Land-Use-Permits/ht3q-kdvx) | Socrata / daily | Source ID, early project description, location, status/dates |
| P0 | `seattle_source_canary` | [Seattle Research a Project](https://www.seattle.gov/construction-and-inspections/resources/research-a-project) | Landing page | Current official research/data paths |
| Lookup | `mybuildingpermit` | [MyBuildingPermit Search](https://permitsearch.mybuildingpermit.com/) | Dynamic search | Jurisdiction, type/status, location, contractor/applicant, dates |
| P1 | `king_eprocurement` | [King Supplier Portal](https://kingcounty.gov/en/dept/executive-services/about-king-county/business-operations/finance-business-operations/procurement-payables/supplier-portal) | Authenticated | Customer-authorized notices, rosters, solicitations, addenda |

Socrata endpoints:

```text
https://data.seattle.gov/resource/76t5-zqzr.json
https://data.seattle.gov/resource/ht3q-kdvx.json
```

Inspect live columns before coding. Select required fields, use bounded `$limit` plus deterministic `$order`, filter on a stable time field, and persist a high-water mark with overlap. Do not issue unbounded queries.

King County reports apply to unincorporated King unless explicitly stated. Retain the permitting jurisdiction on every record. MyBuildingPermit is lookup-only until a documented bulk feed is approved.

### 6.5 Statewide SEPA

| Pri | Key | Source | Format / cadence | Required output |
|---|---|---|---|---|
| P0 | `wa_sepa` | [Ecology SEPA Register](https://ecology.wa.gov/regulations-permits/sepa/environmental-review/sepa-register) and [SEPA Search](https://apps.ecology.wa.gov/separ/Main/SEPA/Search.aspx) | Public search / daily | Lead agency, file number, county, proposal, location, applicant, issue date, description |

Query the four launch counties and deduplicate against local sources. If a stable lawful automated query/export cannot be verified, document the blocker and implement a controlled import or authorized notification path rather than browser fragility.

### 6.6 Procurement and private invitations

| Pri | Key | Source | Access | Required output |
|---|---|---|---|---|
| P1 | `lacey_procurement` | [Lacey RFP/RFQ](https://cityoflacey.org/rfp-rfq/) | Public | Solicitation, due date, addenda, plan-center link |
| P1 | `thurston_procurement` | [Thurston Opportunities](https://www.thurstoncountywa.gov/ContractOpportunities) | Public/external plan center | Solicitation and document path |
| P1 | `wa_des_bids` | [DES Bid Opportunities](https://des.wa.gov/sell/bid-opportunities) | Public entry | State opportunity path and current platform |
| P1 | `wa_webs` | [WEBS Vendor Portal](https://pr-webs-vendor.des.wa.gov/) | Customer-owned account | Notices and vendor workflow |
| P1 | `wa_bonfire` | [DES Bonfire](https://deswa.bonfirehub.com/) | Portal | Public-work solicitation metadata |
| P1 | `wa_prevailing_wage` | [L&I Wage Search](https://secure.lni.wa.gov/wagelookup/) | Public search | Public-work wage/project/prime/award context |
| P1 | `customer_bid_inbox` | Customer-authorized email/API/export | Private | Project, scope, GC/estimator, due date, addenda, invitation status |

Never scrape customer credentials. Private invitation artifacts require account-scoped object keys and authorization and must never enter shared/public data.

### 6.7 Entity verification

| Pri | Key | Source | Purpose |
|---|---|---|---|
| P0 | `wa_lni_verify` | [Washington L&I Verify](https://secure.lni.wa.gov/verify/) | Contractor identity, registration, specialty, and status |
| P1 | `wa_sos` | [WA Corporations Search](https://ccfs.sos.wa.gov/) | Legal entity/UBI/status corroboration |

Never show cached registration status without `verified_at`.

## 7. Core schema

Use UUID primary keys; official IDs are namespaced external IDs. Add indexes for external IDs, timestamps, jurisdiction, parcels, geometry, project stage, account/state, and job status.

```text
sources
  id, key, authority, landing_url, format, access_class, cadence,
  enabled, terms_reviewed_at, robots_reviewed_at, created_at

source_runs
  id, source_id, started_at, completed_at, status, checkpoint_json,
  discovered_count, fetched_count, parsed_count, rejected_count,
  error_count, schema_fingerprint, metrics_json

raw_artifacts
  id, source_id, source_run_id, parent_artifact_id, canonical_url,
  retrieved_at, source_published_at, content_type, http_status,
  storage_key, sha256, byte_size, headers_json, parser_version

source_records
  id, source_id, raw_artifact_id, external_id, record_type,
  first_seen_at, last_seen_at, source_updated_at, status,
  raw_fields_json, normalized_json, normalized_fingerprint

evidence_items
  id, source_record_id, raw_artifact_id, fact_path, evidence_text,
  page_or_section, source_url, authority_grade, parser_version

developments
  id, canonical_name, development_type, county, geometry,
  first_seen_at, last_seen_at

projects
  id, development_id, parent_project_id, canonical_name, project_type,
  permitting_jurisdiction, county, city, address_normalized,
  parcel_ids, geometry, current_stage, stage_confidence,
  first_seen_at, last_seen_at

project_external_ids
  project_id, authority, id_type, external_id

project_events
  id, project_id, source_record_id, event_type, event_date,
  observed_at, prior_stage, resulting_stage, material_change,
  confirmed, confidence

organizations
  id, canonical_name, legal_name, ubi, contractor_registration,
  organization_type, website, status, verified_at

organization_aliases
  organization_id, alias, source_id

project_roles
  project_id, organization_id, role, source_record_id,
  confirmed, confidence, first_seen_at, last_seen_at

account_profiles
  id, organization_id, name, active, capabilities_json,
  territory_json, exclusions_json, capacity_json, delivery_config_json

account_rules
  id, account_profile_id, rule_type, rule_json, version, effective_at

opportunities
  id, account_profile_id, project_id, current_score, score_version,
  route, state, first_qualified_at, last_material_change_at,
  rationale_json

opportunity_evidence
  opportunity_id, evidence_item_id, claim_type, confirmed, confidence

feedback
  id, opportunity_id, user_id, relevant, new_to_customer, timely,
  worth_pursuing, disposition_reason, notes, created_at

deliveries
  id, account_profile_id, delivery_type, period_start, period_end,
  rendered_content, status, idempotency_key, sent_at, metadata_json

delivery_items
  delivery_id, opportunity_id, project_event_id, position

coverage_entries
  id, source_id, county, permitting_jurisdiction, record_types,
  status, last_success_at, freshness_state, notes
```

Confirmed facts and inferences must occupy separate objects/rows or carry explicit `confirmed` and `confidence` fields.

## 8. Normalized source record

All parsers emit this Zod-validated shape; unknown values are `null`, never guessed or converted to zero.

```ts
type NormalizedSourceRecord = {
  sourceKey: string;
  externalId: string;
  recordType: string;
  title: string;
  description: string | null;
  permittingJurisdiction: string;
  county: "Thurston" | "Pierce" | "Lewis" | "King";
  city: string | null;
  addressRaw: string | null;
  parcelIds: string[];
  geometry: GeoJSON.Point | GeoJSON.Polygon | null;
  applicationType: string | null;
  permitType: string | null;
  documentType: string | null;
  statusRaw: string | null;
  normalizedStage: ProjectStage;
  applicationDate: string | null;
  issueDate: string | null;
  sourceUpdatedAt: string | null;
  valuationUsd: number | null;
  units: number | null;
  lots: number | null;
  squareFeet: number | null;
  organizations: Array<{
    name: string;
    role: string | null;
    evidenceText: string;
  }>;
  sourceUrl: string;
  evidence: Array<{
    factPath: string;
    text: string;
    pageOrSection: string | null;
  }>;
};
```

## 9. Project stages and events

Stages:

```text
concept
preapplication
entitlement
approved
construction_documents
permit_applied
permit_issued
bidding_confirmed
construction
near_final
complete
withdrawn
unknown
```

Events:

```text
project_first_seen
application_submitted
notice_published
sepa_determination
revision_submitted
decision_issued
plat_approved
permit_applied
permit_issued
solicitation_published
bid_addendum
bid_deadline_changed
award_published
inspection_activity
stage_changed
record_corrected
record_withdrawn
```

Only an explicit solicitation, customer invitation, or equivalent evidence may set `bidding_confirmed`. A permit is not proof of an open trade bid.

## 10. Resolution rules

Match in this order:

1. Same jurisdiction + official external ID.
2. Explicit permit/application/parent reference.
3. Parcel overlap.
4. Normalized address + compatible project name.
5. Geospatial proximity + compatible organization/project name.
6. Development/phase relationship supported by documents, parcels, and organizations.

Require review for:

- Conflicting parcels, addresses, jurisdictions, or owners.
- Generic names such as “Tenant Improvement.”
- Fuzzy matches without parcel/organization support.
- Same address with separate tenant projects.
- Current versus older legal entities with similar names.

Record the resolver version, features, score, merge decision, and evidence. Support split/undo. Never delete underlying source records.

Digest at the account-relevant project/phase level. A 40-permit subdivision cluster is one opportunity plus a velocity signal, not 40 leads.

## 11. Evidence rules

Authority grades:

- **A:** official government record, official solicitation, or authorized original invitation.
- **B:** official company/project/architect/GC page.
- **C:** credible secondary corroboration; never sufficient alone.
- **D:** unverified aggregation; discovery only and never customer-publishable.

Each delivered fact requires:

- Evidence row and original source URL.
- Source/record ID where available.
- Retrieved time.
- Page/section/row or evidence span.
- `confirmed = true`.

Label as inference:

- Likely trade fit.
- Likely procurement window.
- Unconfirmed organization role.
- Plausible scope inferred from description.

The verifier rejects unsupported exact scope, bid state, organization role, value, unit/lot count, deadline, or contact.

## 12. Account seeds

Store these in `config/account-profiles.yaml`; every rule must be versioned and editable.

### 12.1 Lacey Glass at Home

Sources: [site](https://laceyglassathome.com/), [about](https://laceyglassathome.com/about-us/), [windows/doors](https://laceyglassathome.com/windows-doors/).

Seed assumptions:

- Territory: Thurston, Lewis, Mason, Pierce, Grays Harbor.
- Products: windows, doors, showers, mirrors/glass, skylights, sunrooms.
- Best signals: subdivisions, approved phases, clustered SFR/townhome permits, low-rise multifamily joint review, late-stage shower/mirror opportunities.
- King County excluded until Lacey confirms coverage.

Seed score:

| Component | Weight |
|---|---:|
| Product fit | 25 |
| Repeatable units/lots or builder-account value | 25 |
| Timing | 20 |
| Territory | 10 |
| Builder/developer identified | 10 |
| Evidence quality | 10 |

### 12.2 Lacey Glass Commercial

Sources: [site](https://laceyglass.com/), [projects](https://laceyglass.com/projects/).

Seed assumptions:

- I-5 commercial glazing.
- Capabilities include storefront, curtain wall, entrances, skylights, canopies, specialty glass, translucent systems, and design/specification support.
- Route multifamily, mixed-use, retail, institutional, public work, and plausible Division 08 packages.
- Seattle/King routes here, not At Home.

Seed score:

| Component | Weight |
|---|---:|
| Division 08/system fit | 25 |
| Scale/value | 20 |
| Timing | 20 |
| Geography | 10 |
| GC/developer/architect known | 15 |
| Evidence quality | 10 |

Use `joint_review` for low-rise multifamily when system, height, package, or contracting route is unclear.

### 12.3 Solis Interiors

Verification: [L&I search](https://secure.lni.wa.gov/verify/), [Solis detail](https://secure.lni.wa.gov/verify/Detail.aspx?UBI=604837560&LIC=SOLISIL785NT&SAW=), [corporations](https://ccfs.sos.wa.gov/).

Seed identity:

- `Solis Interiors LLC`.
- UBI `604837560`.
- Contractor registration `SOLISIL785NT`.
- Public specialty observed: Dry Wall.
- Customer-confirmed capabilities: drywall and painting. Enable both trade profiles at seed time.
- Recheck status; the researched registration date ran through August 11, 2026.
- Exclude older closed UBI `604701295`.

Until calibrated, favor tenant improvements, moderate drywall/painting packages, and phased work. Treat very large multifamily as GC relationship radar when package size likely exceeds capacity.

Do not finalize scoring weights until Solis confirms detailed drywall/painting scope, territory, crew/subcontract capacity, minimum job size, preferred GCs, and public-work eligibility.

### Delivery bands

- `80–100`: priority review; alert only for a material timely change.
- `65–79`: weekly digest.
- `<65`: archive unless manually promoted.

## 13. AI contract

Use deterministic parsing and filtering first. Use models only for ambiguous extraction, classification, evidence mapping, brief drafting, and independent verification.

Required model output:

```json
{
  "facts": [
    {
      "path": "project.units",
      "value": 78,
      "evidenceId": "uuid",
      "confirmed": true,
      "confidence": 0.99
    }
  ],
  "inferences": [
    {
      "type": "trade_fit",
      "value": "commercial_glazing_plausible",
      "evidenceIds": ["uuid"],
      "confidence": 0.72,
      "reason": "System and package are not stated."
    }
  ],
  "missingCriticalFacts": ["general_contractor", "procurement_status"]
}
```

Reject unknown evidence IDs. Validate JSON with Zod. Store provider, model, prompt version, token use, cost, latency, and result hash. Enforce per-job and monthly spend limits.

Final scores are deterministic calculations over stored components; model prose never sets the score directly.

## 14. Source health

Track:

- Last attempt/success/new record.
- Discovered/fetched/parsed/rejected/duplicate counts.
- Error classes.
- Required-field null rate.
- Schema fingerprint and parser version.
- Publication delay versus cadence.
- Landing-page and canary-record health.

States:

- **Green:** successful within cadence and normal schema/volume.
- **Amber:** unexpected volume/null/schema/freshness change.
- **Red:** two consecutive failures, stale beyond twice cadence, required fields fall more than 20%, or unexpected zero usable records.

Suppress any delivery supported only by a red source. Show degraded coverage in admin and customer digest metadata.

## 15. Opportunity publication gate

An opportunity may enter a digest only when:

- Source is healthy.
- Project identity, geography, stage, and event date exist.
- At least one A-grade source supports the core event.
- Every fact has evidence.
- Inferences are separately labeled.
- No unresolved identity contradiction exists.
- Record is active/current for the relevant trade timing.
- Account score clears threshold.
- Independent verifier passes.

During the pilot, require human review for deadlines, high-value projects, ambiguous routing, contact data, and any externally actionable claim.

## 16. Application surface

Authenticated routes:

```text
/app/opportunities
/app/opportunities/{id}
/app/projects/{id}
/app/digests
/app/account-profile
/app/feedback
/app/admin/review
/app/admin/sources
/app/admin/source-runs/{id}
/app/admin/coverage
```

Opportunity page:

- Project, jurisdiction, county, address/parcel, stage, last material change.
- Route and component score.
- Confirmed facts versus inferences.
- Organizations/roles and evidence.
- Size/value/units/lots when supported.
- Timeline.
- Source links and retrieval dates.
- Missing critical facts.
- Recommended next action.
- Relevant/new/timely/pursue feedback and dismissal reason.

Admin source page:

- Source state, last run/new record, volumes, errors, null-rate trend, parser/schema version, canary status.
- Raw artifact and rejected-record inspection.
- Retry/disable controls; raw artifacts remain immutable.

## 17. API surface

```text
GET  /api/app/opportunities
GET  /api/app/opportunities/{id}
POST /api/app/opportunities/{id}/feedback
POST /api/app/opportunities/{id}/state
GET  /api/app/projects/{id}
GET  /api/app/digests
GET  /api/app/account-profile

GET  /api/admin/sources
POST /api/admin/sources/{key}/run
POST /api/admin/sources/{key}/disable
GET  /api/admin/source-runs/{id}
GET  /api/admin/review-queue
POST /api/admin/review-queue/{id}/decision
GET  /api/admin/coverage
```

Apply account/role authorization to every query. Private bid evidence is account-scoped.

## 18. Digest contract

Weekly sections:

1. Priority new opportunities.
2. Material stage changes.
3. Missing-fact verification queue.
4. Monitoring items.
5. Coverage/source-health caveat.

Each item includes project/stage, what changed, why it fits, confirmed facts, inference/caveat, next action, and source links.

Delivery is idempotent. Store rendered content, recipient, status, rules/models used, included opportunity/event IDs, and an idempotency key. Never label an unchanged repeated project as new.

## 19. Test gates

### Adapter

- Landing-page and artifact fixtures.
- Golden normalized output.
- Wrapped/missing/malformed/schema-change fixtures.
- Idempotent rerun and unchanged-hash tests.
- Pagination/checkpoint/backfill tests.
- Retry/rate-limit/dead-letter tests.
- Manual row/count comparison recorded in fixture metadata.

### Resolution

- Same project across SEPA, local notice, and permit.
- Subdivision with phases and clustered building permits.
- Same address with separate TIs.
- Similar names in different jurisdictions.
- Conflicting parcels/owners.
- Solis current versus older closed entity.
- Lacey Home/Commercial/joint routing.

### Intelligence

Label at least 200 examples before automatic inclusion:

- 50 Lacey Home positives.
- 25 Lacey Commercial/joint positives.
- 50 Solis positives.
- 75 hard negatives/duplicates/expired examples.

Maintain a holdout set.

| Metric | Gate |
|---|---:|
| ID/address/date extraction | ≥98% |
| Priority precision before automation | ≥90% |
| Relevant opportunity recall | ≥80% |
| Correct project clustering | ≥95% |
| Duplicate deliveries | <3% |
| Expired deliveries | <2% |
| Working original-source links | ≥98% |
| Unsupported facts | 0 |

### E2E

Test source → raw artifact → record → project/event → opportunity → review → digest → feedback. Test that one account cannot access another account's data or private artifacts.

## 20. Security and access

- Encrypt secrets and private evidence.
- Use least-privilege roles and signed object URLs.
- Keep credentials out of prompts, logs, fixtures, and Git.
- Redact auth tokens and sensitive query parameters from logs.
- Audit access to customer invitation artifacts.
- Respect source withdrawal/correction and required suppression.
- Preserve source attribution.
- Never redistribute restricted plan sets or private bid documents.
- Never auto-send prospecting, submit bids, quote prices, or commit a customer.

## 21. Ordered implementation backlog

Do not begin a later stage until the prior exit gate passes.

### M0 — scaffold

- `M0.1` Create workspace, applications, packages, lint/type/test configuration.
- `M0.2` Add Docker Compose and `.env.example`.
- `M0.3` Add database schema/migrations and seed framework.
- `M0.4` Add object store and immutable artifact repository.
- `M0.5` Add pg-boss jobs, retries, idempotency, dead letters, and structured logs.
- `M0.6` Add source manifest loader and fixture harness.

**Exit:** a fake adapter discovers, stores, hashes, parses, reruns idempotently, and reports health.

### M1 — P0 adapters

Implement in order:

1. `M1.1` Lacey REST + project pages.
2. `M1.2` Lewis planning HTML + linked documents.
3. `M1.3` Lewis weekly permit PDF index/parser.
4. `M1.4` Pierce environmental determinations.
5. `M1.5` King public notices.
6. `M1.6` King monthly report index + Excel/Word parsing.
7. `M1.7` Seattle building and land-use Socrata.
8. `M1.8` Washington SEPA.
9. `M1.9` Thurston active notices.
10. `M1.10` Tumwater ArcGIS + review/SEPA pages.

**Exit:** ≥90-day backfill where available, golden fixtures, correct county/jurisdiction, manual audit, and green health for all enabled P0 sources.

### M2 — project graph

- `M2.1` Normalize address, parcel, geometry, organization, and stage.
- `M2.2` Implement exact/lineage/parcel matching.
- `M2.3` Add fuzzy/geospatial candidate generation with review thresholds.
- `M2.4` Add development/phase hierarchy and event timeline.
- `M2.5` Add merge-review/split workflow.
- `M2.6` Add permit-cluster velocity events.

**Exit:** seed cross-source projects resolve with evidence; ambiguous cases remain reviewable; no source records are lost.

### M3 — pilot intelligence

- `M3.1` Seed and edit account profiles/rules.
- `M3.2` Implement route and score components.
- `M3.3` Add structured model extraction with budgets.
- `M3.4` Add evidence verifier/publication gate.
- `M3.5` Build opportunity/project/review UI.
- `M3.6` Build idempotent weekly digest preview/send.
- `M3.7` Add feedback and disposition reasons.
- `M3.8` Produce 5–10 reviewed current samples per company.

**Exit:** zero unsupported facts; different routing for Lacey Home, Lacey Commercial, and Solis; complete feedback loop; pilot can run without spreadsheets.

### M4 — controlled automation and P1 sources

- `M4.1` Label the 200-example evaluation set and holdout.
- `M4.2` Meet precision/recall/duplicate/expiry gates.
- `M4.3` Auto-include only independently verified high-confidence items.
- `M4.4` Keep human review for high-risk categories.
- `M4.5` Add high-value P1 sources based on measured coverage gaps.
- `M4.6` Add customer-authorized invitation ingestion.
- `M4.7` Add spend, health, stale-source, and delivery alerts.

**Exit:** ≥90% priority precision, <3% duplicates, <2% expired, zero unsupported facts, and 30–60 minutes of review per account/week.

## 22. Required pilot calibration

Keep affected rules provisional; do not block M0–M2.

Ask Lacey:

- At Home appetite for production versus custom/local builders.
- Minimum useful lots/units and capacity.
- Home/Commercial routing for apartments/townhomes.
- Existing/target/lost/incumbent-blocked builders.
- Product-specific lead times.
- Whether At Home serves King County.

Ask Solis:

- Current entity/license and renewal.
- Detailed drywall and painting scope, including interior/exterior work, coatings, wallcoverings, occupied renovation, and project-type preferences.
- Crew/subcontract capacity.
- Minimum/ideal job size and geography.
- Preferred/blocked GCs.
- Public-work/bonding/union/prevailing-wage constraints.
- Current invitation platforms and authorized ingestion method.

## 23. Final acceptance

The pilot release is complete when:

- All enabled P0 adapters have immutable evidence, tests, backfill, and health monitoring.
- Every record retains county and permitting jurisdiction.
- Cross-source records resolve into a reviewable development/project/event graph.
- Lacey Home, Lacey Commercial, and Solis receive account-specific routing.
- Every delivered fact links to evidence; unsupported facts equal zero.
- Permit/planning signals are never mislabeled as confirmed bids.
- Digests are change-aware and idempotent.
- Feedback updates only versioned rules.
- Red sources suppress unsafe deliveries.
- Account isolation and private-artifact access tests pass.
- The system can operate two paid design-partner accounts with ≤2 hours of human review per account/week initially.

**Governing rule:** one trustworthy evidence graph, account-specific interpretation, and no claim without a source.
