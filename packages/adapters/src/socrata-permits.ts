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
import type { County, NormalizedSourceRecord } from "@otn/domain";

/**
 * Generic, config-driven Socrata (SODA) permit adapter.
 *
 * Seattle's Socrata feed is a bespoke file (`seattle-socrata.ts`) because it
 * predates this generalization and carries land-use decisiondate quirks. Every
 * OTHER Socrata permit dataset we onboard — Everett, Auburn, and the rest of the
 * Puget Sound sweep — is the SAME shape: a `$select=count(*)` window query, a
 * paged `$limit`/`$offset` pull ordered on a stable applied-date column, and
 * per-row attribute mapping. This adapter captures that shape once; a new city
 * becomes a `SocrataPermitsConfig` + real fixtures, not a new integration.
 *
 * Mirrors `seattle-socrata.ts` (discover: count→paged; applied-date high-water
 * with overlap; nightly-republish note) and the generic `arcgis-permits.ts`
 * (the config `fields` map + `checkInvariants`). Column names, whether a status
 * string exists, and geometry encoding DIFFER per city — the config selects the
 * parse; nothing is assumed from another city's schema. Unknown is null, never
 * zero (`positive()`). Placeholder party strings ("CONTRACTOR UNKNOWN", "OWNER")
 * are dropped, never emitted as an org. Adapters emit source records + evidence
 * only (spec §5) — never customer opportunities.
 */

const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_OVERLAP_DAYS = 30;
const DEFAULT_WINDOW_DAYS = 120;

/** Party strings that mean "no contractor of record" — filtered to null so the
 * adapter never emits a placeholder as a business org (governing person-gate). */
const DEFAULT_PARTY_PLACEHOLDERS = [
  "contractor unknown",
  "unknown",
  "owner",
  "owner/builder",
  "owner builder",
  "self",
  "same as owner",
  "n/a",
  "na",
  "none",
  "tbd",
  "to be determined",
];

/** Field-name map for one Socrata dataset. Every entry is a live-verified column
 * from that dataset's `?$limit=1` / view metadata (audit lists are approximate —
 * confirm before shipping). Omit a field the dataset lacks; unknown ⇒ null. */
export interface SocrataFieldMap {
  /** Permit-number column → `externalId` (required; the row's stable id). */
  externalId: string;
  permitType?: string;
  permitSubtype?: string;
  applicationType?: string;
  /** Status string column, when the dataset publishes one (Everett has none —
   * its stage derives from date presence). */
  status?: string;
  description?: string;
  /** One or more address columns, joined in order. */
  address?: string | string[];
  /** Valuation column(s), tried in order — first positive wins (0 ⇒ unknown). */
  valuation?: string | string[];
  units?: string;
  /** Applied-date column (also the default discovery window / high-water field). */
  applied: string;
  approved?: string;
  issued?: string;
  /** Completion date column (Auburn `finaled`); presence ⇒ complete. */
  completed?: string;
  parcel?: string;
  /** Contractor-of-record column → a `primary_contractor` org (business identity;
   * placeholder values are dropped). Owner/applicant are NOT emitted — they are
   * routinely individuals (person-gate), matching the Seattle precedent. */
  contractor?: string;
  /** Socrata point column carrying a GeoJSON `{type:"Point",coordinates:[lng,lat]}`
   * or a legacy `{latitude,longitude}` object (e.g. Everett `geocoded_column`). */
  geocodedColumn?: string;
  /** Separate numeric lat/lng columns, when there is no geocoded point column. */
  lat?: string;
  lng?: string;
  /** Canonical per-record link column → `sourceUrl` (else a resource query URL). */
  sourceUrl?: string;
}

export interface SocrataPermitsConfig {
  key: string;
  /** Socrata host, e.g. "data.everettwa.gov". */
  domain: string;
  /** Four-by-four dataset id, e.g. "3w3u-656c". */
  datasetId: string;
  recordType?: string;
  parserVersion?: string;
  county: County;
  /** `permittingJurisdiction` (e.g. "City of Everett"). */
  jurisdiction: string;
  city: string | null;
  pageSize?: number;
  windowDays?: number;
  overlapDays?: number;
  fields: SocrataFieldMap;
  /** Role for the contractor org entry (default "primary_contractor"). */
  contractorRole?: string;
  /** Extra placeholder party strings to drop (merged with the defaults). */
  partyPlaceholders?: string[];
  /** Maps status + date-presence flags → §9 stage. */
  stageFor(input: {
    status: string | null;
    hasApproved: boolean;
    hasIssued: boolean;
    hasCompleted: boolean;
  }): NormalizedSourceRecord["normalizedStage"];
  /** D1 invariant ceiling for valuation (default 5e9). */
  valuationMax?: number;
  /** D1 invariant ceiling for units (default 10000). */
  unitsMax?: number;
}

const GeoPoint = z.object({
  type: z.literal("Point"),
  coordinates: z.tuple([z.number(), z.number()]),
});
const GeoLegacy = z.object({
  latitude: z.union([z.number(), z.string()]),
  longitude: z.union([z.number(), z.string()]),
});

function strAt(row: Record<string, unknown>, key: string | undefined): string | null {
  if (!key) return null;
  const v = row[key];
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function numAt(row: Record<string, unknown>, key: string | undefined): number | null {
  if (!key) return null;
  const v = row[key];
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

/** Socrata dates are ISO strings ("2026-07-10T00:00:00.000"). */
function dateIso(row: Record<string, unknown>, key: string | undefined): string | null {
  const s = strAt(row, key);
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function joinFields(row: Record<string, unknown>, keys: string | string[] | undefined): string | null {
  if (!keys) return null;
  const list = Array.isArray(keys) ? keys : [keys];
  const parts = list.map((k) => strAt(row, k)).filter((v): v is string => Boolean(v));
  return parts.length ? parts.join(", ") : null;
}

function firstPositive(row: Record<string, unknown>, keys: string | string[] | undefined): number | null {
  if (!keys) return null;
  const list = Array.isArray(keys) ? keys : [keys];
  for (const k of list) {
    const v = positive(numAt(row, k));
    if (v !== null) return v;
  }
  return null;
}

/** GeoJSON point from a Socrata geocoded column (new `{type,coordinates}` or
 * legacy `{latitude,longitude}`) or separate lat/lng columns; else null. */
function geometryFor(
  row: Record<string, unknown>,
  f: SocrataFieldMap,
): { type: "Point"; coordinates: [number, number] } | null {
  if (f.geocodedColumn) {
    const raw = row[f.geocodedColumn];
    const asPoint = GeoPoint.safeParse(raw);
    if (asPoint.success) {
      const [lng, lat] = asPoint.data.coordinates;
      return { type: "Point", coordinates: [lng, lat] };
    }
    const asLegacy = GeoLegacy.safeParse(raw);
    if (asLegacy.success) {
      const lat = Number(asLegacy.data.latitude);
      const lng = Number(asLegacy.data.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { type: "Point", coordinates: [lng, lat] };
    }
  }
  const lat = numAt(row, f.lat);
  const lng = numAt(row, f.lng);
  return lat !== null && lng !== null ? { type: "Point", coordinates: [lng, lat] } : null;
}

export class SocrataPermitsAdapter implements SourceAdapter {
  readonly key: string;
  readonly parserVersion: string;
  private readonly cfg: SocrataPermitsConfig;
  private readonly placeholders: Set<string>;
  private maxApplied = "";

  constructor(cfg: SocrataPermitsConfig) {
    this.cfg = cfg;
    this.key = cfg.key;
    this.parserVersion = cfg.parserVersion ?? "1.0.0";
    this.placeholders = new Set([
      ...DEFAULT_PARTY_PLACEHOLDERS,
      ...(cfg.partyPlaceholders ?? []).map((p) => p.toLowerCase()),
    ]);
  }

  private base(): string {
    return `https://${this.cfg.domain}/resource/${this.cfg.datasetId}.json`;
  }

  private windowFor(ctx: RunContext): { from: string; to: string | null } {
    if (ctx.backfill) return { from: ctx.backfill.from, to: ctx.backfill.to };
    const overlap = this.cfg.overlapDays ?? DEFAULT_OVERLAP_DAYS;
    const windowDays = this.cfg.windowDays ?? DEFAULT_WINDOW_DAYS;
    const highWater = String(ctx.checkpoint?.["appliedDateHighWater"] ?? "");
    const from = highWater
      ? new Date(Date.parse(highWater.slice(0, 10)) - overlap * 86_400_000)
      : new Date(Date.now() - windowDays * 86_400_000);
    return { from: from.toISOString().slice(0, 10), to: null };
  }

  private whereClause(w: { from: string; to: string | null }): string {
    const wf = this.cfg.fields.applied;
    const parts = [`${wf} >= '${w.from}T00:00:00'`];
    if (w.to) parts.push(`${wf} <= '${w.to}T23:59:59'`);
    return parts.join(" AND ");
  }

  async discover(ctx: RunContext): Promise<DiscoveredArtifact[]> {
    const w = this.windowFor(ctx);
    const where = this.whereClause(w);
    const countUrl = `${this.base()}?$select=count(*)&$where=${encodeURIComponent(where)}`;
    const body = await httpGet(countUrl, ctx);
    const count = Number(JSON.parse(body.toString("utf8"))?.[0]?.count ?? NaN);
    if (!Number.isFinite(count)) throw new Error(`${this.key} Socrata count query failed`);
    const pageSize = this.cfg.pageSize ?? DEFAULT_PAGE_SIZE;
    const pages = Math.max(1, Math.ceil(count / pageSize));
    ctx.logger.info({ dataset: this.cfg.datasetId, count, pages, window: w }, `${this.key} socrata window`);

    const order = `${this.cfg.fields.applied}, ${this.cfg.fields.externalId}`;
    return Array.from({ length: pages }, (_v, i) => {
      const query =
        `$where=${encodeURIComponent(where)}` +
        `&$order=${encodeURIComponent(order)}` +
        `&$limit=${pageSize}&$offset=${i * pageSize}`;
      return {
        idempotencyKey: `${this.key}:from-${w.from}:page-${i + 1}`,
        canonicalUrl: `${this.base()}?${query}`,
        parentUrl: `https://${this.cfg.domain}/d/${this.cfg.datasetId}`,
        expectedContentType: "application/json",
        sourcePublishedAt: null,
        meta: { page: i + 1, windowFrom: w.from },
      };
    });
  }

  async fetch(item: DiscoveredArtifact, ctx: RunContext): Promise<RawArtifact> {
    return httpFetchArtifact(item, ctx);
  }

  async parse(raw: RawArtifact, ctx: RunContext): Promise<ParsedSourceRecord[]> {
    const rows = z.array(z.unknown()).parse(JSON.parse(raw.body.toString("utf8")));
    const f = this.cfg.fields;
    const out: ParsedSourceRecord[] = [];
    if (!this.maxApplied) {
      this.maxApplied = String(ctx.checkpoint?.["appliedDateHighWater"] ?? "");
    }

    for (const entry of rows) {
      const row = (entry ?? {}) as Record<string, unknown>;
      const externalId = strAt(row, f.externalId);
      if (!externalId) {
        ctx.logger.warn({ entry }, `${this.key} row missing external id`);
        out.push({
          record: { sourceKey: this.key, externalId: "" } as never,
          rawFields: row,
        });
        continue;
      }

      const appliedIso = dateIso(row, f.applied);
      const applied = appliedIso?.slice(0, 10) ?? null;
      if (applied && applied > this.maxApplied) this.maxApplied = applied;

      const approvedIso = dateIso(row, f.approved);
      const issuedIso = dateIso(row, f.issued);
      const completedIso = dateIso(row, f.completed);
      const statusRaw = strAt(row, f.status);
      const stage = this.cfg.stageFor({
        status: statusRaw,
        hasApproved: Boolean(approvedIso),
        hasIssued: Boolean(issuedIso),
        hasCompleted: Boolean(completedIso),
      });
      if (stage === "unknown" && statusRaw) {
        ctx.logger.warn({ status: statusRaw }, `${this.key} unmapped status — stage left unknown`);
      }

      const valuation = firstPositive(row, f.valuation);
      const units = intOrNull(numAt(row, f.units));
      const address = joinFields(row, f.address);
      const description = strAt(row, f.description);
      const permitType = strAt(row, f.permitType);
      const permitSubtype = strAt(row, f.permitSubtype);
      const applicationType = strAt(row, f.applicationType);
      const parcel = strAt(row, f.parcel);
      const geometry = geometryFor(row, f);

      // Contractor of record → primary_contractor org, unless it's a placeholder
      // ("CONTRACTOR UNKNOWN", "OWNER", …) — those are dropped, never emitted.
      const contractorRaw = strAt(row, f.contractor);
      const contractor =
        contractorRaw && !this.placeholders.has(contractorRaw.toLowerCase()) ? contractorRaw : null;
      const organizations: NormalizedSourceRecord["organizations"] = contractor
        ? [
            {
              name: contractor,
              role: this.cfg.contractorRole ?? "primary_contractor",
              evidenceText: `${f.contractor}: ${contractor}`,
            },
          ]
        : [];

      const typeLabel = [permitType, permitSubtype].filter(Boolean).join(" / ") || null;
      const titleBody = (description ?? typeLabel ?? `${this.cfg.jurisdiction} permit`).slice(0, 120);
      const linkCol = strAt(row, f.sourceUrl);
      const sourceUrl =
        linkCol ??
        `${this.base()}?${encodeURIComponent(f.externalId)}=${encodeURIComponent(externalId)}`;

      out.push({
        rawFields: row,
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
          applicationDate: appliedIso,
          issueDate: issuedIso,
          sourceUpdatedAt: null,
          valuationUsd: valuation,
          units,
          lots: null,
          squareFeet: null,
          organizations,
          sourceUrl,
          evidence: [
            { factPath: "externalId", text: externalId, pageOrSection: `dataset ${this.cfg.datasetId}` },
            ...(statusRaw
              ? [{ factPath: "statusRaw", text: `${f.status}: ${statusRaw}`, pageOrSection: `${f.status}` }]
              : []),
            ...(issuedIso
              ? [{ factPath: "issueDate", text: `${f.issued}: ${issuedIso.slice(0, 10)}`, pageOrSection: `${f.issued}` }]
              : []),
            ...(contractor
              ? [{ factPath: "organizations", text: `${f.contractor}: ${contractor}`, pageOrSection: `${f.contractor}` }]
              : []),
            ...(valuation !== null
              ? [{ factPath: "valuationUsd", text: `${Array.isArray(f.valuation) ? f.valuation.join("/") : f.valuation}: ${valuation}`, pageOrSection: "valuation" }]
              : []),
          ],
        },
      });
    }

    if (this.maxApplied && !ctx.backfill) {
      ctx.setCheckpoint({ appliedDateHighWater: this.maxApplied });
    }
    return out;
  }

  /**
   * D1 — self-reconciliation for a JSON API. A Socrata column rename/reorder (the
   * datasets are republished on a cadence) can silently land the wrong value in
   * valuation/units or a date field without changing our field-name fingerprint.
   * Value-shape checks catch it: valuation/units must be plausible non-negative
   * amounts, dates must sit in a sane window (this is what flags the Everett
   * `issueddate: 2914-…` source typo). Never fabricates — nulls are skipped.
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
// Dataset configs. Each field map + stageFor is derived from a LIVE inspection
// of that dataset (recorded in fixtures/<key>/metadata.json), never from
// another city's schema.
// ---------------------------------------------------------------------------

/** Everett Trakit permits (Socrata `3w3u-656c`, verified live 2026-07-23). No
 * status column — stage derives from date presence. CONTRACTOR of record on
 * ~94% of rows (the primary trades signal); owner/applicant are routinely
 * individuals and are NOT emitted (person-gate). Snohomish county — Everett is
 * the county seat and the first genuine Snohomish source. */
export function everettStage(input: {
  hasApproved: boolean;
  hasIssued: boolean;
}): NormalizedSourceRecord["normalizedStage"] {
  if (input.hasIssued) return "permit_issued";
  if (input.hasApproved) return "approved";
  return "permit_applied";
}

export const EVERETT_CONFIG: SocrataPermitsConfig = {
  key: "everett_permits_socrata",
  domain: "data.everettwa.gov",
  datasetId: "3w3u-656c",
  county: "Snohomish",
  jurisdiction: "City of Everett",
  city: "Everett",
  fields: {
    externalId: "permitno",
    permitType: "permittype",
    permitSubtype: "permitsubtype",
    description: "permitdesc",
    address: "siteaddress",
    valuation: "jobvalue",
    applied: "applieddate",
    approved: "approveddate",
    issued: "issueddate",
    parcel: "siteapn",
    contractor: "contractorname",
    geocodedColumn: "geocoded_column",
  },
  stageFor: everettStage,
};

/** Auburn permits (Socrata `fted-8bve`). Schema verified live 2026-07-23 and the
 * parser is proven against a real golden fixture — BUT the dataset's ETL is
 * FROZEN (max applied date 2025-02-25; rowsUpdatedAt 2025-02-26 across all three
 * Auburn permit datasets). Left `enabled:false` in config/sources.yaml: a live
 * run would immediately trip the source-health stale rule and deliver 17-month-
 * old data. This is a one-flag flip if Auburn resumes publishing. King county. */
export function auburnStage(input: {
  status: string | null;
  hasIssued: boolean;
  hasCompleted: boolean;
}): NormalizedSourceRecord["normalizedStage"] {
  const s = (input.status ?? "").trim().toLowerCase();
  if (/(void|cancel|withdrawn|denied|expired)/.test(s)) return "withdrawn";
  if (/(finaled|closed|complete|c of o)/.test(s) || input.hasCompleted) return "complete";
  if (/issued/.test(s) || input.hasIssued) return "permit_issued";
  if (/(approved|ready)/.test(s)) return "approved";
  if (/(applied|review|pending|intake|submitted|in process|hold)/.test(s)) return "permit_applied";
  return "unknown";
}

export const AUBURN_CONFIG: SocrataPermitsConfig = {
  key: "auburn_permits_socrata",
  domain: "data.auburnwa.gov",
  datasetId: "fted-8bve",
  county: "King",
  jurisdiction: "City of Auburn",
  city: "Auburn",
  fields: {
    externalId: "permit",
    permitType: "type",
    permitSubtype: "subtype",
    status: "status",
    description: "description",
    address: "address",
    applied: "applied",
    issued: "issued",
    // NOTE: `finaled` is deliberately NOT mapped to `completed`. Auburn populates
    // it on EVERY row — all 213 ISSUED rows in the golden fixture carry a finaled
    // date — so it is a last-status-change stamp, not a completion signal. Mapping
    // it would mark every issued permit "complete". The `status` string is
    // authoritative here (FINALED ⇒ complete). Found via the golden fixture.
    parcel: "parcel",
    contractor: "contractor",
  },
  stageFor: auburnStage,
};
