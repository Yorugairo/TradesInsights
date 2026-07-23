import { z } from "zod";
import {
  checkDateWindow,
  checkNumericRange,
  httpFetchArtifact,
  httpGet,
  type DiscoveredArtifact,
  type InvariantViolation,
  type ParsedSourceRecord,
  type RawArtifact,
  type RunContext,
  type SourceAdapter,
} from "@otn/source-sdk";
import type { County } from "@otn/domain";
import type { NormalizedSourceRecord } from "@otn/domain";

/**
 * Generic, config-driven ArcGIS Feature Service permit adapter.
 *
 * The pilot region's ArcGIS permit feeds (Pierce, Tacoma, Puyallup) are each a
 * bespoke file because they predate this generalization and carry city quirks
 * (planning/pre-app splits, PALS cluster keys). Every OTHER ArcGIS permit layer
 * we onboard — Bellevue, Renton, Auburn, Burien, and the rest of the Puget
 * Sound sweep — is the SAME shape: a count query, paged `outFields=*` feature
 * pulls in WGS84, and per-feature attribute mapping. This adapter captures that
 * shape once; a new city becomes an `ArcgisPermitsConfig` + real fixtures, not
 * a new integration.
 *
 * Mirrors `pierce-permits-arcgis.ts` (discover: count→paged query; quantized
 * window for idempotency; epoch/ISO date decode) and `seattle-socrata.ts` (the
 * config-driven family shape + `checkInvariants`). Field names and date
 * encodings DIFFER per city — the config's `fields` map + `dateKind` select the
 * parse; nothing is assumed from another city's schema. Unknown is null, never
 * zero (Pierce `positive()` precedent). Adapters emit source records + evidence
 * only (spec §5) — never customer opportunities.
 */

/** How a city's date columns are encoded, selecting the decode. */
export type ArcgisDateKind = "epoch" | "iso" | "string";

/** Source attribute field-name map for one city. Every entry is a live-verified
 * column name from that layer's `?f=json` metadata (audit field lists are
 * approximate — confirm before shipping a city). Omit a field the city lacks;
 * the adapter maps only what exists (unknown ⇒ null). */
export interface ArcgisFieldMap {
  /** Permit-number column → `externalId` (required; the row's stable id). */
  externalId: string;
  permitType?: string;
  applicationType?: string;
  status?: string;
  description?: string;
  projectName?: string;
  /** One or more address columns, joined in order (e.g. line1 + line2). */
  address?: string | string[];
  /** Valuation column(s), tried in order — first positive wins (0 ⇒ unknown). */
  valuation?: string | string[];
  units?: string;
  applied?: string;
  issued?: string;
  parcel?: string;
  /** Party name column → an `organizations[]` entry (business identity as-is). */
  applicant?: string;
  /** Geometry fallback columns when the feature carries no `geometry` object. */
  lat?: string;
  lng?: string;
  /** Canonical per-record link column → `sourceUrl` (else the landing page). */
  sourceUrl?: string;
  /** A stable per-record / cluster id → externalRef evidence + rawFields ONLY,
   * never a party key (Pierce projectId / Tacoma GlobalID precedent). */
  externalRef?: string;
}

export interface ArcgisPermitsConfig {
  key: string;
  /** ArcGIS FeatureServer layer URL (…/FeatureServer/N), no trailing `/query`. */
  layerUrl: string;
  /** Public landing/hub page for the layer (must be a URL — sourceUrl fallback). */
  landingUrl: string;
  /** Layer `maxRecordCount` (verified live). */
  pageSize: number;
  /** Trailing discovery window in days (default 120). */
  windowDays?: number;
  county: County;
  /** `permittingJurisdiction` (e.g. "City of Bellevue"). */
  jurisdiction: string;
  city: string | null;
  /** Emitted `recordType` (default "building_permit"). */
  recordType?: string;
  parserVersion?: string;
  fields: ArcgisFieldMap;
  /** Role for the `applicant` org entry (default "applicant"). */
  applicantRole?: string;
  dateKind: ArcgisDateKind;
  /** ArcGIS Date column the discovery window filters on (usually the applied field). */
  windowField: string;
  /** Optional second Date column OR-ed into the window (usually the issued field). */
  windowFieldSecondary?: string;
  /** Deterministic stable order for paging (default the externalId field). */
  orderByField?: string;
  /** Maps the source status string → §9 stage. Unmatched ⇒ "unknown", never guessed. */
  stageFor(status: string | null): NormalizedSourceRecord["normalizedStage"];
  /** D1 invariant ceiling for valuation (default 5e9). */
  valuationMax?: number;
  /** D1 invariant ceiling for units (default 10000). */
  unitsMax?: number;
  /** Human label for the externalRef evidence row (default "record id"). */
  externalRefLabel?: string;
}

const DEFAULT_WINDOW_DAYS = 120;

const FeatureShape = z.object({
  attributes: z.record(z.unknown()),
  geometry: z.object({ x: z.number(), y: z.number() }).nullish(),
});
const ResponseSchema = z.object({ features: z.array(z.unknown()) });

function epochToIso(ms: number | null | undefined): string | null {
  return ms ? new Date(ms).toISOString() : null;
}

/** ArcGIS SQL timestamp literal for a UTC date. */
function tsLiteral(d: Date): string {
  return `TIMESTAMP '${d.toISOString().slice(0, 19).replace("T", " ")}'`;
}

function strAt(a: Record<string, unknown>, key: string | undefined): string | null {
  if (!key) return null;
  const v = a[key];
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function numAt(a: Record<string, unknown>, key: string | undefined): number | null {
  if (!key) return null;
  const v = a[key];
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

/** Positive-or-null: 0/negative valuation is "not stated" (unknown), never $0. */
function positive(n: number | null): number | null {
  return n !== null && n > 0 ? n : null;
}

function intOrNull(n: number | null): number | null {
  return n !== null && Number.isInteger(n) && n > 0 ? n : null;
}

/** Decode a date column per the city's `dateKind` into an ISO string, or null. */
function dateIso(
  a: Record<string, unknown>,
  key: string | undefined,
  kind: ArcgisDateKind,
): string | null {
  if (!key) return null;
  if (kind === "epoch") return epochToIso(numAt(a, key));
  const s = strAt(a, key);
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function joinFields(a: Record<string, unknown>, keys: string | string[] | undefined): string | null {
  if (!keys) return null;
  const list = Array.isArray(keys) ? keys : [keys];
  const parts = list.map((k) => strAt(a, k)).filter((v): v is string => Boolean(v));
  return parts.length ? parts.join(", ") : null;
}

function firstPositive(a: Record<string, unknown>, keys: string | string[] | undefined): number | null {
  if (!keys) return null;
  const list = Array.isArray(keys) ? keys : [keys];
  for (const k of list) {
    const v = positive(numAt(a, k));
    if (v !== null) return v;
  }
  return null;
}

export class ArcgisPermitsAdapter implements SourceAdapter {
  readonly key: string;
  readonly parserVersion: string;
  private readonly cfg: ArcgisPermitsConfig;

  constructor(cfg: ArcgisPermitsConfig) {
    this.cfg = cfg;
    this.key = cfg.key;
    this.parserVersion = cfg.parserVersion ?? "1.0.0";
  }

  private windowWhere(ctx: RunContext): string {
    const wf = this.cfg.windowField;
    if (ctx.backfill) {
      return (
        `${wf} >= ${tsLiteral(new Date(`${ctx.backfill.from}T00:00:00Z`))}` +
        ` AND ${wf} <= ${tsLiteral(new Date(`${ctx.backfill.to}T23:59:59Z`))}`
      );
    }
    const days = this.cfg.windowDays ?? DEFAULT_WINDOW_DAYS;
    // Quantized to the UTC day so same-day reruns produce identical query URLs
    // → identical page bytes dedupe on the unchanged-hash path.
    const since = new Date(
      Math.floor((Date.now() - days * 86_400_000) / 86_400_000) * 86_400_000,
    );
    const primary = `${wf} >= ${tsLiteral(since)}`;
    return this.cfg.windowFieldSecondary
      ? `${primary} OR ${this.cfg.windowFieldSecondary} >= ${tsLiteral(since)}`
      : primary;
  }

  async discover(ctx: RunContext): Promise<DiscoveredArtifact[]> {
    const where = this.windowWhere(ctx);
    const layer = this.cfg.layerUrl;
    const countUrl = `${layer}/query?where=${encodeURIComponent(where)}&returnCountOnly=true&f=json`;
    const body = await httpGet(countUrl, ctx);
    const count = Number(JSON.parse(body.toString("utf8"))?.count ?? NaN);
    if (!Number.isFinite(count)) throw new Error(`${this.key} ArcGIS count query failed`);
    const pageSize = this.cfg.pageSize;
    const pages = Math.max(1, Math.ceil(count / pageSize));
    ctx.logger.info({ count, pages, where }, `${this.key} arcgis window`);

    const orderBy = this.cfg.orderByField ?? this.cfg.fields.externalId;
    return Array.from({ length: pages }, (_v, i) => {
      const query =
        `where=${encodeURIComponent(where)}&outFields=*&returnGeometry=true&outSR=4326` +
        `&orderByFields=${encodeURIComponent(`${orderBy} ASC`)}` +
        `&resultOffset=${i * pageSize}&resultRecordCount=${pageSize}&f=json`;
      return {
        idempotencyKey: `${this.key}:${ctx.backfill ? `backfill-${ctx.backfill.from}-${ctx.backfill.to}` : "window"}:page-${i + 1}`,
        canonicalUrl: `${layer}/query?${query}`,
        parentUrl: this.cfg.landingUrl,
        expectedContentType: "application/json",
        sourcePublishedAt: null,
        meta: { page: i + 1 },
      };
    });
  }

  async fetch(item: DiscoveredArtifact, ctx: RunContext): Promise<RawArtifact> {
    return httpFetchArtifact(item, ctx);
  }

  async parse(raw: RawArtifact, ctx: RunContext): Promise<ParsedSourceRecord[]> {
    const parsedBody = ResponseSchema.parse(JSON.parse(raw.body.toString("utf8")));
    const f = this.cfg.fields;
    const out: ParsedSourceRecord[] = [];

    for (const entry of parsedBody.features) {
      const parsed = FeatureShape.safeParse(entry);
      const externalId = parsed.success ? strAt(parsed.data.attributes, f.externalId) : null;
      if (!parsed.success || !externalId) {
        ctx.logger.warn({ entry }, `${this.key} feature does not match expected shape`);
        out.push({
          record: { sourceKey: this.key, externalId: "" } as never,
          rawFields: (entry ?? {}) as Record<string, unknown>,
        });
        continue;
      }
      const a = parsed.data.attributes;

      const statusRaw = strAt(a, f.status);
      const stage = this.cfg.stageFor(statusRaw);
      if (stage === "unknown" && statusRaw) {
        ctx.logger.warn({ status: statusRaw }, `${this.key} unmapped status — stage left unknown`);
      }

      const point =
        parsed.data.geometry ??
        (() => {
          const lng = numAt(a, f.lng);
          const lat = numAt(a, f.lat);
          return lng !== null && lat !== null ? { x: lng, y: lat } : null;
        })();
      const geometry: { type: "Point"; coordinates: [number, number] } | null = point
        ? { type: "Point", coordinates: [point.x, point.y] }
        : null;

      const valuation = firstPositive(a, f.valuation);
      const units = intOrNull(numAt(a, f.units));
      const address = joinFields(a, f.address);
      const description = strAt(a, f.description);
      const permitType = strAt(a, f.permitType);
      const applicationType = strAt(a, f.applicationType);
      const projectName = strAt(a, f.projectName);
      const parcel = strAt(a, f.parcel);
      const applicant = strAt(a, f.applicant);
      const appliedIso = dateIso(a, f.applied, this.cfg.dateKind);
      const issuedIso = dateIso(a, f.issued, this.cfg.dateKind);
      const externalRef = strAt(a, f.externalRef);
      const link = strAt(a, f.sourceUrl);
      const sourceUrl = link ? link.replace(/&amp;/g, "&") : this.cfg.landingUrl;

      const typeLabel = [permitType, applicationType].filter(Boolean).join(" / ") || null;
      const titleBody = (description ?? projectName ?? typeLabel ?? `${this.cfg.jurisdiction} permit`).slice(0, 120);

      const organizations: NormalizedSourceRecord["organizations"] = applicant
        ? [
            {
              name: applicant,
              role: this.cfg.applicantRole ?? "applicant",
              evidenceText: `${f.applicant}: ${applicant}`,
            },
          ]
        : [];

      out.push({
        rawFields: { ...a, externalRef, appliedDateIso: appliedIso, issuedDateIso: issuedIso },
        record: {
          sourceKey: this.key,
          externalId,
          recordType: this.cfg.recordType ?? "building_permit",
          title: `${externalId} – ${titleBody}`,
          description,
          permittingJurisdiction: this.cfg.jurisdiction,
          county: this.cfg.county,
          city: this.cfg.city,
          addressRaw: address,
          parcelIds: parcel ? [parcel] : [],
          geometry,
          applicationType: applicationType ?? typeLabel,
          permitType,
          documentType: null,
          statusRaw,
          normalizedStage: stage,
          applicationDate: appliedIso?.slice(0, 10) ?? null,
          issueDate: issuedIso?.slice(0, 10) ?? null,
          sourceUpdatedAt: null,
          valuationUsd: valuation,
          units,
          lots: null,
          squareFeet: null,
          organizations,
          sourceUrl,
          evidence: [
            {
              factPath: "title",
              text: `${externalId} ${typeLabel ?? ""}: ${description ?? projectName ?? ""}`.trim(),
              pageOrSection: `${this.cfg.layerUrl.split("/services/")[1] ?? "layer"}`,
            },
            ...(statusRaw
              ? [{ factPath: "statusRaw", text: `${f.status}: ${statusRaw}`, pageOrSection: `${f.status} field` }]
              : []),
            ...(valuation !== null
              ? [{ factPath: "valuationUsd", text: `valuation ${valuation}`, pageOrSection: "valuation field" }]
              : []),
            ...(parcel
              ? [{ factPath: "parcelIds", text: `parcel ${parcel}`, pageOrSection: `${f.parcel} field` }]
              : []),
            ...(applicant
              ? [{ factPath: "organizations", text: `${f.applicant}: ${applicant}`, pageOrSection: `${f.applicant} field` }]
              : []),
            ...(externalRef
              ? [
                  {
                    factPath: "externalRef",
                    text: `${this.cfg.externalRefLabel ?? "record id"}: ${externalRef}`,
                    pageOrSection: `${f.externalRef} field`,
                  },
                ]
              : []),
          ],
        },
      });
    }
    return out;
  }

  /**
   * D1 — self-reconciliation. An ArcGIS field rename/reorder can silently land
   * the wrong value in valuation/units or a date field without changing our
   * field-name fingerprint. Value-shape checks catch it at runtime: valuation
   * and units must be plausible non-negative amounts, dates must sit in a sane
   * window. Never fabricates — nulls are skipped.
   */
  checkInvariants(_raw: RawArtifact, parsed: ParsedSourceRecord[]): InvariantViolation[] {
    const out: InvariantViolation[] = [];
    const rec = (p: ParsedSourceRecord) => p.record as NormalizedSourceRecord;
    const v = checkNumericRange(parsed, (p) => rec(p).valuationUsd, {
      min: 0,
      max: this.cfg.valuationMax ?? 5_000_000_000,
      check: `${this.key}_valuation_range`,
    });
    if (v) out.push(v);
    const u = checkNumericRange(parsed, (p) => rec(p).units, {
      min: 0,
      max: this.cfg.unitsMax ?? 10_000,
      check: `${this.key}_units_range`,
    });
    if (u) out.push(u);
    for (const [field, get] of [
      ["issue", (p: ParsedSourceRecord) => rec(p).issueDate],
      ["application", (p: ParsedSourceRecord) => rec(p).applicationDate],
    ] as const) {
      const d = checkDateWindow(parsed, get, {
        minIso: "2000-01-01",
        maxIso: "2100-01-01",
        check: `${this.key}_${field}_date_window`,
      });
      if (d) out.push(d);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// City configs. Each field map + stageFor is derived from a LIVE `?f=json`
// inspection of that city's layer (recorded in fixtures/<key>/metadata.json),
// never from another city's schema.
// ---------------------------------------------------------------------------

/** Bellevue PERMITSTATUS → §9 stage. Vocabulary enumerated live 2026-07-22
 * (fixtures/bellevue_permits_arcgis/metadata.json). Unmatched ⇒ "unknown". */
export function bellevueStage(status: string | null): NormalizedSourceRecord["normalizedStage"] {
  const s = (status ?? "").trim().toLowerCase();
  if (!s) return "unknown";
  if (/(cancel|void|withdrawn|expired|denied)/.test(s)) return "withdrawn";
  if (/^issued$/.test(s)) return "permit_issued";
  // The whole pre-issuance pipeline: an application being worked. Checked BEFORE
  // the complete branch so "Completeness Check" (an intake step) is not misread
  // as "complete". "Appealed" is a contested in-process decision — not issued,
  // not dead — so it stays here.
  if (/(open|completeness|screening|pending|incomplete|accepted|ready to issue|appealed|review|intake|submitted|application)/.test(s)) {
    return "permit_applied";
  }
  if (/(finaled|closed|complete|c of o|certificate of occupancy)/.test(s)) return "complete";
  return "unknown";
}

/**
 * City of Bellevue permit data (ArcGIS Hub open-data FeatureServer, verified
 * live 2026-07-22). The richest ArcGIS city in the Puget Sound sweep: CONTRACTOR
 * of record on every row (the primary trades-matching signal), VALUATION
 * (populated at/after issuance), dwelling units, applied/issued dates, WGS84
 * point. King-county — routes to Solis as King-suburb commercial. Bellevue is
 * King's second-largest job market after Seattle.
 */
export const BELLEVUE_CONFIG: ArcgisPermitsConfig = {
  key: "bellevue_permits_arcgis",
  layerUrl:
    "https://services1.arcgis.com/EYzEZbDhXZjURPbP/arcgis/rest/services/Bellevue_Permits/FeatureServer/0",
  landingUrl: "https://data-bellevue.opendata.arcgis.com/",
  pageSize: 2000,
  county: "King",
  jurisdiction: "City of Bellevue",
  city: "Bellevue",
  dateKind: "epoch",
  windowField: "APPLIEDDATE",
  windowFieldSecondary: "ISSUEDDATE",
  applicantRole: "primary_contractor",
  fields: {
    externalId: "PERMITNUMBER",
    permitType: "PERMITTYPE",
    status: "PERMITSTATUS",
    description: "PROJECTDESCRIPTION",
    projectName: "PROJECTNAME",
    address: ["SITEADDRESS", "CITY", "ZIPCODE"],
    valuation: "VALUATION",
    units: "DWELLINGUNITSCREATED",
    applied: "APPLIEDDATE",
    issued: "ISSUEDDATE",
    parcel: "PARCELNUMBER",
    applicant: "CONTRACTOR",
  },
  stageFor: bellevueStage,
};

/** City of Spokane permit Status → §9 stage. Vocabulary enumerated live
 * 2026-07-23 (fixtures/spokane_permits_arcgis/metadata.json). "In Progress" is
 * the Accela application-workflow-in-progress state (pre-issuance — the feed
 * carries a distinct "Issued"), so it maps to permit_applied, the safer earlier
 * reading. Unmatched ⇒ "unknown". */
export function spokaneStage(status: string | null): NormalizedSourceRecord["normalizedStage"] {
  const s = (status ?? "").trim().toLowerCase();
  if (!s) return "unknown";
  if (/(cancel|void|withdrawn|denied|expired)/.test(s)) return "withdrawn";
  if (/^issued$/.test(s)) return "permit_issued";
  if (/(final|finaled|closed|complete|c of o)/.test(s)) return "complete";
  // "Application Approved" / "Plan Review Approved" — a favorable pre-issuance
  // decision. Checked BEFORE the pipeline branch so "…Approved" is not read as a
  // bare review step.
  if (/approved/.test(s)) return "approved";
  if (/(plan review|pending|in progress|revisions required|planning consolidation|screening|intake|submitted|application)/.test(s)) {
    return "permit_applied";
  }
  return "unknown";
}

/**
 * City of Spokane permits (ArcGIS MapServer `Permit/Permit_WM_Dynamic2`, layer 0
 * "Permit"; layers 1–3 are boundary/council overlays). Verified live 2026-07-23:
 * OpenDate epoch, WGS84 point on 100% of rows, a clean Status vocabulary. NO
 * contractor/valuation/units — a demand + stage + geography source, not a
 * trades-matching one. Spokane county (eastern WA): far from every current
 * account, so Solis's distance band de-rates it hard — but it is clean regional
 * corpus data for future eastern accounts and cross-market demand. */
export const SPOKANE_CONFIG: ArcgisPermitsConfig = {
  key: "spokane_permits_arcgis",
  layerUrl:
    "https://services.spokanegis.org/arcgis/rest/services/Permit/Permit_WM_Dynamic2/MapServer/0",
  landingUrl: "https://my.spokanecity.org/opendata/",
  pageSize: 2000,
  county: "Spokane",
  jurisdiction: "City of Spokane",
  city: "Spokane",
  dateKind: "epoch",
  windowField: "OpenDate",
  fields: {
    externalId: "SpokanePermitID",
    permitType: "PermitType",
    applicationType: "PermitTypeAlias",
    status: "Status",
    description: "DetailShortNotes",
    address: "FullAddress",
    applied: "OpenDate",
    parcel: "ParcelNumber",
    externalRef: "AccelaPermitID1",
  },
  externalRefLabel: "Accela permit id",
  stageFor: spokaneStage,
};
