# Source policy

> Maintained as a deliverable: update this file every time a source goes through the activation checklist (M1 onward) — record verification dates, access decisions, and any blockers. Last updated: M1.1 Lacey activation (2026-07-15).

## Policy (spec §5–§6, §20)

- Only official public sources; discovery preference: documented API/JSON/CSV → downloadable report → static HTML → authorized email → permitted dynamic lookup → headless browser (approved sources only).
- Never bypass authentication, CAPTCHA, MFA, paywalls, or access controls. Never scrape customer credentials.
- Every fetch uses the explicit `SOURCE_USER_AGENT`, bounded concurrency (default 2), timeouts, and retry classification (429/5xx retryable with backoff; other 4xx fatal).
- Robots and terms are reviewed per source before enabling; the config loader rejects an `enabled` source without `terms_reviewed_at` and `robots_reviewed_at`.
- Raw artifacts are immutable and retained forever; source withdrawal/correction is honored at the record level (`status`, `record_withdrawn`/`record_corrected` events), never by deleting evidence.
- Lookup-class sources enrich known records only — never the sole alert source. Context-class sources never drive opportunity discovery.
- Private/customer-authorized artifacts (bid invitations) are account-scoped with restricted object keys — never in shared data (M4.6).

## Activation ledger

One entry per source, appended when the §5 checklist runs. Format:

```
### <source_key>
- Checklist run: <date> by <who>
- Landing page verified: <date> — <url observed>
- Format/cadence observed: ...
- Robots/terms: <summary + dates>
- Fixtures captured: fixtures/<source-key>/ (<list>)
- Manual sample audit: <n> records compared, <result>
- Shadow-mode runs: <dates, metrics>
- Enabled: <date> | Blocked: <reason>
```

### fake_source
- Checklist run: 2026-07-15 (M0 harness — not a live source).
- Fixture-backed only; never fetches the network. Exists to prove the M0 exit gate: discover → fetch → store/hash → parse → idempotent rerun → health.
- Fixtures: `fixtures/fake_source/` (manifest.json, permits-2026-06.json, permits-2026-07.json — includes one deliberately malformed row that must be rejected).
- Enabled: yes (test class).

### lacey_projects_rest
- Checklist run: 2026-07-15 (M1.1, agent session).
- Landing page verified: 2026-07-15 — https://cityoflacey.org/current-projects/ live; REST collection live at the documented access URL (HTTP 200, X-WP-Total 79, X-WP-TotalPages 1).
- Format/cadence observed: WP REST JSON (`id,date,modified,link,title`), orderable by `modified` desc, `per_page=100` + `page=N` pagination; city updates continuously — daily cadence.
- Robots/terms: robots.txt is empty (no restrictions), reviewed 2026-07-15; no site terms restricting automated access found; public city data.
- Fixtures captured: `fixtures/lacey_projects_rest/` (projects-page1.json — full 79-project live capture; metadata.json with audit).
- Manual sample audit: 3 records + row count compared against live payload and pages — pass (see fixture metadata.json).
- Shadow-mode runs: 2026-07-15 — discovered 1 page, parsed 79, rejected 0, health green; idempotent rerun unchanged=1, green.
- Backfill: REST exposes the full *current* project listing (backfill window filters on `modified`; 15 projects modified in trailing 90 days — all ingested). Checkpoint: `modifiedHighWater`.
- Enabled: 2026-07-15.

### lacey_project_pages
- Checklist run: 2026-07-15 (M1.1, agent session).
- Landing page verified: 2026-07-15 — https://cityoflacey.org/current-projects/ live; project detail pages render server-side under /projects/<slug>/.
- Format/cadence observed: WordPress theme HTML — `h2.text-center` title, "Project Background" description, `.marker` map lat/lng + address, `a.doc_block` document links, contact block; daily cadence.
- Robots/terms: same host as lacey_projects_rest — robots.txt empty, reviewed 2026-07-15.
- Discovery: from the documented REST collection (highest-preference), NOT landing-page scraping; `modified` high-water checkpoint with 1-day overlap skips unchanged pages.
- Fixtures captured: `fixtures/lacey_project_pages/` (2 live pages — one rich, one sparse; 1 synthetic schema-change fixture; metadata.json with audit).
- Manual sample audit: 2 pages field-by-field vs live — pass. No explicit stage on pages → `normalizedStage: "unknown"`, never guessed.
- Shadow-mode runs: 2026-07-15 — discovered 79, fetched 79, parsed 79, rejected 0, green (70 with address+geometry, 17 with prose parcels, 5 with evidence-bounded proponent orgs); idempotent rerun discovered 1 (checkpoint skip), unchanged 1, green.
- Enabled: 2026-07-15.

### lewis_current_planning
- Checklist run: 2026-07-15 (M1.2, agent session).
- Landing page verified: 2026-07-15 — https://lewiscountywa.gov/departments/community-development/current-planning-applications/ live; "Planning Applications Under Review" table with 14 rows (file numbers / project / type / files link).
- Format/cadence observed: CMS HTML table + per-application detail subpages (h1 restates file number + name; /documents/ links grouped under h2 sections); daily.
- Robots/terms: robots.txt disallows only /media/oldSite/ — reviewed 2026-07-15; public county pages.
- Fixtures captured: `fixtures/lewis_current_planning/` (landing.html, detail-sup25-0002-roamers.html, metadata.json with audit).
- Manual sample audit: 14-row count + 2 applications field-by-field vs live — pass. Stage mapping: rows are explicitly "active applications being processed" → statusRaw "under review", normalizedStage "entitlement".
- Live runs: 2026-07-15 — discovered 15 (landing + 14 subpages), parsed 14, rejected 0, green; idempotent rerun 12 unchanged + 3 duplicate (dynamic page bytes, identical normalized fingerprints), green.
- Backfill: not available — the page lists only current applications; historical apps via Laserfiche lookup class (out of M1 scope).
- Enabled: 2026-07-15.

### lewis_source_canary
- Checklist run: 2026-07-15 (M1.2, agent session).
- Landing page verified: 2026-07-15 — https://lewiscountywa.gov/departments/community-development/ live.
- Watches: planning (current-planning-applications), permits (building-permit-data), records (docs.lewiscountywa.gov Laserfiche), portal (SmartGov). Missing required links (planning/permits) throw → failed run → health alarm.
- SmartGov hostname discovered from the official page 2026-07-15: co-lewis-wa.smartgovcommunity.com (unwrapped from an Outlook safelink) — recorded here per the "never guess hostnames" rule for the future P1 lewis_smartgov adapter.
- Robots/terms: as lewis_current_planning.
- Fixtures: `fixtures/lewis_source_canary/` (landing.html, metadata.json).
- Live runs: 2026-07-15 — 1 canary record, all four links found, green; idempotent rerun unchanged, green.
- Enabled: 2026-07-15.

### lewis_issued_permits
- Checklist run: 2026-07-15 (M1.3, agent session).
- Landing page verified: 2026-07-15 — https://lewiscountywa.gov/departments/community-development/building-permit-data/ live; 49 PDF links (dated weekly "Issued Permits with Valuation" series since Nov 2025 + older undated BldgPermits_* names, which are skipped by design).
- Format/cadence observed: weekly PDF, rotated (landscape) table; /documents/ URLs 302-redirect to /media/documents/. One glitched CMS filename in the live index (06_C0394UQ.14.2026_...) — date parser tolerates one junk segment.
- Robots/terms: robots.txt disallows only /media/oldSite/ — reviewed 2026-07-15.
- Fixtures captured: `fixtures/lewis_issued_permits/` (landing.html, golden 06.28.2026 PDF per spec, metadata.json with audit).
- Manual sample audit: 15/15 rows field-by-field vs the rendered PDF — pass. Wrapped rows and applicant vs primary-contractor separation verified (spec golden requirements). Discrepancy recorded: printed grand total $88,135.10 > sum of printed per-row valuations $56,737.10 — blank cells stay null, never inferred.
- Live runs: 2026-07-15 — first run 16 PDFs / 386 permits / 0 rejected, green; checkpoint rerun 3 fetched all unchanged, green; 90-day backfill (2026-04-16→07-15) 12 PDFs all unchanged, green. DB: 385 permits, issue dates 2026-03-23→2026-07-10.
- Checkpoint: `reportDateHighWater` with 14-day overlap; first run covers 120 days.
- Enabled: 2026-07-15.

### pierce_environmental_determinations
- Checklist run: 2026-07-15 (M1.4, agent session).
- **Blocked: Cloudflare browser challenge.** https://www.piercecountywa.gov/ (incl. /905/Environmental-Decisions) returns HTTP 403 "Just a moment…" (challenges.cloudflare.com interstitial) for every client from this execution environment — tested with the declared OTNInsightsBot UA, a stock Firefox UA, and plain curl; the challenge is IP/TLS-fingerprint based, not UA-based. Solving it requires JS execution in a real browser context, which is bypassing an anti-bot access control — prohibited (spec §0/§20; source-policy "never bypass").
- PALS (pals.piercecountywa.gov) responds 200 from the same environment, but PALS is Lookup-class — enrich-only, never the sole alert source — so it cannot substitute.
- Mitigation: Pierce County SEPA determinations are also published statewide on the Ecology SEPA register (M1.8 `wa_sepa`), which keeps pilot coverage of Pierce environmental decisions alive while this source is blocked.
- Re-verification path: run the checklist from a network that Cloudflare does not challenge (e.g. the production runner or the customer's own connection); the adapter + golden fixtures (PALS 1032039 Fredrickson Townhomes, 1049051 Trailside Apartments) can be completed once representative HTML is capturable. No fixtures were fabricated.
- Enabled: no — remains disabled; blocker recorded 2026-07-15.

### king_public_notices
- Checklist run: 2026-07-15 (M1.5, agent session).
- Landing page verified: 2026-07-15 — https://kingcounty.gov/en/dept/local-services/buildings-property/public-notices-permit-records-search/public-notices live; one rolling table (185 tr), permit number linked to Accela search, notice type + cdn.kingcounty.gov PDFs, parcel numbers.
- Format/cadence observed: CMS HTML table, updated as notices post — daily.
- Robots/terms: kingcounty.gov robots.txt disallows only script/admin paths — reviewed 2026-07-15.
- Fixtures captured: `fixtures/king_public_notices/` (landing.html, metadata.json with audit).
- Manual sample audit: DWEL25-0209, GRDE23-0083, multi-permit SHOR25-0022/0023, non-permit SEPA/STRC rows — pass. Jurisdiction fixed to Unincorporated King County per spec §6.4; no dates printed in the table → date fields null.
- Live runs: 2026-07-15 — 170 records, 0 rejected, green; idempotent rerun 170 duplicates (page bytes changed, fingerprints identical), green.
- Infrastructure note: kingcounty.gov is only reachable from this environment via the HTTPS_PROXY egress; FetchPolicy now honors standard proxy env vars (undici EnvHttpProxyAgent) — no-op when unset.
- Backfill: not available — rolling current-notices list only.
- Enabled: 2026-07-15.

### king_permit_reports
- Checklist run: 2026-07-15 (M1.6, agent session).
- Landing page verified: 2026-07-15 — report index live; 136 Excel links across two monthly series (issued-permits, new-applications) back to 2021 on cdn.kingcounty.gov.
- Format/cadence observed: monthly .xlsx (pre-2025 legacy .xls skipped by design); header-keyed parsing covers both layouts (issued: INTAKE COMPLETE DT/ISSUED DATE/DWEL UNITS; new: APPL DT/DWELLING UNITS). Hyperlinked permit numbers (Accela) and parcels (GIS viewer) preserved in rawFields. Live index contains one mistyped future-dated link (…2028-08.xlsx) — skipped with a warning, never fetched, never advances the checkpoint.
- Robots/terms: kingcounty.gov robots reviewed 2026-07-15 (script/admin paths only).
- Fixtures captured: `fixtures/king_permit_reports/` (landing.html + June 2026 issued + June 2026 new-applications, metadata.json with cell-level audit).
- Manual sample audit: ADDC22-0668 and FLOD26-0179 cell-by-cell — pass. JOB VALUE 0 → null. Stage mapping deterministic per report kind (permit_issued / permit_applied).
- Live runs: 2026-07-15 — 8 reports (4 months × 2 kinds) → 3,082 rows, 0 rejected, green; checkpoint rerun 4 unchanged; 90-day backfill 6 unchanged. DB: 1,446 issued permits (2026-03-02→06-30) + 474 applications.
- Checkpoint: `monthHighWater` with 1-month overlap (reports get revised); first run covers 4 months.
- Enabled: 2026-07-15.

### seattle_building_permits / seattle_land_use_permits
- Checklist run: 2026-07-15 (M1.7, agent session).
- Live columns inspected before coding (spec §6.4 rule): building 76t5-zqzr (permitnum, permitclass(+mapped), permittype(desc/mapped), description, housingunits, estprojectcost, statuscurrent, applied/issued/completed/expires dates, address, lat/lng, portal link, relatedmup); land-use ht3q-kdvx (subset, same core).
- **Key finding:** both datasets are fully republished nightly — every row shares one `:updated_at` (verified: count where :updated_at > 90d ago = total count), so `:updated_at` is useless for increments. High-water uses the stable `applieddate` with a 30-day overlap; status changes on records older than the overlap are not re-observed until enrichment (documented limitation).
- Query discipline: bounded `$limit=1000`, deterministic `$order=applieddate, permitnum`, explicit `$where` window, count-query pagination — never unbounded.
- Stage mapping (deterministic, date-evidenced): building — completeddate → complete, issueddate → permit_issued, else permit_applied; land-use — MUP is the entitlement instrument: decision issued → approved, pending → entitlement.
- Fixtures: `fixtures/seattle_building_permits/` (June 2026 window, 514 rows), `fixtures/seattle_land_use_permits/` (90-day window, 78 rows), metadata.json with audits.
- Live runs: 2026-07-15 — building 2,117 records (applieddate 2026-03-17→07-13), land-use 118 (03-18→07-13), 0 rejected, green; 90-day backfill 1,536 rows all duplicate-by-fingerprint, green; checkpoint reruns green.
- Health refinement: the §14 volume-drop amber now also exempts runs with `duplicateCount > 0` — checkpoint windows legitimately shrink after a wide first run, and duplicates prove source consistency (collapse is still caught by the zero-usable red rule).
- Enabled: 2026-07-15.

### seattle_source_canary
- Checklist run: 2026-07-15 (M1.7, agent session).
- Watches the SDCI Research-a-Project page for the two Socrata dataset links (76t5-zqzr, ht3q-kdvx — required; open data portal and permit-history map — optional). Missing dataset links throw → failed run → health alarm.
- Fixtures: `fixtures/seattle_source_canary/`. Live run: 1 record, all four links found, green.
- Enabled: 2026-07-15.

### wa_sepa
- Checklist run: 2026-07-15 (M1.8, agent session).
- **Access decision:** Ecology's separ search UI is robots-disallowed for query URLs (`Disallow: /separ/*?*`). The register is instead consumed from the official data.wa.gov Socrata dataset **mmcb-z6jf** ("State Environmental Policy Act (SEPA) Register" — catalog provenance `official`, attribution *Washington State Department of Ecology*, updated same-day; 190,220 rows since 2000). Per-record `separegisterlink` still cites the official separ record page — cited, never fetched.
- Format/cadence observed: Socrata JSON, daily updates. Live columns inspected 2026-07-15 (separegisterid, sepanumber, proposalname/type/description, lead agency name/file number/contact, leadagencyissuedate, applicantname, documenttypecode, countyname, commentsduedate, separegisterlink).
- Query discipline: bounded `$limit=1000`, deterministic `$order=leadagencyissuedate, separegisterid`, `countyname in('THURSTON','PIERCE','LEWIS','KING')`, issue-date window — never unbounded. Checkpoint `issueDateHighWater` + 14-day overlap (issue dates can be future-dated for comment periods).
- externalId = separegisterid (row-level document record; one SEPA number can have several documents). sepanumber + leadagencyfilenumber retained for M2 official-ID resolution. normalizedStage stays "unknown" — SEPA document type → stage/event mapping is M2's job, and non-project actions must not be forced into project stages.
- Fixtures: `fixtures/wa_sepa/` (register landing + 407-row 90-day pilot-county window, metadata.json with audit).
- Live runs: 2026-07-15 — 564 records (120-day window), 0 rejected, green; overlap rerun 66 duplicates, green; 90-day backfill 407 duplicates, green. This also provides the documented Pierce mitigation while M1.4 is blocked.
- Enabled: 2026-07-15.

### thurston_active_notices
- Checklist run: 2026-07-15 (M1.9, agent session).
- Landing page verified: 2026-07-15 — Drupal 11 "Comment on a Project" page live; "Projects with Active Notices" accordion with 60+ items (project number + name/issuance-or-hearing date in the button; description, "Location:" line, comment/materials links in the body).
- Migration canary honored: the announced-for-Sept-2026 permitting system is watched implicitly — a missing section or zero notices throws → failed run → health alarm. The what's-new page stays on the M2+ watchlist.
- Robots/terms: Drupal-standard robots (core/admin paths only) — reviewed 2026-07-15.
- Fixtures: `fixtures/thurston_active_notices/` (landing.html, metadata.json with audit).
- Manual sample audit: 2019101651 Moore Garage RUE + 2025100139 Hernandez RUE field-by-field — pass. Two heading styles handled (named + numeric "Date of Issuance", incl. 2-digit years). Multiple notices per project merge into one record (all notices in rawFields). Stage stays "unknown" (heterogeneous notice types), statusRaw "active notice".
- Live runs: 2026-07-15 — 63 project records, 0 rejected, green; idempotent rerun unchanged, green.
- Backfill: not available — rolling active-notices page only.
- Enabled: 2026-07-15.

### tumwater_development_arcgis
- Checklist run: 2026-07-15 (M1.10, agent session).
- Access verified: 2026-07-15 — public ArcGIS Online FeatureServer layer "PrivateDevelopment" (services6.arcgis.com), 44 features; layer metadata + full snapshot captured. maxRecordCount 2000, bounded resultOffset paging.
- Fields observed: PermitNumber (comma-lists occur), ProjectType (coded domain), ProjectDescription, DevelopmentStatus (**official coded-value domain** UC/RP/PA/LUAA/FSPR/PAC), PIN1/PIN2/Parcel2 (mixed string/number typing tolerated), Web Mercator point geometry (converted to WGS84), created/last_edited dates (epoch ms).
- Stage map from the layer's own domain: UC→construction, RP→permit_applied, PA "Permits Approved"→permit_issued, LUAA "Land Use Application Approved"→approved, FSPR/PAC→preapplication. Unknown codes warn and stay "unknown".
- externalId = GlobalID (stable); checkpoint `lastEditedHighWater` (snapshot layer — full fetch every run, backfill filters on last_edited_date).
- Fixtures: `fixtures/tumwater_development_arcgis/` (layer-metadata.json, all-features.json, metadata.json with audit).
- Live runs: 2026-07-15 — 44 records, 0 rejected, green; idempotent rerun unchanged, green.
- Enabled: 2026-07-15.

### tumwater_development_review / tumwater_sepa
- Checklist run: 2026-07-15 (M1.10, agent session).
- **Blocked: Akamai edge denial.** https://www.ci.tumwater.wa.us/ (incl. the development-review and NOA/SEPA pages, and even robots.txt) returns HTTP 403 "Access Denied" (errors.edgesuite.net reference) for every client from this execution environment — tested with the declared bot UA and a stock Firefox UA. Working around an edge access control is prohibited (same policy class as the Pierce Cloudflare blocker).
- Mitigation: (a) `tumwater_development_arcgis` covers Tumwater private development projects incl. official status; (b) Tumwater-lead-agency SEPA/NOA determinations appear on the statewide register — `wa_sepa` shows 17 City-of-Tumwater records in the trailing year.
- Re-verification path: run the checklist from an unchallenged network; no fixtures were fabricated.
- Enabled: no — both remain disabled; blockers recorded 2026-07-15.

## Known migration canaries (watch during M1)

- **Thurston County**: new permitting system announced for September 2026 — verify the "what's new" page before and during M1.9.
- **Lewis County**: `lewis_source_canary` watches the Community Development landing page for link changes; SmartGov hostname must be discovered from the official page, never guessed.
- **Seattle**: `seattle_source_canary` watches the Research-a-Project page; inspect live Socrata columns before coding M1.7.

### lacey_permit_reports
- Checklist run: 2026-07-16 (M4.5, agent session; measured gap: zero Lacey permit-stage records in the corpus).
- Landing page verified: 2026-07-16 — https://cityoflacey.org/permit%20reports/ live; 129 PDF links (monthly "Census Report (New Construction)" + "Construction Activity" series back to 2015).
- Format/cadence observed: monthly PDF. **Two live layout variants**: June 2026 = permit table page + separate "Permit Valuations Amt" page paired by row order; May 2026 = single page with inline valuation column and wrapped 3-line header/subtype cells. Columns are located from the header band, never assumed. Valuation count mismatch ⇒ all valuations null (never guessed). Companion "Construction Activity" PDFs carry category counts only — deliberately not ingested. April 2026 filename omits the year — month falls back to the upload-path year.
- Robots/terms: cityoflacey.org has no robots disallow — re-reviewed 2026-07-16.
- Fixtures captured: `fixtures/lacey_permit_reports/` (landing.html, June + May 2026 PDFs — one per layout variant, metadata.json with audit).
- Manual sample audit: June 14/14 rows and May 9/9 rows field-by-field vs the rendered PDFs; parser sums reconcile exactly with the reports' printed totals (June: 14 permits / 177 units / $30,114,355.51; May: 9 permits / $3,169,415.56) — pass.
- Live runs: 2026-07-16 — shadow 4 reports / 50 permits / 0 rejected, green; idempotent rerun all unchanged, green; backfill 2026-01→07: 6 reports / 67 permits total, green. 65/67 auto-resolved; 2 correctly held in merge review (same-address name mismatch).
- Checkpoint: `censusMonthHighWater` (last month refetched; hash dedupe).
- Enabled: 2026-07-16.

### lewis_inspections
- Checklist run: 2026-07-16 (M4.5, agent session; late-stage trade-timing signal per spec §12.1).
- Landing page verified: 2026-07-16 — https://lewiscountywa.gov/…/daily-building-inspections/ live; links the current day's "MM.DD.YYYY_Scheduled_Inspections_-_Permitting.pdf" (302 → /media/documents/).
- Format/cadence observed: daily PDF grouped by inspector; columns Scheduled Date / Permit Number / Inspection / Reason / Site Address / Project Description (midpoint column bounds — cell x jitters). Time cells render truncated by the county's generator ("8:...") and are not facts we keep.
- **No archive exists** — the county replaces the file daily, so there is no backfill; freshness is strict (spec P1 note). Stage mapping: FINAL INSPECTION ⇒ near_final; any other inspection ⇒ construction. Inspections merge into existing permit projects via rawFields.permitNumbers (explicit-reference pass) — verified live: 4/15 merged into M1.3 permit projects (e.g. B26-00232 SFR + FRAMING COMBO).
- Robots/terms: lewiscountywa.gov robots disallows only /media/oldSite/ — re-reviewed 2026-07-16.
- Fixtures captured: `fixtures/lewis_inspections/` (landing.html, 07.15.2026 PDF, metadata.json with audit).
- Manual sample audit: 15/15 rows vs the rendered PDF; printed per-inspector totals (9 + 6) reconcile — pass.
- Live runs: 2026-07-16 — shadow 1 PDF / 15 inspections / 0 rejected, green; idempotent rerun unchanged, green.
- Checkpoint: `inspectionDateHighWater` (older days never refetched — files are replaced in place).
- Enabled: 2026-07-16.

### thurston_activity_reports
- Checklist run: 2026-07-16 (M4.5, agent session).
- **Blocked: repository robots-disallowed.** The county's project-status page (verified live 2026-07-16) links "Monthly Land Use Activity Reports & Weekly Building Permit Reports" hosted on Laserfiche WebLink at weblink.co.thurston.wa.us — whose robots.txt disallows everything (`Disallow: /`, plus explicit `/*.pdf`, `/Browse.aspx`). Same policy class as the Ecology separ UI (M1.8): we do not crawl robots-disallowed hosts. Feasibility was confirmed before robots review (folders "Weekly Building Permit Reports" 2009–2026 with dated per-week PDFs at stable /CPED/0/edoc/<id>/Report-YYYY-MM-DD.pdf URLs) — no adapter was built and no crawling occurs.
- Mitigations: `thurston_active_notices` (M1.9) and `wa_sepa` keep Thurston planning coverage; the county's "BDC Digest" email newsletter is a candidate authorized-email source (discovery preference list) if the county consents; permit-lookup remains Lookup-class enrich-only.
- Re-verification path: ask Thurston CPED for permission/an alternate feed, or re-check robots.txt periodically.
- Enabled: no — remains disabled; blocker recorded 2026-07-16.

### olympia_smartgov_reports
- Checklist run: 2026-07-16 (M4.5, agent session; measured gap: Olympia has zero permit-stage coverage).
- **Deferred: dynamic Exago BI viewer.** https://ci-olympia-wa.smartgovcommunity.com/Public/ReportsView is live (verified 2026-07-16) and publicly lists exactly the needed reports ("Permit Applications Submitted Last 30 Days", "Permits Issued Last 30 Days"/"Year To Date", "Land Use Activity - Year to Date"), but each opens via `ViewReport?reportId=<guid>&reportType=Exago`, redirecting to a session-stateful ASP.NET/Exago viewer (reports-new.smartgovcommunity.com) whose data loads through AJAX postbacks — no static artifact to fetch. Extraction requires an approved headless-browser adapter (last resort class per source policy); deferred until that approval rather than shipping a brittle session-protocol scraper.
- Mitigations: `wa_sepa` covers Olympia lead-agency SEPA actions; Olympia remains the top P1 gap for a future approved dynamic adapter.
- Enabled: no — remains disabled; deferral recorded 2026-07-16 with verified report GUIDs in session notes.

### census_geocoder (enrichment service — not a record source)
- Verified: 2026-07-17 (agent session). `https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress` — official US Census Bureau public geocoding API, free, keyless, intended for programmatic use (documented at geocoding.geo.census.gov). Live request verified format + county-geography layer.
- Scope: location enrichment ONLY. It never creates records, evidence, stages, or claims — a geocoded point is a labeled inference (`projects.geometry_source = 'census_geocoder'` + full attempt metadata) and never overwrites a record's own geometry.
- Fabrication guard: normalized addresses are street-only, so a result is accepted only when the match is unique AND its returned county equals the project's stored county; everything else is recorded as no_match/ambiguous/county_mismatch with no location written.
- Pacing: sequential requests, 150 ms default delay, default 500 addresses/run (`pnpm geocode:run`).

### pierce_permits_arcgis
- Checklist run: 2026-07-17 (agent session, Batch2 #1 — lead-time-driven entitlement coverage; Pierce had zero permit-stage sources).
- Verified: Pierce County's official open-data portal (gisdata-piercecowa.opendata.arcgis.com) publishes "Permits Pierce County" — the PALS application/permit extract — as a public FeatureServer on the county's ArcGIS org (services2.arcgis.com/1UvBaQ5y1ubjUPmd). This infrastructure is NOT behind the piercecountywa.gov Cloudflare challenge that blocks M1.4; no robots restriction on the query endpoints; documented-API access class (highest discovery preference).
- Shape: 679,941 rows (decades of history); ~3,500/trailing-90d across building, land use (incl. Pre-Application Screening, Land Use Permit, SEPA Review, Land Div, Shoreline), environmental, fire, sewer. Application/submittal/issued/final dates, official status, parcel, valuation, dwelling units, WGS84 point, per-record PALS deep link (pals.piercecountywa.gov — recorded as the citation URL, never crawled).
- Adapter: trailing 120-day window on applicationDate OR issuedDate (day-quantized for artifact dedupe), bounded paging at maxRecordCount 2000, deterministic order by applicationNumber; backfill by applicationDate range. Status changes on known records arrive as fingerprint diffs → `applyRecordUpdates` emits the stage-change event (application → issuance becomes visible lead time).
- Fixtures: layer-metadata.json + window-page-1.json (451 features, July 2026 window); manual comparison recorded in fixtures/pierce_permits_arcgis/metadata.json (counts + 2 verbatim spot checks). 5 parser tests incl. unmapped-status degradation and valuation-0→null.
- Shadow run 2026-07-17: 6,001 records / 4 pages, 0 rejected, 0 errors; idempotent rerun 6,001 duplicates / 0 new; backfill 2026-02-01→03-18: 1,452 new + 410 overlap duplicates, 0 errors. Health green.
- Enabled: yes — 2026-07-17. Mitigates: pierce_environmental_determinations (SEPA Review rows provide substitute coverage; wa_sepa remains primary).
- Parser 1.1.0 (2026-07-17, commercial pre-permit track): pre-application screenings now pin to `preapplication` — the screening's own Accepted/Approved/Final lifecycle no longer walks the permit stages (the old mapping overstated 411 "approved" + mapped "Final" screenings to `complete`). D5 replay over 9 stored artifacts: 13,864 re-parsed, 436 corrected, 0 errors; 424 affected project stages recomputed (max over active records). Coverage note: this layer IS the county's pre-permit commercial feed — Pre-Application Screening ×1,802, SEPA Review ×7,888, Land Use Action ×3,801, Short plat ×2,755 all-time on the same FeatureServer; the 120-day window ingests them continuously.

### puyallup_permits_arcgis
- Checklist run: 2026-07-17/18 (agent session, suburb-city SFR track — customer directive: improve SFR source quality in Pierce/Lewis/Thurston suburb cities; Puyallup is the largest Pierce suburb, covered by neither PALS-unincorporated nor Tacoma Accela).
- Verified: ArcGIS org `5K6vnOH0GkPyJs6A` resolves to name "City of Puyallup" (urlKey puyallup); the `City_View/FeatureServer/0` "Permits" layer is the operational layer behind the city's official Permit Viewer Web Experience (item cde5b0c96ea24ef89ebec30da40d93a9, same org). Documented-API access class; per-record deep links to permits.puyallupwa.gov (citation URLs).
- Shape: 25,595 rows since 2008-05; types incl. Residential - New Single Family Dwelling (×1,484 all-time), Residential Remodel/Alteration, Commercial New/TI, **Pre-Application (×343 in a 120-day window)**. Status vocabulary enumerated (19 values incl. "Administrative Approval" found live on run 1 — added to the map, replayed). **Data quirks recorded:** `IssueDate` is `esriFieldTypeString` with MIXED values (epoch ms and "MM/DD/YYYY", 530/1175 strings in first capture) → parser normalizes both, unparseable → null; window uses the typed-date fields only (ApplicationDate OR ClosedDate, 210 days for issuance-lag margin). `FeeAmount` is permit FEES — never mapped to valuation (stays null).
- Adapter: trailing 210-day window (day-quantized), OBJECTID paging at 2000; pre-application types pin to `preapplication` (same rule as Pierce/Tacoma); backfill by ApplicationDate range.
- Fixtures: fixtures/puyallup_permits_arcgis/ (layer-metadata + window page 1, 2,000 features); manual comparison + verbatim SFR spot checks (PRRNSF20241562/20250245/20260469) in fixtures/puyallup_permits_arcgis/metadata.json. 4 parser tests incl. mixed-date normalization and fees-never-valuation.
- Shadow 2026-07-18: 2,126 parsed / 0 rejected / 0 errors, health green; idempotent rerun 2 pages unchanged-hash; D5 replay after status-map addition (2,144 re-parsed, 952 corrected); backfill 2025-09-01→12-19: +364 new, 140 overlap duplicates, 0 errors. Resolution: 1,557 processed → 506 merged, 933 created, 116 review, 0 errors; Solis +132 routed.
- Enabled: yes — 2026-07-18.

### centralia_permit_reports
- Checklist run: 2026-07-18 (agent session, suburb-city SFR track — Lewis County's largest city; county sources cover unincorporated Lewis only).
- Verified: official City of Centralia site (cityofcentralia.com — NOT the unrelated centralia.com); the Building Permit Statistics page lists one issued-permit report per month, Nov 2024 → Jun 2026 (20 reports), as server-rendered /DocumentCenter/View links (three title styles across the series, all month-parsed). robots.txt reviewed 2026-07-18. Static-PDF access class.
- Shape: 30–78 issued permits/month with permit number, type, ISSUE date, owner, address, parcel, **CONTRACTOR name**, comments, and stated project value — the value column is the project value the city itself totals per month, so it maps to `valuationUsd` (a blank prints as an accounting dash → null, never zero). Every row is `permit_issued`; "Owner" in the contractor column = owner-performed (no org emitted).
- Parser: positioned-text with per-page STRUCTURAL column derivation (permit/date/parcel columns pinned by content, remaining columns by frequency peaks — cell starts repeat per row, intra-cell word x's scatter), bottom-aligned wrapped-cell assembly (fragments stack upward onto the anchor line), sparse spill pages inherit the previous page's geometry. Survives the source's THREE format generations (word-level glyph runs + split header words pre-May-2025; cell-level runs + rotated headers after) and its glyph quirks: merged permit+type runs ("202500798 Mechanical"), space-split permit numbers ("2026 0328 Demo" = 20260328), merged date+owner runs, page-spilled last rows.
- **D1 invariant:** parsed valuation sum reconciles against the report's own printed monthly total per artifact (`centralia_printed_valuation_total`, ±$0.01). Verified across the FULL series 2026-07-18: all 20 reports reconcile to the penny (e.g. Feb 2026 $2,584,093.08 / 55 rows; Dec 2025 $45,949,776.35 / 48 rows). Source-side typo noted: permit 20260073 (Feb 2026) prints DATE "2/11/2023" — stored verbatim, never corrected.
- Fixtures: february-2026.pdf, may-2026.pdf, july-2025.pdf + index.html + metadata.json (verbatim spot checks incl. Century Communities SFR-New at $379–438k). 18 parser/discovery tests.
- Shadow 2026-07-18: 4 reports / 220 records / 0 rejected / 0 errors (one invariant catch — the May split-permit row — fixed and D5-replayed); full-series backfill 2024-11-01→2026-07-18: 20 reports / 850 parsed / 0 errors; final replay 1,074 records re-parsed, 0 errors. Health green. Resolution + scoring: Solis 3,283 → 3,631 opportunities; GC league gains Centralia contractors (Century Communities of WA LLC ×69, Chehalis Sheet Metal ×76).
- Enabled: yes — 2026-07-18. Discovery uses a monthHighWater checkpoint (1-month overlap for amended reposts); weekly poll of a monthly series.

### Suburb-city sweep notes (2026-07-17/18, verify-first)
Monthly-PDF sweep completed 2026-07-18:
- **Centralia (Lewis) — BUILT + ACTIVATED 2026-07-18** (see `centralia_permit_reports` ledger entry above).
- **Tumwater (Thurston) — BUILD BLOCKED AT EGRESS LEVEL 2026-07-18 (attempt logged):** the NOA/SEPA page is live and current (4-column table: Project + TUM-case number, Notice of Application, SEPA Determination, Notice of Decision, each a dated link to a city PDF `/showpublisheddocument/<id>` or the state SEPA register — content confirmed through 06/12/2026 via an out-of-band reader). But collection from THIS environment is impossible without bypassing access controls, which we do not do: Akamai (edgesuite) 403s both the transparent `OTNInsightsBot` UA and a browser UA, and stock Chromium (no bypass tooling) gets `net::ERR_CONNECTION_RESET` — the same datacenter-egress IP block as Olympia. The `tumwater_development_review`/`tumwater_sepa` stubs stay disabled. **Honest paths:** (a) operator saves the two pages (and linked notice PDFs) from a normal browser into a provided directory — the customer-provided-file pattern — after which the parser is built against real bytes; (b) operator-local collection run (non-datacenter egress). **Mitigation in place:** `wa_sepa` carries Tumwater-lead-agency SEPA determinations (config `mitigates` already lists both stubs) and `tumwater_development_arcgis` remains green; the gap is NOA/NOD dates and non-SEPA notices only.
- **Lakewood (Pierce) — ROW-LEVEL REVIEW DONE 2026-07-18, verdict NO-BUILD:** fetched Q3 2024 (the last quarterly ever published) + the 2025 Annual Permit Performance Report from our egress (robots allows `*`; only named AI-training UAs are disallowed; content-signal `ai-train=no` noted — we collect facts for reference, never train). (1) The quarterly reports are NARRATIVE newsletters — project highlights with photos, names, and unit counts (e.g. ~150-unit Woodbrook MF, Swan Grove 90u, Heron Heights 36u, Copperstone 24u) but NO per-permit rows, and the series was DISCONTINUED after Q3 2024. (2) The annual report is the RCW permit-timeliness matrix: permit IDs, types, application/decision dates, review-day counts — no address, no parcel, no valuation, no contractor, published once a year in February — useless for opportunity timing. Neither supports a deterministic per-permit adapter with ongoing cadence. **Future candidate recorded:** Lakewood switched permitting to an OnCamino "Online Permit Center" June 2025 (old dashboard retired) — verify-first whether OnCamino exposes public search/JSON endpoints before any build; until then Lakewood city permits remain a coverage gap (PALS is unincorporated-only) partially visible via wa_sepa + pierce_environmental notices.
- **Bonney Lake (Pierce):** monthly BLDGPERMITRPT PDF series existed on the OLD CivicLive CMS (2021–2022 archive still up) but 404s for 2024+ — series apparently discontinued after the bonneylake.gov migration; the current Building Permits page links forms only. Recheck occasionally.
- **Sumner (Pierce):** no permit-report series found (site reachable; permits page is forms/specs only).
- **Chehalis (Lewis):** a "Permits Issued" page EXISTS (ci.chehalis.wa.us/building/page/permits-issued-1, monthly copies per the building dept) but the site 403s every fetcher from our egress (curl + WebFetch). Blocker recorded; do not bypass.
- **Olympia (Thurston):** BLOCK CONFIRMED AT NETWORK LEVEL 2026-07-18 — stock Chromium (no bypass tooling) gets net::ERR_CONNECTION_RESET on both hosts; curl gets 403. The block is against our datacenter egress IP range, not the client. Honest paths: run collection from a non-datacenter connection (e.g. operator's local Claude Code), or operator manually saves pages/reports into a provided directory (the customer-provided-file pattern). Never bypassed.
- Lookup-class portals (MyBuildingPermit, Eden, CivicLive permit portals) remain enrich-only per policy — never the sole alert source.

### tacoma_permits_arcgis
- Checklist run: 2026-07-17 (agent session, Batch3 #3 — Pierce PALS covers unincorporated county only; Tacoma is the pilot region's second-largest city with zero prior coverage).
- Verified: Tacoma Open Data (tacomaopendata-tacoma.hub.arcgis.com, the city's ArcGIS org SCwJH1pD8WSn5T5y) publishes "Accela Permit Data" as a public FeatureServer, refreshed daily (pull_date). Documented-API access class; no robots restriction on the query endpoints. data.cityoftacoma.org (the old Socrata portal) no longer resolves — the ArcGIS hub is the current official portal.
- Shape: 109,728 rows; ~4,150/trailing-120d across Building (largest), Right-of-Way, Utility, ePermit, Site, Pre-Application, Land Use, Sign. Application/issued dates, 52-value Accela workflow status (deterministic pattern-bucket stage map; unknown statuses degrade to "unknown" with a warning, never guessed), applicant_name (confirmed applicant role), address, 10-digit Pierce parcel, valuation/housing_units (0 → null, never a real zero), WGS84 point, per-record Accela portal deep link (aca-prod.accela.com — citation URL only, never crawled; &amp; unescaped).
- Adapter: trailing 120-day window on application_date OR issued_date (day-quantized URLs — same-day reruns hash-dedupe), bounded paging at maxRecordCount 1000, deterministic objectid order; backfill by application_date range. Issuance updates the same record → applyRecordUpdates emits the stage-change event.
- Fixtures: layer-metadata.json + window-page-1.json (1,000 features); manual comparison in fixtures/tacoma_permits_arcgis/metadata.json (counts + verbatim spot check PLMBC26-0138). 3 parser tests.
- Shadow run 2026-07-17: 4,206 records / 5 pages, 0 rejected, 0 errors; idempotent rerun: 5 pages unchanged-hash, 0 re-parsed; backfill 2026-01-01→03-18: +1,617 new, 379 overlap duplicates, 0 errors. Health green.
- Enabled: yes — 2026-07-17.
- Parser 1.1.0 (2026-07-17): same pre-application fix as Pierce — Pre-Application case workflow statuses pin to `preapplication`. D5 replay over 7 artifacts: 6,202 re-parsed, 180 corrected, 0 errors. Coverage note: the Accela extract carries Land Use (×130 in-window) and Pre-Application cases — Tacoma's pre-permit commercial feed is this same layer.

### tacoma_solicitations
- Checklist run: 2026-07-17 (agent session, P5 — first public procurement source; the roadmap's "only public path to bidding_confirmed").
- Verified: tacoma.gov robots.txt allows all; the city's procurement pages publish open solicitations as static HTML tables across three category pages (public works / services / supplies): spec number, RFB/RFP type, due date/time, title + document links, date issued. Documented static-HTML access class.
- Policy note: a published public solicitation is the spec §9 "explicit solicitation" evidence class, so these records carry `normalizedStage: bidding_confirmed` — the only public source permitted to do so ("a permit is not a bid" holds everywhere else). Controlled automation (M4.3/M4.4) independently classifies every bidding_confirmed item as an externally-actionable bid state → ALWAYS human review; nothing auto-publishes.
- Adapter: snapshot fetch of the three category pages daily (stable idempotency keys → unchanged-hash dedupe); rows parsed by spec-number pattern; a zero-row parse warns and yields nothing (layout change → red via the zero-usable-records health rule, never fabricated rows). Addenda arrive as row-content changes → fingerprint diff → applyRecordUpdates.
- Fixtures: 3 live pages + metadata.json (2 verbatim spot checks incl. PW26-0068F "2026 Sidewalk Replacement, North End"). 3 parser tests.
- Shadow run 2026-07-17: 3 pages → 17 solicitations, 0 rejected/errors; idempotent rerun fully unchanged-hash; resolution created 17 projects, 0 errors. Health green.
- Enabled: yes — 2026-07-17.

### customer_bid_inbox_solis — ACTIVATED
- 2026-07-17: written customer authorization received (session confirmation from the owner; calibration session scheduled). `enabled: true`, `account_profile_id` bound to solis_interiors at seed. For a private customer source the terms review IS the authorization; robots N/A (local exports only). All prior scaffold constraints hold: never scraped, never credentialed, access-audited (§20), records excluded from the shared graph (private-class guard).
