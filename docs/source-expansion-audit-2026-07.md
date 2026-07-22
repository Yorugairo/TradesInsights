# Source-expansion audit — 2026-07 (Wave 2 F2a: recon ONLY, no adapters)

Verify-first audit (source-adapter skill §1–3) of the next expansion candidates.
Every claim below is from a **live fetch/search on 2026-07-22** or explicitly marked
UNVERIFIED. No fixtures captured, no adapters built, no `config/sources.yaml` changes —
build decisions are gated on F1 (second design-partner account) per the Wave-2 backlog.

Egress-class judgments reference the standing precedents: Akamai/Exago 403s automated
datacenter clients (Olympia), Cloudflare challenges block Pierce main-site, ArcGIS REST
layers have been reliably cloud-safe (Pierce/Tacoma).

---

## 1. Snohomish County (unincorporated) — **strongest candidate**

- **Publisher (verified live):** Snohomish County Planning & Development Services.
- **Landing:** https://snohomishcountywa.gov/1575/PermittingReports (fetched 2026-07-22).
- **Access/format (verified):**
  - **Monthly Issued Permits reports — Excel**, published the 1st of each month, by
    category (Land Use, Residential, Commercial, LDA, Trade, Miscellaneous).
  - **Monthly Detailed Applications reports — Excel**, same cadence/categories (the
    pre-issuance signal).
  - Monthly Building Permit Summary (Excel archive) — new res/comm construction,
    demolitions, remodels >$500K.
  - PowerBI dashboards (timeline data) — display-only, not a data source.
  - Permit search: PDS Online Records (https://snoco.org/pdspublicrecords/) + a
    self-service Permit Portal — lookup-class (enrichment only, never the alert source).
- **Cadence:** monthly (1st of month). Excel ≫ PDF for parser reliability.
- **Robots/ToS note (verified on page):** disclaimer prohibits "lists of individuals …
  for commercial purposes" under state law (RCW 42.56.070(8) class). Our standing
  person-vs-business gate already excludes individuals; carry this citation into the
  activation checklist if built.
- **Egress class (judgment):** county CMS + Excel downloads — likely cloud-safe;
  UNVERIFIED until a real fetch of one workbook (build-time step).
- **Column detail (UNVERIFIED):** whether contractor names/valuations/addresses appear
  per row needs one workbook download at build time.
- **Recommendation:** **P1.** Monthly Excel with an applications (pre-issuance) series is
  the best format/effort ratio of the four. Snohomish is also the largest WA county we
  don't cover.

## 2. Clark County — good, PDF-shaped

- **Publisher (verified live):** Clark County Community Development.
- **Landing:** https://clark.wa.gov/community-development/data-and-reports (fetched 2026-07-22).
- **Access/format (verified):** **weekly "Building permits issued" PDF** (Mondays),
  stable link pattern `/media/document/{ID}` (e.g. 231361 = week of 7/5/26); annual
  valuation/inspection PDF. Per-row contents (addresses/contractors/valuations)
  UNVERIFIED until one PDF is pulled. Permit lookup: LMS portal
  (https://permits.clark.wa.gov) — lookup-class only. County GIS exposes an ArcGIS REST
  tree (gis.clark.wa.gov/arcgisfed2/rest/…, surfaced in search) — worth probing for a
  permits layer at build time; if one exists it beats the PDF.
- **Cadence:** weekly (issued) — best cadence of the four.
- **Egress class (judgment):** wa.gov CMS + PDF media links — likely cloud-safe;
  UNVERIFIED. Discovery page must be scraped for the current week's document ID
  (Lewis-issued-permits-PDF precedent applies directly).
- **Recommendation:** **P2.** Weekly cadence is excellent; PDF parsing cost is the
  known Lewis/Centralia grind. Probe the ArcGIS tree first.

## 3. Spokane (City + County) — split posture

- **City of Spokane (verified via search, landing not yet fetched):**
  https://my.spokanecity.org/opendata/gis/permits/ — permit activity map, up to 3 years
  of building/planning/engineering permits, **updated nightly**, filterable. Open-data
  GIS strongly suggests an ArcGIS/GeoJSON endpoint behind it (the cloud-safe
  Pierce/Tacoma class). Accela Citizen Access (aca.spokanepermits.org) exists for
  lookups. **UNVERIFIED:** the actual service endpoint + fields — one dev-tools session
  at build time.
- **Spokane County:** SmartGov portal (co-spokane-wa.smartgovcommunity.com) — the SAME
  platform class as Olympia SmartGov, where Akamai 403s datacenter clients; assume
  operator-local risk until proven otherwise. County "Permit Statistics" page
  (spokanecounty.gov/398) publishes weekly/monthly statistics — aggregate-level
  (UNVERIFIED whether per-permit rows exist).
- **Recommendation:** **P3 city / P4 county.** City open-data nightly GIS is likely the
  cheapest activation of the whole audit IF the endpoint pans out; county SmartGov is an
  operator-local candidate at best.

## 4. WA state procurement (WEBS / DES) — different animal

- **Publisher (verified via search):** Dept. of Enterprise Services. WEBS
  (Washington Electronic Business Solution) is the statewide solicitation system;
  agencies must post goods/services + public-works solicitations there.
- **Access reality:** WEBS is **vendor-registration-gated** (login). DES's public pages
  (des.wa.gov/sell/bid-opportunities, …/public-works/construction) list some current
  solicitations publicly. UNVERIFIED: how much of the public-works pipeline is visible
  without login, and whether listings carry scope/trade detail.
- **Governance:** registration is legitimate (we'd register as ourselves — it's a
  vendor system designed for exactly this), but that makes it an
  **owner-decision + account-bound** source, not an anonymous public fetch. Never
  scrape through a login without that decision.
- **Fit note:** procurement solicitations are the ONE source class where
  `bidding_confirmed` is a stated fact (spec §9) — the only records that can ever set
  it. That's a scoring-adjacent property; activation would need the §12.3-frozen
  discipline check.
- **Recommendation:** **owner-gated.** High value (explicit bid windows), but blocked on
  the registration decision; recon of the public DES listings is the free first step.

---

## Summary table

| Source | Format | Cadence | Egress judgment | Priority | Gate |
|---|---|---|---|---|---|
| Snohomish PDS monthly reports | **Excel** | monthly | likely cloud-safe (unverified) | **P1** | F1 signal + workbook column check |
| Clark weekly issued | PDF (`/media/document/{ID}`) | **weekly** | likely cloud-safe (unverified) | P2 | F1 signal; probe ArcGIS tree first |
| Spokane City open-data GIS | GIS (endpoint TBD) | nightly | likely cloud-safe if ArcGIS | P3 | endpoint discovery |
| Spokane County SmartGov | portal | — | operator-local risk (SmartGov/Akamai class) | P4 | operator-local proof |
| WEBS / DES procurement | portal (login) + public lists | continuous | registration-gated | owner-gated | owner registration decision |

**No build starts from this document.** Each activation runs the full 9-step
source-adapter checklist (fixtures, invariants, shadow mode) when its gate clears.

---

# Puget Sound densification sweep — 2026-07-22 (6 parallel live-verified research passes)

Goal (owner directive): densify the Puget Sound region (where WA construction $ and
our early accounts concentrate); do NOT cap at 3 — include every CLEAN source, backlog
the complex ones. Operator-browser/residential-IP fallback is AUTHORIZED for blocked
Tier-1/2 sources (the Olympia/Tumwater Part-A precedent). Every endpoint below was
fetched live this session unless marked UNVERIFIED. No endpoint invented.

## The adapter-class insight (why "full inclusion" is tractable)
The CLEAN set collapses to **4 reusable adapter shapes — 2 already built**:
- **ArcGIS REST** (HAVE — `pierce-permits-arcgis`, `tacoma`) → 6 new: Bellevue, Renton, Kitsap, Burien, Spokane City, Clark County.
- **Socrata SODA** (HAVE — `seattle`) → Auburn, Everett (confirm), + tiny E-WA.
- **OpenDataSoft** (NEW class, one build) → Vancouver (richest single source).
- **Downloadable Excel report** (via `@otn/documents`) → Snohomish County (per-permit CONFIRMED by parse).
So most of "full inclusion" is **config + field-map per city on existing classes**, plus two new class builds.

## ⚠️ TRAP — do NOT build against this
`services6.arcgis.com/ONZht79c8QWuX759/…/Building_Permits/FeatureServer/0` surfaces in
many city searches — it is a **regional AGGREGATE quarterly-statistics** table
(Year/Quarter/Geography/…/TotalPermits_Value), not per-permit rows. Ignore for every city.

## CLEAN — cloud-safe, build-now (grouped by adapter class)

### ArcGIS REST class (reuse the pierce/tacoma adapter)
| City/County | Endpoint (verified live) | Fields | Cadence | Notes |
|---|---|---|---|---|
| **Bellevue** ⭐#1 | `services1.arcgis.com/EYzEZbDhXZjURPbP/arcgis/rest/services/Bellevue_Permits/FeatureServer/0` | **contractor + valuation + applied/issued/finaled + applicant + owner + units + address + geom** | daily ~6AM | **DOUBLE-verified** (2 independent passes); 440k rows 1998–present; richest ArcGIS. The template build. |
| **Renton** | `gismaps.rentonwa.gov/as03/rest/services/Operational/PermitsAndConstruction/MapServer` (leaf layers 7–53) | valuation + applied + issued + address + sqft/units; **no contractor** | rolling; SLA unverified | Use the `as03` host (`rp.rentonwa.gov` socket-hung). Backend Tyler EnerGov. |
| **Kitsap County** | `services6.arcgis.com/qt3UCV9x5kB4CwRA/arcgis/rest/services/Permits/FeatureServer/0` | 17 fields (permit#, applicant, address, status, dates); valuation presence UNVERIFIED | daily | 154k rows; enumerate fields with `/0?f=json` first. |
| **Burien** | `gis.burienwa.gov/server/rest/services/cwpll/cwpll_caseactivity/MapServer/0` | CaseType, status, **AppliedDate + IssuedDate**, address; **no valuation/contractor** | hourly, 18-mo window | GeoJSON/JSON/PBF; maxRecord 4000. Backend CityView. |
| **Spokane City** | `services.spokanegis.org/arcgis/rest/services/Permit/Permit_WM_Dynamic2/MapServer/0` | address, type, **OpenDate (application)**, parcel, desc, neighborhood; **no valuation/contractor/issue-date** | **nightly** (desc: "extracted nightly from Accela") | Do NOT build vs `aca.spokanepermits.org`. |
| **Clark County** (all jurisdictions incl. Vancouver) | `gis.clark.wa.gov/arcgisfed2/rest/services/MapsOnline/PermitSitePlansTemp/MapServer/9` | address, CaseType, **issued** date, WorkType, parcel; **no valuation/contractor** | weekly (Clark+Vancouver); quarterly (others) | `CommDev` folder is token-secured (499); layer 9 in `MapsOnline` is open. For Vancouver prefer its own OpenDataSoft feed (below). |

### Socrata SODA class (reuse the seattle adapter)
| City | Endpoint | Fields | Notes |
|---|---|---|---|
| **Auburn** | `data.auburnwa.gov/resource/fted-8bve` (SODA JSON/CSV) | **contractor** + owner/applicant + type/subtype + applied/issued/finaled + address; **no valuation** | 44k rows back to ~2012; ArcGIS TrakIT `gis.auburnwa.gov/mapping/rest/services/TrakIT/TrakITJoinedToGIS/MapServer` as geospatial secondary. |
| **Everett** | `data.everettwa.gov/resource/3w3u-656c` ("Trakit Permits") | pass A: **contractor + JobValue + applied/approved/issued/expired + address + geo, 190,500 rows** (SODA count + sample confirmed). pass B: catalog-enum found **no** permit dataset → **CONFLICTED** | **RESOLVE with one fetch of `/resource/3w3u-656c.json?$limit=1` before building.** If live → this is the single best Socrata source in the region. |
| *(optics only)* Asotin `data.wa.gov/…/ez9k-2c5k`, Clarkston `uxv9-c2g9` | Socrata | per-permit, tiny E-WA volume | Reuses seattle adapter verbatim; low ROI — statewide-coverage optics only. Colfax `sefr-g784` is STALE (2016) — dead. |

### OpenDataSoft class (NEW adapter — one build, then reusable)
| City | Endpoint | Fields | Notes |
|---|---|---|---|
| **Vancouver** ⭐ | `vancouver.opendatasoft.com/api/explore/v2.1/catalog/datasets/issued-building-permits/records` | **projectvalue + buildingcontractor + issuedate + created date + typeofwork + address + applicant + geo** | 51,445 records since 2017; daily (current year). **Richest single source in the whole sweep.** Prefer over Clark layer 9 for Vancouver. |

### Downloadable Excel-report class (via @otn/documents)
| Source | Endpoint | Fields | Notes |
|---|---|---|---|
| **Snohomish County** (unincorporated) ⭐ anchor | `snohomishcountywa.gov/1575/PermittingReports` → index `wa-snohomishcounty2.civicplus.com/Archive.aspx?AMID=N`, month files `Archive.aspx?ADID=N` | **CONFIRMED per-permit by download+parse**: 33 cols incl. address, valuation, permit type/subtype, **applied + issued dates**, dwelling units/SF, Applicant_Organization (builder). **No license-number field** (Applicant_Organization is the contractor signal). | true `.xlsx`; monthly (1st); **6 families × Applications + Issued = 15 streams**. |

### CSV-report class (confirm columns in an operator browser first)
| City | Endpoint | Notes |
|---|---|---|
| **SeaTac** | `lama.seatacwa.gov/Dashboard.aspx` (LAMA/iGovServices open-data reports; CSV, ≤200 rows/export) | Weekly/Monthly/Annual issued + valuation reports; APPLIED+ISSUED. **Exact columns + whether prebuilt reports need an account = UNVERIFIED** (ASP.NET postbacks); low volume (~31k pop). |

### Partial-CLEAN (land-use / development-project feeds — velocity supplements, NOT building-permit substitutes)
Tukwila `services7.arcgis.com/ttErFEyWkCDr9b67/…/L12_25/FeatureServer/53` (dev projects, parcel-only, no address/valuation/contractor); Covington `maps.covingtonwa.gov/arcgis/rest/services/development_web_map_test/MapServer/0` (major projects only); Des Moines `maps.desmoineswa.gov/dmgis/…/Planning/DevelopmentActivity/MapServer/0` (too thin — ProjectID/Status only). Useful for GC-radar/velocity signal, not per-permit alerts.

## COMPLEX — operator-browser / residential-IP capture lane (AUTHORIZED fallback; backlog by value)
| Target | Vendor / mechanism | Value | Fields available |
|---|---|---|---|
| **Kent** ⭐ (largest S-King, ~130k) | PDF issued-log; **entire kentwa.gov domain WAF-blocks datacenter IPs** | HIGH | address, valuation, contractor, scope, **issue-date** (issued-only) |
| **Federal Way** (~101k) | AMANDA portal + MyBuildingPermit capped HTML search; ArcGIS token-secured (499) | HIGH | address, type, dates, contractor via search |
| Redmond | Tyler EnerGov Civic Access | HIGH (MS campus) | portal record fields |
| Marysville | eTRAKiT | Med | per-permit lookup |
| Lynnwood, Mukilteo | SmartGov | Med | per-permit lookup |
| Monroe, Arlington, Lake Stevens | account portals (CentralSquare/etc.) | Med | per-permit lookup |
| Issaquah | monthly **scanned/image** PDFs (OCR grind) + MBP | Med | per-permit (OCR) |
| Woodinville | Accela ACA | Low | date-range search |
| Tukwila, Des Moines, Covington, Maple Valley | ASPGov / PermitTrax×2 / OpenGov | Low (small) | portal-only |
| Lakewood, Gig Harbor, Fife, Bonney Lake (Pierce) | eTRAKiT / SmartGov / own portal | Med | Lakewood NO-BUILD **unchanged** |
| Spokane County, Bremerton | SmartGov (aggregate public pages only) | Low | operator for per-permit |
| **Bellingham** (Whatcom) | eTRAKiT portal + an ArcGIS **Development Dashboard** (weekly, 6-mo applied/issued/finaled) | Med | **PROBABLE-CLEAN — resolve the dashboard's backing FeatureServer REST URL first** (inspect its network calls); if found, promotes to CLEAN ArcGIS class |

## LOOKUP-ONLY (enrichment only — NEVER a sole alert source)
**MyBuildingPermit.com** consortium (`permitsearch.mybuildingpermit.com`) — per-permit status lookup, **no bulk export/feed**: Kirkland, Bothell, Sammamish, Mercer Island, Kenmore, Edmonds, Mill Creek, City of Snohomish, Newcastle, Snoqualmie (+ Bellevue/Auburn/Federal Way, which ALSO publish their own open data). One operator-browser harness could enrich several of these cross-jurisdiction, but it discovers nothing on its own.

## Recommended build order (full clean inclusion)
1. **Bellevue** (ArcGIS, richest, double-verified) — the template; proves the config-driven ArcGIS expansion.
2. **Renton, Kitsap, Burien, Spokane City, Clark** (ArcGIS, config each).
3. **Auburn** (Socrata) + **Everett** (Socrata, after the 1 confirming fetch).
4. **Vancouver** (new OpenDataSoft adapter class).
5. **Snohomish County** (Excel-report adapter; monthly archive discovery + xlsx parse).
6. **SeaTac** (after operator confirms the CSV column set).
7. **Operator lane (authorized):** Kent first (largest, WAF-blocked PDF log), then Federal Way / Redmond — genuine-browser capture, `operatorLocalSources()` + `source:run:operator-local`, runbook Part A steps.
Backlog: the rest of the SmartGov/eTRAKiT/portal cities, Bellingham endpoint extraction, tiny E-WA Socrata (optics).

## Wave 3 Phase 1 — live onboarding findings (2026-07-22)

Implementation began (`.claude/PRPs/plans/puget-sound-source-expansion.plan.md`). **Shipped:** generic `ArcgisPermitsAdapter` (config-driven, `611834f`), `CountySchema` extended with Snohomish/Kitsap/Clark/Spokane (`b547102`, additive, eval byte-identical), and **Bellevue** onboarded end-to-end (`205a5be`, `enabled:true`). Then per-city live `?f=json` verification corrected several audit assumptions — recorded here so the next batch starts from truth:

| City | Live finding (2026-07-22) | Disposition |
|---|---|---|
| **Bellevue** ✅ | Single clean FeatureServer (org EYzEZbDhXZjURPbP). CONTRACTOR on EVERY row, VALUATION (35,468 all-time), units, dates, WGS84 point. | **SHIPPED** on generic ArcGIS adapter (BELLEVUE_CONFIG). |
| **Renton** ⚠️ COMPLEX | `gismaps.rentonwa.gov/as03 …/PermitsAndConstruction/MapServer` is **~50 thematic sublayers** (Commercial/Multifamily/SFR × New Construction/Additions/Alterations, land-use, fire, utility). NOT a single queryable permit layer — needs a **multi-layer union** the single-layer generic adapter can't express. | **BACKLOG** — union adapter or per-leaf config set. Alterations>Commercial (layer 15) is the highest-value leaf for Solis TI. |
| **Kitsap** ⚠️ THIN | `services6.arcgis.com/qt3UCV9x5kB4CwRA/…/Permits/0` — **non-spatial table** (no geometry), **no valuation/units**, address often "NO ADDRESS FOUND", ~10 permits/week, and **APPLICANT is individual property-owners** (person-gate: must NOT emit as orgs). | **BACKLOG** as thin — ship party-less permit records later if wanted; low ROI. |
| **Auburn** 🔶 needs generic Socrata | `data.auburnwa.gov/resource/fted-8bve` is clean (permit/applied/issued/type/status/parcel/description/owner/applicant/contractor/address) BUT columns are **entirely different from Seattle's** — the `SeattleSocrataAdapter` has a hardcoded Seattle `SocrataRowSchema`, so a **host param is not enough**; needs a generic config-driven Socrata adapter. `contractor` often the placeholder "CONTRACTOR UNKNOWN" (⇒ null); owner/applicant are individuals (person-gate). | **BUILD-NEXT** — requires new `SocrataPermitsAdapter` class first. |

**Scope correction for the remainder:** the plan assumed most cities were "config + fixtures" on two owned classes. Live verification shows the remaining CLEAN cities each need a **new adapter class** first: generic Socrata (Auburn, Everett), OpenDataSoft (Vancouver), Excel-report (Snohomish), PDF operator-local (Kent). Only additional *single-layer* ArcGIS cities (Burien, Spokane City, Clark County — verify each is single-layer, not Renton-style) are true drop-in configs. Recommended next-session order: (1) generic Socrata class → Auburn + Everett; (2) verify+add single-layer ArcGIS Burien/Spokane City/Clark; (3) OpenDataSoft class → Vancouver; (4) Excel class → Snohomish; (5) Kent operator-local PDF.
