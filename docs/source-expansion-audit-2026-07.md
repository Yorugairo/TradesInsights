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
