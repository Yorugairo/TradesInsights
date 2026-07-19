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
import type { NormalizedSourceRecord } from "@otn/domain";

/**
 * Spec §6.4 Socrata rules: live columns inspected before coding (2026-07-15);
 * bounded $limit with deterministic $order; filter on a stable time field
 * (applieddate — the datasets are fully republished nightly, so :updated_at
 * is identical on every row and useless for increments); high-water mark
 * with overlap; never an unbounded query.
 */
const PAGE_SIZE = 1000;
const OVERLAP_DAYS = 30;
const DEFAULT_WINDOW_DAYS = 120;

const SocrataRowSchema = z
  .object({
    permitnum: z.string().min(1),
    permitclass: z.string().optional(),
    permitclassmapped: z.string().optional(),
    permittypemapped: z.string().optional(),
    permittypedesc: z.string().optional(),
    description: z.string().optional(),
    housingunits: z.string().optional(),
    estprojectcost: z.string().optional(),
    statuscurrent: z.string().optional(),
    contractorcompanyname: z.string().optional(),
    applieddate: z.string().optional(),
    issueddate: z.string().optional(),
    decisiondate: z.string().optional(),
    completeddate: z.string().optional(),
    expiresdate: z.string().optional(),
    originaladdress1: z.string().optional(),
    originalcity: z.string().optional(),
    originalzip: z.string().optional(),
    latitude: z.string().optional(),
    longitude: z.string().optional(),
    link: z.object({ url: z.string() }).optional(),
    relatedmup: z.string().optional(),
  })
  .passthrough();

export interface SeattleSocrataConfig {
  key: string;
  datasetId: string;
  recordType: string;
  /** Column carrying the issued/decision date that drives `issueDate` and the
   * issued stage. Building permits publish `issueddate`; land-use (master use)
   * permits publish `decisiondate` and NEVER `issueddate` — keying this off the
   * config (not a global read) keeps the building behavior untouched. */
  issuedDateField: "issueddate" | "decisiondate";
  /** Deterministic stage from explicit dates (documented in the ledger). */
  stageFor(row: { issued: boolean; completed: boolean }): NormalizedSourceRecord["normalizedStage"];
}

export const SEATTLE_BUILDING_CONFIG: SeattleSocrataConfig = {
  key: "seattle_building_permits",
  datasetId: "76t5-zqzr",
  recordType: "building_permit",
  issuedDateField: "issueddate",
  stageFor: ({ issued, completed }) =>
    completed ? "complete" : issued ? "permit_issued" : "permit_applied",
};

export const SEATTLE_LAND_USE_CONFIG: SeattleSocrataConfig = {
  key: "seattle_land_use_permits",
  datasetId: "ht3q-kdvx",
  recordType: "land_use_permit",
  // Land-use publishes the decision as `decisiondate`, never `issueddate`.
  issuedDateField: "decisiondate",
  // A land-use (master use) permit is the entitlement instrument: issued
  // decision → approved; application pending → entitlement.
  stageFor: ({ issued }) => (issued ? "approved" : "entitlement"),
};

export class SeattleSocrataAdapter implements SourceAdapter {
  readonly key: string;
  readonly parserVersion = "1.0.0";
  private readonly cfg: SeattleSocrataConfig;
  private maxApplied = "";

  constructor(cfg: SeattleSocrataConfig) {
    this.cfg = cfg;
    this.key = cfg.key;
  }

  private base(): string {
    return `https://data.seattle.gov/resource/${this.cfg.datasetId}.json`;
  }

  private windowFor(ctx: RunContext): { from: string; to: string | null } {
    if (ctx.backfill) return { from: ctx.backfill.from, to: ctx.backfill.to };
    const highWater = String(ctx.checkpoint?.["appliedDateHighWater"] ?? "");
    const from = highWater
      ? new Date(Date.parse(highWater.slice(0, 10)) - OVERLAP_DAYS * 86_400_000)
      : new Date(Date.now() - DEFAULT_WINDOW_DAYS * 86_400_000);
    return { from: from.toISOString().slice(0, 10), to: null };
  }

  private whereClause(w: { from: string; to: string | null }): string {
    const parts = [`applieddate >= '${w.from}T00:00:00'`];
    if (w.to) parts.push(`applieddate <= '${w.to}T23:59:59'`);
    return parts.join(" AND ");
  }

  async discover(ctx: RunContext): Promise<DiscoveredArtifact[]> {
    const w = this.windowFor(ctx);
    const where = this.whereClause(w);
    const countUrl = `${this.base()}?$select=count(*)&$where=${encodeURIComponent(where)}`;
    const body = await httpGet(countUrl, ctx);
    const count = Number(JSON.parse(body.toString("utf8"))?.[0]?.count ?? NaN);
    if (!Number.isFinite(count)) {
      throw new Error(`Socrata count query failed for ${this.cfg.datasetId}`);
    }
    const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
    ctx.logger.info({ dataset: this.cfg.datasetId, count, pages, window: w }, "socrata window");

    return Array.from({ length: pages }, (_v, i) => {
      const query =
        `$where=${encodeURIComponent(where)}` +
        `&$order=${encodeURIComponent("applieddate, permitnum")}` +
        `&$limit=${PAGE_SIZE}&$offset=${i * PAGE_SIZE}`;
      return {
        idempotencyKey: `${this.key}:from-${w.from}:page-${i + 1}`,
        canonicalUrl: `${this.base()}?${query}`,
        parentUrl: `https://data.seattle.gov/Permitting/${this.cfg.datasetId}`,
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
    const out: ParsedSourceRecord[] = [];
    if (!this.maxApplied) {
      this.maxApplied = String(ctx.checkpoint?.["appliedDateHighWater"] ?? "");
    }

    for (const entry of rows) {
      const parsed = SocrataRowSchema.safeParse(entry);
      if (!parsed.success) {
        ctx.logger.warn({ entry }, "socrata row does not match expected shape");
        out.push({
          record: { sourceKey: this.key, externalId: "" } as never,
          rawFields: (entry ?? {}) as Record<string, unknown>,
        });
        continue;
      }
      const r = parsed.data;
      const applied = r.applieddate?.slice(0, 10) ?? null;
      if (applied && applied > this.maxApplied) this.maxApplied = applied;

      const cost = r.estprojectcost ? Number(r.estprojectcost) : NaN;
      const units = r.housingunits ? Number.parseFloat(r.housingunits) : NaN;
      const lat = r.latitude ? Number(r.latitude) : NaN;
      const lng = r.longitude ? Number(r.longitude) : NaN;
      const geometry: { type: "Point"; coordinates: [number, number] } | null =
        Number.isFinite(lat) && Number.isFinite(lng) ? { type: "Point", coordinates: [lng, lat] } : null;
      // WS3c: land-use publishes decisiondate, never issueddate — pick per config
      // so the issued stage + issueDate fire for decided land-use permits without
      // touching building (which keeps using issueddate).
      const issuedDateRaw =
        this.cfg.issuedDateField === "decisiondate" ? (r.decisiondate ?? null) : (r.issueddate ?? null);
      const issued = Boolean(issuedDateRaw);
      const completed = Boolean(r.completeddate);
      const address = [r.originaladdress1, r.originalcity, r.originalzip]
        .filter(Boolean)
        .join(", ");

      // WS3b: the contractor of record (building dataset only; sparse). A
      // contractor company name is business identity — emitted as-is.
      const organizations: NormalizedSourceRecord["organizations"] = [];
      if (r.contractorcompanyname) {
        organizations.push({
          name: r.contractorcompanyname,
          role: "primary_contractor",
          evidenceText: `contractorcompanyname: ${r.contractorcompanyname}`,
        });
      }

      out.push({
        rawFields: parsed.data as Record<string, unknown>,
        record: {
          sourceKey: this.key,
          externalId: r.permitnum,
          recordType: this.cfg.recordType,
          title: `${r.permitnum} – ${r.permittypedesc ?? r.permittypemapped ?? this.cfg.recordType}`,
          description: r.description ?? null,
          permittingJurisdiction: "City of Seattle",
          county: "King",
          city: "Seattle",
          addressRaw: address || null,
          parcelIds: [],
          geometry,
          applicationType: r.permitclassmapped ?? null,
          permitType: r.permittypemapped ?? null,
          documentType: null,
          statusRaw: r.statuscurrent ?? null,
          normalizedStage: this.cfg.stageFor({ issued, completed }),
          applicationDate: r.applieddate ?? null,
          issueDate: issuedDateRaw,
          sourceUpdatedAt: null,
          valuationUsd: Number.isFinite(cost) && cost > 0 ? cost : null,
          units: Number.isFinite(units) && units > 0 ? Math.round(units) : null,
          lots: null,
          squareFeet: null,
          organizations,
          sourceUrl:
            r.link?.url ??
            `https://data.seattle.gov/resource/${this.cfg.datasetId}.json?permitnum=${encodeURIComponent(r.permitnum)}`,
          evidence: [
            {
              factPath: "externalId",
              text: r.permitnum,
              pageOrSection: `dataset ${this.cfg.datasetId}`,
            },
            ...(r.statuscurrent
              ? [
                  {
                    factPath: "statusRaw",
                    text: r.statuscurrent,
                    pageOrSection: "statuscurrent",
                  },
                ]
              : []),
            ...(issuedDateRaw
              ? [
                  {
                    factPath: "issueDate",
                    text: `${this.cfg.issuedDateField}: ${issuedDateRaw}`,
                    pageOrSection: this.cfg.issuedDateField,
                  },
                ]
              : []),
            ...(r.contractorcompanyname
              ? [
                  {
                    factPath: "organizations",
                    text: `contractorcompanyname: ${r.contractorcompanyname}`,
                    pageOrSection: "contractorcompanyname",
                  },
                ]
              : []),
            ...(Number.isFinite(cost) && cost > 0
              ? [
                  {
                    factPath: "valuationUsd",
                    text: `estprojectcost: ${r.estprojectcost}`,
                    pageOrSection: "estprojectcost",
                  },
                ]
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
   * D1 — self-reconciliation for a JSON API. A Socrata column rename/reorder
   * (the datasets are republished nightly) can silently land the wrong value in
   * `cost`/`estprojectcost` or a date field without changing our field-name
   * fingerprint. Value-shape checks catch it at runtime: a valuation must be a
   * plausible non-negative amount, and dates must fall in a sane window. Never
   * fabricates — nulls are skipped.
   */
  checkInvariants(_raw: RawArtifact, parsed: ParsedSourceRecord[]): InvariantViolation[] {
    const out: InvariantViolation[] = [];
    const rec = (p: ParsedSourceRecord) => p.record as NormalizedSourceRecord;
    const v = checkNumericRange(parsed, (p) => rec(p).valuationUsd, {
      min: 0,
      max: 5_000_000_000, // a single Seattle permit above $5B ⇒ a swapped column
      check: "seattle_valuation_range",
    });
    if (v) out.push(v);
    const u = checkNumericRange(parsed, (p) => rec(p).units, {
      min: 0,
      max: 10_000,
      check: "seattle_units_range",
    });
    if (u) out.push(u);
    for (const [field, get] of [
      ["issue", (p: ParsedSourceRecord) => rec(p).issueDate],
      ["application", (p: ParsedSourceRecord) => rec(p).applicationDate],
    ] as const) {
      const d = checkDateWindow(parsed, get, {
        minIso: "2000-01-01",
        maxIso: "2100-01-01",
        check: `seattle_${field}_date_window`,
      });
      if (d) out.push(d);
    }
    return out;
  }
}
