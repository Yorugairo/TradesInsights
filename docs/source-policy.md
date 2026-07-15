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

## Known migration canaries (watch during M1)

- **Thurston County**: new permitting system announced for September 2026 — verify the "what's new" page before and during M1.9.
- **Lewis County**: `lewis_source_canary` watches the Community Development landing page for link changes; SmartGov hostname must be discovered from the official page, never guessed.
- **Seattle**: `seattle_source_canary` watches the Research-a-Project page; inspect live Socrata columns before coding M1.7.
