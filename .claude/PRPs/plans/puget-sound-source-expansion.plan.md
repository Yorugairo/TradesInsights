# Plan: Puget Sound Source Expansion (Wave 3 Phase 1 — full clean-source inclusion)

## Summary
Add every CLEAN, cloud-safe permit source the 2026-07-22 discovery sweep verified across the Puget Sound + WA (11 sources), densifying the region where WA construction $ and our early accounts concentrate. Most of the work is **config + real fixtures per city on reusable adapter classes** — two we already own (ArcGIS, Socrata) plus two new classes (OpenDataSoft, Excel-report). Blocked-but-valuable sources (Kent) ship as operator-local adapters via the authorized genuine-browser capture lane. §12.3 frozen; more records, zero scoring changes.

## User Story
As **Solis (and future trade accounts)**, I want **the register to see permits across Bellevue, Renton, Everett, Snohomish, Kitsap, Auburn, Burien, Vancouver, Spokane, Clark — not just the current counties**, so that **more real bid opportunities (especially King-suburb commercial, which routes to Solis today) surface, and the market/Pulse/Activity-Score surfaces get denser.**

## Problem → Solution
Coverage today = Thurston/Pierce/Lewis/King-core/Seattle/Tacoma/statewide-SEPA. The discovery sweep (`docs/source-expansion-audit-2026-07.md`, Puget Sound section) verified 11 CLEAN per-permit sources going unused → build them, reusing adapter classes, so each city is ~a config + fixtures, not a bespoke integration.

## Metadata
- **Complexity**: XL (11 sources, 4 adapter classes, real fixtures each; realistically staged batches)
- **Repo**: Insights `TradesInsights` (branch `claude/tmux-install-320aiz`) — registry side untouched (market/Pulse pages already read whatever the corpus produces)
- **Migrations**: none (adapters write via the existing source-record pipeline; drizzle idx stays 31-next)
- **Estimated files**: ~30 (4 adapter/config modules + ~11 city configs + ~11 fixtures dirs + tests + sources.yaml + registry + operator-local wiring + docs)

## Constraints carried (governance)
Every source runs the **9-step activation** (source-adapter skill): verify publisher LIVE → record access in `config/sources.yaml` → robots/ToS → **capture real fixtures** → mandatory/optional fields → parser + failure fixtures → manual row/count comparison recorded in fixture metadata → shadow mode → enable only after health tests pass. Unknown = null, never 0 (Pierce `positive()` precedent). Person-vs-business gate + RCW-individuals caveat recorded per source. **Never bypass a bot control** — a blocked source becomes an operator-local genuine-browser capture (Olympia/Tumwater precedent), never a driven bot. Adapters emit source records + evidence ONLY (never customer opportunities). §12.3 frozen — prove `eval:run` byte-identical at close-out.

---

## UX Design
N/A — internal data-ingestion change. Downstream surfaces (opportunity list, market pages, Pulse, GC Radar, Activity Score) render the new records automatically; no UI work.

---

## Mandatory Reading
| Priority | File | Why |
|---|---|---|
| P0 | `packages/adapters/src/pierce-permits-arcgis.ts` (all, 299 lines) | THE ArcGIS template: discover(count→paged query), FeatureSchema (zod, epoch-ms dates via `epochToIso`), `stageFor(status)`, `positive()` (0⇒null), evidence[] shape, WGS84 geometry, quantized-window idempotency |
| P0 | `packages/adapters/src/seattle-socrata.ts` (all, 358 lines) | THE config-driven family precedent: `SeattleSocrataConfig` + `SeattleSocrataAdapter(cfg)`; high-water checkpoint w/ overlap; `checkInvariants` using `checkNumericRange`/`checkDateWindow`. Generalize this shape for ArcGIS + reuse for new Socrata cities |
| P0 | `packages/adapters/src/index.ts:14-80` | Registry: `REGISTRY: Record<string, () => SourceAdapter>`; config-driven cities register as `key: () => new Adapter(CONFIG)` (see `seattle_building_permits`). Every new source key adds one line + an export |
| P0 | `config/sources.yaml:179-210` (pierce_permits_arcgis entry) | The per-source YAML shape: key/name/authority/priority/landing_url/access_url/format/access_class/cadence/county/permitting_jurisdiction/enabled/terms_reviewed_at/robots_reviewed_at/required_fields/mitigates/notes |
| P0 | `packages/documents/src/xlsx.ts` — `readXlsx(data: Buffer): Promise<XlsxSheet[]>` (+ `XlsxCell`/`XlsxSheet`) | The Excel-report adapter (Snohomish) parses workbook buffers with this |
| P1 | `packages/adapters/src/lewis-issued-permits.ts` + `.test.ts` | A report-download (non-JSON) adapter with fixtures + D1 `reconcileCount`/`reconcileSum` invariants — the shape the Snohomish Excel + SeaTac CSV adapters follow |
| P1 | `packages/adapters/src/pierce-permits-arcgis.test.ts` | Adapter test pattern: fixture load, parse assertions, stage mapping, idempotent-rerun, invariant checks |
| P1 | `apps/worker/src/schedules.ts` (`operatorLocalSources`) + `apps/worker/src/cli/source-run-operator-local.ts` | The operator-local lane: `enabled:true, cadence:on_demand` sources never scheduled in the datacenter; run via `pnpm source:run:operator-local`. Kent rides this |
| P1 | `packages/adapters/src/olympia-smartgov-reports.ts` | The precedent operator-local adapter (parses genuine-browser captures under `$OTN_CAPTURE_DIR`) — Kent's model |
| P1 | `docs/source-expansion-audit-2026-07.md` (Puget Sound section) | Every verified endpoint URL + field list + class + the TRAP FeatureServer to avoid |
| P2 | `packages/source-sdk` invariants (`reconcileCount`, `reconcileSum`, `checkNumericRange`, `checkDateWindow`, `checkPattern`) | D1 self-reconciliation per adapter |
| P2 | `docs/runbooks/registry-seam-golive.md` Part A | Where Kent's capture steps get documented |

## External Documentation
| Topic | Source | Key Takeaway |
|---|---|---|
| ArcGIS REST query | each city's verified layer URL (audit doc) | `/query?where=…&outFields=*&returnGeometry=true&outSR=4326&resultOffset=…&resultRecordCount=…&f=json`; `returnCountOnly=true` for paging. Field names DIFFER per city — inspect `?f=json` live before coding |
| Socrata SODA | `data.auburnwa.gov/resource/fted-8bve`, `data.everettwa.gov/resource/3w3u-656c` | SoQL `$where/$order/$limit/$offset/$select=count(*)`; each host = different domain (generalize `base()`) |
| OpenDataSoft Explore v2 | `vancouver.opendatasoft.com/api/explore/v2.1/catalog/datasets/issued-building-permits/records` | `?where=…&order_by=…&limit=…&offset=…`; `select=count(*)` variant for total; fields `projectvalue/buildingcontractor/issuedate/address/geo_point_2d` |

---

## Patterns to Mirror

### ARCGIS_DISCOVER — pierce-permits-arcgis.ts:143-166
```ts
const countUrl = `${LAYER}/query?where=${encodeURIComponent(where)}&returnCountOnly=true&f=json`;
const count = Number(JSON.parse((await httpGet(countUrl, ctx)).toString("utf8"))?.count ?? NaN);
const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
// one DiscoveredArtifact per page: canonicalUrl with outFields=*&outSR=4326&resultOffset=i*PAGE_SIZE
```

### CONFIG_DRIVEN_FAMILY — seattle-socrata.ts:54-115
```ts
export interface SeattleSocrataConfig { key; datasetId; recordType; issuedDateField; stageFor(...) }
export const SEATTLE_BUILDING_CONFIG: SeattleSocrataConfig = { ... };
export class SeattleSocrataAdapter implements SourceAdapter {
  constructor(cfg) { this.cfg = cfg; this.key = cfg.key; }
}
// registry: seattle_building_permits: () => new SeattleSocrataAdapter(SEATTLE_BUILDING_CONFIG)
```

### UNKNOWN_IS_NULL — pierce-permits-arcgis.ts:202-203
```ts
const positive = (n) => (n !== null && n > 0 ? n : null);
const valuation = positive(a.buildingValuation) ?? positive(a.projectValue); // 0 ⇒ unknown, never $0
```

### EVIDENCE_ROWS — pierce-permits-arcgis.ts:251-293 / seattle-socrata.ts:260-311
Every emitted fact carries an `evidence[]` entry `{ factPath, text, pageOrSection }`; conditional spreads add rows only when the field is present.

### CHECKPOINT_HIGHWATER — seattle-socrata.ts:121-128, 316-318
```ts
const highWater = String(ctx.checkpoint?.["appliedDateHighWater"] ?? "");
// … window = highWater - OVERLAP_DAYS … ; ctx.setCheckpoint({ appliedDateHighWater: this.maxApplied });
```

### D1_INVARIANTS — seattle-socrata.ts:330-357 (JSON) / lewis-issued-permits.ts (report totals)
`checkNumericRange`(valuation/units bounds), `checkDateWindow`(2000..2100); report adapters add `reconcileCount`/`reconcileSum` against the source's own printed totals.

### OPERATOR_LOCAL — olympia-smartgov-reports.ts + schedules.ts operatorLocalSources
`enabled:true, cadence:on_demand`; `discover()` reads staged genuine-browser captures under `$OTN_CAPTURE_DIR`; never scheduled by `schedulableSources()`.

### TEST_STRUCTURE — pierce-permits-arcgis.test.ts
Load `fixtures/<key>/…` → `new Adapter().parse(rawArtifact, ctx)` → assert record fields/stage/geometry; assert idempotent rerun (same bytes ⇒ same records); assert `checkInvariants` empty on golden + non-empty on a corrupted fixture.

---

## Files to Change

**New adapter classes**
| File | Action | Why |
|---|---|---|
| `packages/adapters/src/arcgis-permits.ts` | CREATE | Generic config-driven ArcGIS adapter: `ArcgisPermitsConfig` (layer URL, field-name map, date field + kind `epoch`\|`iso`\|`string`, window field, `stageFor`, jurisdiction/county) + `ArcgisPermitsAdapter(cfg)`. Mirrors CONFIG_DRIVEN_FAMILY; reuses ARCGIS_DISCOVER. Existing pierce/tacoma/puyallup left AS-IS |
| `packages/adapters/src/arcgis-permits.test.ts` | CREATE | Parse/stage/geometry/idempotent/invariant tests per city config over real fixtures |
| `packages/adapters/src/opendatasoft-permits.ts` (+ test) | CREATE | Vancouver: OpenDataSoft Explore v2 records API; config-driven for future ODS cities |
| `packages/adapters/src/snohomish-permit-reports.ts` (+ test) | CREATE | Excel-report adapter: discover the monthly `Archive.aspx?AMID/ADID` files, `readXlsx` parse, `reconcileCount` vs row expectations, per-permit rows (33 cols) |
| `packages/adapters/src/kent-permit-log.ts` (+ test) | CREATE | Operator-local: parse genuine-browser-captured Kent PDF issued-logs (PDF→text via @otn/documents); `on_demand` |

**Per-city configs (exports in the adapter modules) + fixtures**
| File | Action | Why |
|---|---|---|
| `packages/adapters/src/arcgis-permits.ts` — CONFIG exports | CREATE | `BELLEVUE`, `RENTON`, `KITSAP`, `BURIEN`, `SPOKANE_CITY`, `CLARK_COUNTY` configs (field maps from live `?f=json` inspection at impl) |
| `packages/adapters/src/seattle-socrata.ts` | UPDATE | Add `host` to config (default `data.seattle.gov`); export `AUBURN_CONFIG` (`data.auburnwa.gov`,`fted-8bve`), `EVERETT_CONFIG` (`data.everettwa.gov`,`3w3u-656c`) — Everett gated on the confirming fetch |
| `fixtures/<each key>/…` | CREATE | Real captured page/artifact + golden normalized output + a corrupted/failure fixture + `metadata.json` (manual row/count comparison) |

**Wiring**
| File | Action | Why |
|---|---|---|
| `packages/adapters/src/index.ts` | UPDATE | Import configs; add REGISTRY entries + exports for each new key |
| `config/sources.yaml` | UPDATE | One entry per new source (mirror pierce_permits_arcgis shape: access_url/format/access_class/cadence/county/enabled/terms_reviewed_at/required_fields/notes). Kent = `cadence: on_demand` |
| `apps/worker/src/schedules.ts` | UPDATE | Add Kent (+ any blocked source) to `operatorLocalSources()` |
| `docs/runbooks/registry-seam-golive.md` | UPDATE | Part A: Kent capture steps (what to save, filenames, `$OTN_CAPTURE_DIR`) |
| `docs/source-expansion-audit-2026-07.md` | UPDATE | Mark each built source ENABLED with its live-verified access notes |
| `docs/STATUS.md` | UPDATE | close-out |

## NOT Building
- Refactoring pierce/tacoma/puyallup into the generic ArcGIS adapter (they work + have city quirks; leave them).
- The TRAP aggregate FeatureServer (`services6.arcgis.com/ONZht79c8QWuX759/…/Building_Permits`) — never.
- Any COMPLEX/SmartGov/eTRAKiT/portal city beyond Kent (Federal Way, Redmond, Marysville, Lynnwood, Lakewood, Maple Valley, etc.) — backlog to later operator waves.
- The MyBuildingPermit LOOKUP-ONLY enrichment harness — backlog.
- Bellingham (endpoint unextracted), tiny E-WA Socrata (optics) — backlog.
- Any scoring/§12.3 change; any registry-repo change.

---

## Step-by-Step Tasks

> **Per-city discipline (applies to EVERY city task):** (1) fetch the live endpoint `?f=json`/metadata to CONFIRM the real field names — the audit's field lists are approximate; (2) capture a real fixture (if the datacenter fetch is blocked, STOP and route that city to the operator-local lane — do NOT bypass); (3) write golden + one failure fixture + `metadata.json` with a manual row/count comparison; (4) D1 invariants; (5) idempotent-rerun test; (6) `enabled: true` only after the health/parse tests pass. Ship in batches — each task group is independently valid.

### Task 1 — Generic ArcGIS adapter (`arcgis-permits.ts`)
- **ACTION**: Build `ArcgisPermitsConfig` (key, recordType, layerUrl, county, jurisdiction, `fields` map {externalId, permitType, applicationType, address, valuation, units, applied, issued, status, description, parcel}, `dateKind: 'epoch'|'iso'|'string'`, `windowField`, `stageFor(status)`), and `ArcgisPermitsAdapter implements SourceAdapter` reusing ARCGIS_DISCOVER + UNKNOWN_IS_NULL + EVIDENCE_ROWS + a `checkInvariants` (numeric/date bounds). Geometry from `outSR=4326` point when present.
- **MIRROR**: pierce-permits-arcgis.ts (discover/parse) + seattle-socrata.ts (config-driven shape + checkInvariants). **IMPORTS**: `@otn/source-sdk` (httpGet/httpFetchArtifact/checkNumericRange/checkDateWindow/types), `@otn/domain` NormalizedSourceRecord, zod.
- **GOTCHA**: field names + date encodings differ per city (epoch-ms vs ISO string vs `YYYY-MM-DD`) — the config's `dateKind` selects the parse; never assume Pierce's schema.
- **VALIDATE**: `npx vitest run packages/adapters/src/arcgis-permits.test.ts`; `pnpm -r typecheck`.

### Task 2 — ArcGIS city configs + fixtures (Bellevue → Renton → Kitsap → Burien → Spokane City → Clark)
- **ACTION**: For each, live-inspect the layer fields, write the config, capture a real fixture, write golden+failure+metadata, register in index + sources.yaml. **Bellevue first** (richest: contractor+valuation+all dates+units; the template validation).
- **MIRROR**: Task 1 adapter + CONFIG_DRIVEN_FAMILY registration. **GOTCHA**: Renton host = `gismaps.rentonwa.gov/as03` (not `rp.`); Clark layer 9 in `MapsOnline` (not token-secured `CommDev`); Spokane City has no valuation/contractor/issue-date (map only what exists); Kitsap needs a `/0?f=json` field enum first.
- **VALIDATE**: per city, parse test green + `checkInvariants` empty on golden; `enabled:true` last.

### Task 3 — Socrata host-parameterization + Auburn/Everett
- **ACTION**: Add `host` to `SeattleSocrataConfig` (default `data.seattle.gov`); `base()` uses it. Export `AUBURN_CONFIG` + `EVERETT_CONFIG`; register + sources.yaml + fixtures. **Everett**: FIRST run the confirming fetch `data.everettwa.gov/resource/3w3u-656c.json?$limit=1` — if it 404s/empties, mark Everett UNVERIFIED and skip (do not fabricate a source).
- **MIRROR**: seattle-socrata.ts verbatim (+ host). **GOTCHA**: Auburn has no valuation column, Everett (if live) has ContractorName+JobValue — map each city's real columns; Seattle behavior must stay byte-identical (default host).
- **VALIDATE**: `npx vitest run packages/adapters/src/seattle-socrata.test.ts` (Seattle unchanged) + new Auburn/Everett cases; typecheck.

### Task 4 — OpenDataSoft adapter + Vancouver
- **ACTION**: `opendatasoft-permits.ts` — config-driven (baseUrl, dataset, field map, `stageFor`); discover via `select=count(*)` then paged `records?limit/offset/order_by`; parse ODS record shape (`record.fields` or v2.1 flat). Vancouver config (`projectvalue`,`buildingcontractor`,`issuedate`,`address`,`geo_point_2d`).
- **MIRROR**: CONFIG_DRIVEN_FAMILY + ARCGIS_DISCOVER paging idea. **GOTCHA**: ODS v2.1 returns `results[]` with flat fields + `total_count`; geo is `geo_point_2d {lat,lon}` (emit as [lon,lat]).
- **VALIDATE**: parse test over a real Vancouver fixture; idempotent; invariants; typecheck.

### Task 5 — Excel-report adapter + Snohomish County
- **ACTION**: `snohomish-permit-reports.ts` — discover the monthly index (`Archive.aspx?AMID=N` per family) → each month file (`Archive.aspx?ADID=N`); fetch `.xlsx` bytes; `readXlsx` → map the 33 confirmed columns (Site_Address, Valuation, Permit_Type/Sub_Type, Application_Date, Issue_Date, Applicant_Organization→org, Dwelling_Units); `reconcileCount` invariant (rows parsed vs sheet dimension). 15 streams (6 families × applied+issued).
- **MIRROR**: lewis-issued-permits.ts (report adapter + reconcile invariants) + xlsx.readXlsx. **GOTCHA**: no contractor-license field (Applicant_Organization is the builder signal); `.xlsx` is real Excel (not CSV); families split applied vs issued — set stage per stream.
- **VALIDATE**: parse the captured June-2026 workbook fixture → per-permit rows with address/valuation/dates; reconcile passes; typecheck.

### Task 6 — SeaTac CSV (operator-confirm gated)
- **ACTION**: IF an operator confirms the LAMA CSV column set + public access (the reports are ASP.NET postbacks), build a small CSV-report adapter + config; else record SeaTac as operator-local pending and skip. Low volume — do not block the wave on it.
- **VALIDATE**: gated; skip cleanly if unconfirmed.

### Task 7 — Kent operator-local adapter
- **ACTION**: `kent-permit-log.ts` — parse genuine-browser-captured Kent PDF issued-logs (columns: Permit#, Date Issued, Project/Address, Contractor, Scope, Value) via @otn/documents PDF text; `enabled:true, cadence:on_demand`; add to `operatorLocalSources()`; document capture steps in runbook Part A. Kent = largest S-King, domain WAF-blocks datacenter IPs → residential-IP capture is the ONLY path (authorized).
- **MIRROR**: olympia-smartgov-reports.ts (operator-local capture parse). **GOTCHA**: issued-only (no applied); never schedule in datacenter; parser works on a staged fixture even before live captures (skip-safe).
- **VALIDATE**: parse a captured/sample Kent-log fixture; adapter registered but only runs via `source:run:operator-local`.

### Task 8 — Close-out
- **ACTION**: Backfills for enabled sources → `pnpm maintenance:run` (NEVER concurrent) → resolution/scoring pass; report honest per-source counts (records/projects/opportunities; note **King-suburb records route to Solis immediately**); `eval:run` byte-identical; health all-green (no red new sources); STATUS/memory/audit updated; commit+push per batch.
- **VALIDATE**: full validation block below.

---

## Testing Strategy
### Unit / adapter tests
| Test | Input | Expected | Edge? |
|---|---|---|---|
| ArcGIS parse (each city) | real fixture page | per-permit records, correct stage/geometry/valuation-null-on-0 | yes (0 valuation ⇒ null) |
| ArcGIS malformed feature | corrupted fixture | row pushed with empty record + rawFields, no throw | yes |
| Socrata Auburn/Everett | fixture rows | contractor/dates mapped; Seattle unchanged | yes |
| ODS Vancouver | fixture records | valuation+contractor+issued mapped; geo [lon,lat] | yes |
| Snohomish xlsx | captured workbook | 33-col rows; reconcileCount passes | yes (empty stream) |
| Kent PDF log | captured log | issued rows w/ contractor+value; no applied date | yes |
| idempotent rerun (all) | same bytes twice | identical records | yes |

### Edge Cases Checklist
- [ ] 0/empty valuation ⇒ null (never $0)
- [ ] Missing date fields ⇒ null, stage falls back honestly
- [ ] Blocked datacenter fetch ⇒ route to operator-local, never bypass
- [ ] Everett confirming fetch fails ⇒ skip, don't fabricate
- [ ] Malformed row ⇒ captured in rawFields, no crash
- [ ] Duplicate rerun ⇒ dedupe on unchanged hash

---

## Validation Commands
```bash
cd C:/Users/Snipe/Downloads/TradesInsights
pnpm -r typecheck
npx vitest run packages/adapters/src/arcgis-permits.test.ts packages/adapters/src/opendatasoft-permits.test.ts packages/adapters/src/snohomish-permit-reports.test.ts packages/adapters/src/seattle-socrata.test.ts
npx vitest run                                  # full suite, no regressions
pnpm --filter @otn/worker eval:run              # GATES PASS byte-identical (no scoring touched)
# per source, shadow then enable:
pnpm source:run <key>                            # cloud-safe sources
pnpm source:run:operator-local                   # Kent (after a capture)
pnpm maintenance:run                             # single pass, never concurrent
```

## Acceptance Criteria
- [ ] Generic ArcGIS + OpenDataSoft + Excel adapters built, config-driven, tested
- [ ] Every enabled city: live columns verified, real fixture, golden+failure+metadata, D1 invariants, idempotent — enabled only after green
- [ ] Everett gated on the confirming fetch; blocked cities routed operator-local, never bypassed
- [ ] `eval:run` byte-identical; full suite green; health all-green
- [ ] Honest per-source counts reported; Solis King-suburb growth noted
- [ ] sources.yaml + registry + audit + STATUS updated; trunk pushed per batch

## Risks
| Risk | L | I | Mitigation |
|---|---|---|---|
| Audit field names ≠ live schema | M | M | per-city task step 1 = live `?f=json` inspection before coding |
| A "CLEAN" source blocks the datacenter fetch on first pull | M | M | that's the go/no-go — route to operator-local (authorized), don't bypass; still a deliverable |
| Everett is the catalog-vs-resource conflict | M | L | confirming fetch first; skip if empty |
| Generic ArcGIS config can't express a city's quirk | L | M | config carries `stageFor` fn + `dateKind`; worst case that city gets its own file (pierce precedent) |
| Solis queue jump from King suburbs | M | L | that's the product working; digest caps + review gate bound it; scoring untouched |
| Scope (XL) overruns a single pass | H | M | ship in batches (Task groups 1–2, then 3, 4, 5, 7); each independently valid + committed |

## Notes
- **Batch commits**: ArcGIS six (T1–2) → Socrata (T3) → Vancouver (T4) → Snohomish (T5) → Kent (T7), each its own commit+push+maintenance pass. SeaTac (T6) only if operator-confirmed.
- **The leverage**: after T1, adding an ArcGIS city ≈ a config + fixtures. The expensive part is the per-city fixture capture + live column verification, not code.
- **Cost note**: the discovery that fed this plan was token-expensive; the build itself is mechanical adapter work — run it in a fresh session.
