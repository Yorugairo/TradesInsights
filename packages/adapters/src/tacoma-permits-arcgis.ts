import { z } from "zod";
import {
  httpFetchArtifact,
  httpGet,
  type DiscoveredArtifact,
  type ParsedSourceRecord,
  type RawArtifact,
  type RunContext,
  type SourceAdapter,
} from "@otn/source-sdk";
import type { NormalizedSourceRecord } from "@otn/domain";

const LAYER =
  "https://services3.arcgis.com/SCwJH1pD8WSn5T5y/arcgis/rest/services/accela_permit_data/FeatureServer/0";
const LANDING = "https://tacomaopendata-tacoma.hub.arcgis.com/";
const PAGE_SIZE = 1000; // layer maxRecordCount (verified 2026-07-17)
const WINDOW_DAYS = 120;

/** Planning/entitlement permit types (Accela permit_type, enumerated live). */
const PLANNING_TYPE_RE = /^(land use|pre-application)/i;
/** Pre-application cases: the case's own workflow statuses never advance the
 * PROJECT past `preapplication` (a "Decision Issued" pre-app meeting is still
 * a pre-application-stage project). Same defect class as Pierce, fixed 2026-07-17. */
const PREAPP_TYPE_RE = /^pre-application/i;

/**
 * Accela workflow current_status → §9 stage, mapped by deterministic pattern
 * buckets over the live status vocabulary (52 values enumerated 2026-07-17,
 * fixtures/tacoma_permits_arcgis/metadata.json). statusRaw always preserves
 * the source value; anything unmatched maps to "unknown", never guessed.
 */
export function tacomaStage(
  status: string | null,
  kind: "permit" | "planning" | "preapp",
): NormalizedSourceRecord["normalizedStage"] {
  const s = (status ?? "").trim().toLowerCase();
  if (!s) return kind === "preapp" ? "preapplication" : "unknown";
  if (/^(cancelled|permit canceled|voided|denied|expired|withdrawn)/.test(s)) return "withdrawn";
  if (kind === "preapp") return "preapplication"; // case lifecycle ≠ project lifecycle
  if (/^(finaled|closed|financial closeout|recording complete|c of o issued)/.test(s)) {
    return "complete";
  }
  if (/^(final inspection)/.test(s)) return "near_final";
  if (/^permit issued$/.test(s)) return "permit_issued";
  if (/^(approved|decision issued|final decision|staff report complete)/.test(s)) return "approved";
  if (
    /^(awaiting|plan review|plans routed|complete application|incomplete|pending|comments|electronic review|in review|missing|meeting|review|revision|consultation|precon|waiting|correction|initial billing|ready to issue|permit ready to issue|permit fees due|decision pending|field revisions|active)/.test(
      s,
    )
  ) {
    // The whole pre-issuance review pipeline: an application being worked.
    return kind === "planning" ? "entitlement" : "permit_applied";
  }
  return "unknown";
}

const FeatureSchema = z.object({
  attributes: z
    .object({
      objectid: z.number(),
      permit_number: z.string().min(1),
      permit_type: z.string().nullable(),
      permit_subtype: z.string().nullable(),
      permit_category: z.string().nullable(),
      current_status: z.string().nullable(),
      application_date: z.number().nullable(),
      issued_date: z.number().nullable(),
      applicant_name: z.string().nullable(),
      address_line_1: z.string().nullable(),
      address_line_2: z.string().nullable(),
      description: z.string().nullable(),
      latitude: z.number().nullable(),
      longitude: z.number().nullable(),
      parcel_number: z.string().nullable(),
      valuation: z.number().nullable(),
      housing_units: z.number().nullable(),
      link: z.string().nullable(),
      pull_date: z.number().nullable(),
    })
    .passthrough(),
  geometry: z.object({ x: z.number(), y: z.number() }).nullish(),
});

const ResponseSchema = z.object({ features: z.array(z.unknown()) });

function epochToIso(ms: number | null | undefined): string | null {
  return ms ? new Date(ms).toISOString() : null;
}

function tsLiteral(d: Date): string {
  return `TIMESTAMP '${d.toISOString().slice(0, 19).replace("T", " ")}'`;
}

/**
 * City of Tacoma permits & applications (Accela extract on the city's public
 * ArcGIS org — services3.arcgis.com/SCwJH1pD8WSn5T5y, Tacoma Open Data;
 * verified 2026-07-17). Pierce County's PALS layer covers unincorporated
 * Pierce only — Tacoma, the pilot region's second-largest city, permits
 * through Accela and publishes this extract daily (pull_date). Same
 * trailing-window pattern as pierce_permits_arcgis; issuance updates the
 * same record → applyRecordUpdates emits the stage change.
 */
export class TacomaPermitsArcgisAdapter implements SourceAdapter {
  readonly key = "tacoma_permits_arcgis";
  // 1.1.0 — pre-application cases pin to `preapplication` (case workflow no
  // longer walks the project stages).
  readonly parserVersion = "1.1.0";

  private windowWhere(ctx: RunContext): string {
    if (ctx.backfill) {
      return (
        `application_date >= ${tsLiteral(new Date(`${ctx.backfill.from}T00:00:00Z`))}` +
        ` AND application_date <= ${tsLiteral(new Date(`${ctx.backfill.to}T23:59:59Z`))}`
      );
    }
    const since = new Date(
      Math.floor((Date.now() - WINDOW_DAYS * 86_400_000) / 86_400_000) * 86_400_000,
    );
    return `application_date >= ${tsLiteral(since)} OR issued_date >= ${tsLiteral(since)}`;
  }

  async discover(ctx: RunContext): Promise<DiscoveredArtifact[]> {
    const where = this.windowWhere(ctx);
    const countUrl = `${LAYER}/query?where=${encodeURIComponent(where)}&returnCountOnly=true&f=json`;
    const body = await httpGet(countUrl, ctx);
    const count = Number(JSON.parse(body.toString("utf8"))?.count ?? NaN);
    if (!Number.isFinite(count)) throw new Error("Tacoma ArcGIS count query failed");
    const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
    ctx.logger.info({ count, pages, where }, "tacoma arcgis window");

    return Array.from({ length: pages }, (_v, i) => {
      const query =
        `where=${encodeURIComponent(where)}&outFields=*&returnGeometry=true&outSR=4326` +
        `&orderByFields=${encodeURIComponent("objectid ASC")}` +
        `&resultOffset=${i * PAGE_SIZE}&resultRecordCount=${PAGE_SIZE}&f=json`;
      return {
        idempotencyKey: `${this.key}:${ctx.backfill ? `backfill-${ctx.backfill.from}-${ctx.backfill.to}` : "window"}:page-${i + 1}`,
        canonicalUrl: `${LAYER}/query?${query}`,
        parentUrl: LANDING,
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
    const out: ParsedSourceRecord[] = [];

    for (const entry of parsedBody.features) {
      const parsed = FeatureSchema.safeParse(entry);
      if (!parsed.success) {
        ctx.logger.warn({ entry }, "tacoma feature does not match expected shape");
        out.push({
          record: { sourceKey: this.key, externalId: "" } as never,
          rawFields: (entry ?? {}) as Record<string, unknown>,
        });
        continue;
      }
      const a = parsed.data.attributes;
      const isPreapp = PREAPP_TYPE_RE.test(a.permit_type ?? "");
      const isPlanning = PLANNING_TYPE_RE.test(a.permit_type ?? "");
      const stage = tacomaStage(a.current_status, isPreapp ? "preapp" : isPlanning ? "planning" : "permit");
      if (stage === "unknown" && a.current_status) {
        ctx.logger.warn(
          { status: a.current_status },
          "unmapped Accela current_status — stage left unknown",
        );
      }
      const point =
        parsed.data.geometry ??
        (a.longitude !== null && a.latitude !== null ? { x: a.longitude, y: a.latitude } : null);
      const geometry: { type: "Point"; coordinates: [number, number] } | null = point
        ? { type: "Point", coordinates: [point.x, point.y] }
        : null;
      // Accela exports 0 valuation/units for "not stated" — unknown is null.
      const valuation = a.valuation !== null && a.valuation > 0 ? a.valuation : null;
      const units =
        a.housing_units !== null && Number.isInteger(a.housing_units) && a.housing_units > 0
          ? a.housing_units
          : null;
      const address = [a.address_line_1, a.address_line_2].filter(Boolean).join(", ") || null;
      const typeLabel = [a.permit_type, a.permit_subtype, a.permit_category]
        .filter(Boolean)
        .join(" / ");
      const link = a.link ? a.link.replace(/&amp;/g, "&") : null;

      out.push({
        rawFields: {
          ...a,
          applicationDateIso: epochToIso(a.application_date),
          issuedDateIso: epochToIso(a.issued_date),
          pullDateIso: epochToIso(a.pull_date),
        },
        record: {
          sourceKey: this.key,
          externalId: a.permit_number,
          recordType: isPlanning ? "planning_application" : "building_permit",
          title: `${a.permit_number} – ${(a.description ?? typeLabel ?? "Tacoma permit").slice(0, 120)}`,
          description: a.description,
          permittingJurisdiction: "City of Tacoma",
          county: "Pierce",
          city: "Tacoma",
          addressRaw: address,
          parcelIds: a.parcel_number ? [a.parcel_number.trim()] : [],
          geometry,
          applicationType: typeLabel || null,
          permitType: a.permit_type,
          documentType: null,
          statusRaw: a.current_status,
          normalizedStage: stage,
          applicationDate: epochToIso(a.application_date)?.slice(0, 10) ?? null,
          issueDate: epochToIso(a.issued_date)?.slice(0, 10) ?? null,
          sourceUpdatedAt: epochToIso(a.pull_date),
          valuationUsd: valuation,
          units,
          lots: null,
          squareFeet: null,
          organizations: a.applicant_name
            ? [
                {
                  name: a.applicant_name,
                  role: "applicant",
                  evidenceText: `applicant_name: ${a.applicant_name}`,
                },
              ]
            : [],
          sourceUrl: link ?? `${LANDING}datasets/accela-permit-data`,
          evidence: [
            {
              factPath: "title",
              text: `${a.permit_number} ${typeLabel}: ${a.description ?? ""}`.trim(),
              pageOrSection: "accela_permit_data layer 0",
            },
            ...(a.current_status
              ? [
                  {
                    factPath: "statusRaw",
                    text: `current_status: ${a.current_status}`,
                    pageOrSection: "current_status field",
                  },
                ]
              : []),
            ...(valuation !== null
              ? [
                  {
                    factPath: "valuationUsd",
                    text: `valuation ${valuation}`,
                    pageOrSection: "valuation field",
                  },
                ]
              : []),
            ...(a.parcel_number
              ? [
                  {
                    factPath: "parcelIds",
                    text: `parcel ${a.parcel_number.trim()}`,
                    pageOrSection: "parcel_number field",
                  },
                ]
              : []),
          ],
        },
      });
    }
    return out;
  }
}
