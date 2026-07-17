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
  "https://services2.arcgis.com/1UvBaQ5y1ubjUPmd/arcgis/rest/services/Permits_Pierce_County/FeatureServer/0";
const LANDING = "https://gisdata-piercecowa.opendata.arcgis.com/";
const PAGE_SIZE = 2000; // layer maxRecordCount (verified 2026-07-17)
/** Trailing fetch window: new applications AND status changes (issuance) are
 * both discovered by re-fetching the window; content updates on known records
 * flow through the runner's fingerprint diff → applyRecordUpdates. */
const WINDOW_DAYS = 120;

/**
 * Entitlement-vs-permit record class from the county's applicationType. Types
 * that are planning/land-use actions become planning applications
 * (application_submitted events, entitlement-stage radar); everything else is
 * a permit-lifecycle record.
 */
const PLANNING_TYPE_RE =
  /^(land use|land div|pre-application|sepa|shoreline|forest practice|environmental variance|deviation|appeals)/i;
/** Pre-application screenings: the SCREENING's own lifecycle (accepted →
 * approved → final) says nothing about project maturity — an "approved"
 * pre-app screening is still a pre-application-stage project. Mapping those
 * statuses through the permit lifecycle overstated 400+ projects (found
 * 2026-07-17); the whole case class pins to `preapplication`. */
const PREAPP_TYPE_RE = /^pre-application/i;

/**
 * Official PALS applicationStatus values → spec §9 stages, enumerated live
 * 2026-07-17 (fixtures/pierce_permits_arcgis/metadata.json). statusRaw always
 * preserves the source value; unknown statuses map to "unknown", never
 * guessed.
 */
function stageFor(
  status: string | null,
  kind: "permit" | "planning" | "preapp",
): NormalizedSourceRecord["normalizedStage"] {
  const s = (status ?? "").trim().toLowerCase();
  if (s === "cancelled" || s === "denied" || s.startsWith("expired")) return "withdrawn";
  if (kind === "preapp") return "preapplication"; // screening lifecycle ≠ project lifecycle
  if (s === "accepted" || s === "pending payment") {
    return kind === "planning" ? "entitlement" : "permit_applied";
  }
  if (s === "approved") return "approved";
  if (s === "issued" || s === "issued (nca)") return "permit_issued";
  if (s === "final") return "complete";
  return "unknown"; // Closed / Stopped / Suspended* / anything new
}

const FeatureSchema = z.object({
  attributes: z
    .object({
      applicationNumber: z.number(),
      applicationType: z.string().nullable(),
      applicationStatus: z.string().nullable(),
      parcelNumber: z.string().nullable(),
      workType: z.string().nullable(),
      buildingValuation: z.number().nullable(),
      projectValue: z.number().nullable(),
      dwellingUnits: z.string().nullable(),
      applicationDate: z.number().nullable(),
      submittalDate: z.number().nullable(),
      issuedDate: z.number().nullable(),
      finalDate: z.number().nullable(),
      workDescription: z.string().nullable(),
      siteAddress: z.string().nullable(),
      projectName: z.string().nullable(),
      urlOnlinePermits: z.string().nullable(),
      applicationDept: z.string().nullable(),
      lotsSubmitted: z.string().nullable(),
      sqFtTotal: z.number().nullable(),
    })
    .passthrough(),
  geometry: z.object({ x: z.number(), y: z.number() }).nullish(),
});

const ResponseSchema = z.object({ features: z.array(z.unknown()) });

function epochToIso(ms: number | null | undefined): string | null {
  return ms ? new Date(ms).toISOString() : null;
}

function intOrNull(s: string | null): number | null {
  if (s === null) return null;
  const n = Number(s.trim());
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** ArcGIS SQL timestamp literal for a UTC date. */
function tsLiteral(d: Date): string {
  return `TIMESTAMP '${d.toISOString().slice(0, 19).replace("T", " ")}'`;
}

/**
 * Pierce County permits & applications (PALS extract on the county's public
 * ArcGIS org — services2.arcgis.com/1UvBaQ5y1ubjUPmd, verified 2026-07-17).
 * The county's main website sits behind a Cloudflare challenge (M1.4 blocker)
 * but this official open-data layer is a documented public API: every PALS
 * application/permit with type, status, dates, parcel, valuation, dwelling
 * units, WGS84 point, and a canonical PALS deep link per record.
 *
 * Discovery fetches a bounded trailing window on applicationDate OR
 * issuedDate — new applications appear pre-issuance (entitlement/applied
 * radar for a county with zero prior permit coverage) and later issuance
 * updates the same record, which applyRecordUpdates turns into a
 * stage-change event.
 */
export class PiercePermitsArcgisAdapter implements SourceAdapter {
  readonly key = "pierce_permits_arcgis";
  // 1.1.0 — pre-application screenings pin to `preapplication` (their own
  // accepted/approved/final lifecycle no longer walks the permit stages).
  readonly parserVersion = "1.1.0";

  private windowWhere(ctx: RunContext): string {
    if (ctx.backfill) {
      return (
        `applicationDate >= ${tsLiteral(new Date(`${ctx.backfill.from}T00:00:00Z`))}` +
        ` AND applicationDate <= ${tsLiteral(new Date(`${ctx.backfill.to}T23:59:59Z`))}`
      );
    }
    // Quantized to the UTC day so same-day reruns produce identical query
    // URLs → identical page bytes dedupe on the unchanged-hash path.
    const since = new Date(
      Math.floor((Date.now() - WINDOW_DAYS * 86_400_000) / 86_400_000) * 86_400_000,
    );
    return `applicationDate >= ${tsLiteral(since)} OR issuedDate >= ${tsLiteral(since)}`;
  }

  async discover(ctx: RunContext): Promise<DiscoveredArtifact[]> {
    const where = this.windowWhere(ctx);
    const countUrl = `${LAYER}/query?where=${encodeURIComponent(where)}&returnCountOnly=true&f=json`;
    const body = await httpGet(countUrl, ctx);
    const count = Number(JSON.parse(body.toString("utf8"))?.count ?? NaN);
    if (!Number.isFinite(count)) throw new Error("Pierce ArcGIS count query failed");
    const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
    ctx.logger.info({ count, pages, where }, "pierce arcgis window");

    return Array.from({ length: pages }, (_v, i) => {
      const query =
        `where=${encodeURIComponent(where)}&outFields=*&returnGeometry=true&outSR=4326` +
        `&orderByFields=${encodeURIComponent("applicationNumber ASC")}` +
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
        ctx.logger.warn({ entry }, "pierce feature does not match expected shape");
        out.push({
          record: { sourceKey: this.key, externalId: "" } as never,
          rawFields: (entry ?? {}) as Record<string, unknown>,
        });
        continue;
      }
      const a = parsed.data.attributes;
      const isPreapp = PREAPP_TYPE_RE.test(a.applicationType ?? "");
      const isPlanning = PLANNING_TYPE_RE.test(a.applicationType ?? "");
      const stage = stageFor(a.applicationStatus, isPreapp ? "preapp" : isPlanning ? "planning" : "permit");
      if (stage === "unknown" && a.applicationStatus) {
        ctx.logger.warn(
          { status: a.applicationStatus },
          "unmapped PALS applicationStatus — stage left unknown",
        );
      }
      const geometry: { type: "Point"; coordinates: [number, number] } | null = parsed.data
        .geometry
        ? { type: "Point", coordinates: [parsed.data.geometry.x, parsed.data.geometry.y] }
        : null;
      // PALS exports 0 for "no valuation stated" — that is an unknown, not a
      // real $0 job (spec: unknown is null, never zero).
      const positive = (n: number | null): number | null => (n !== null && n > 0 ? n : null);
      const valuation = positive(a.buildingValuation) ?? positive(a.projectValue);
      const title = `${a.applicationNumber} – ${a.projectName?.trim() || a.applicationType || "Pierce County application"}`;

      out.push({
        rawFields: {
          ...a,
          applicationDateIso: epochToIso(a.applicationDate),
          submittalDateIso: epochToIso(a.submittalDate),
          issuedDateIso: epochToIso(a.issuedDate),
          finalDateIso: epochToIso(a.finalDate),
        },
        record: {
          sourceKey: this.key,
          externalId: String(a.applicationNumber),
          recordType: isPlanning ? "planning_application" : "building_permit",
          title,
          description: a.workDescription,
          permittingJurisdiction: "Pierce County",
          county: "Pierce",
          city: null,
          addressRaw: a.siteAddress,
          parcelIds: a.parcelNumber ? [a.parcelNumber.trim()] : [],
          geometry,
          applicationType: a.applicationType,
          permitType: a.workType,
          documentType: null,
          statusRaw: a.applicationStatus,
          normalizedStage: stage,
          applicationDate: (epochToIso(a.applicationDate) ?? epochToIso(a.submittalDate))?.slice(0, 10) ?? null,
          issueDate: epochToIso(a.issuedDate)?.slice(0, 10) ?? null,
          sourceUpdatedAt: null,
          valuationUsd: valuation,
          units: intOrNull(a.dwellingUnits),
          lots: intOrNull(a.lotsSubmitted),
          squareFeet: a.sqFtTotal,
          organizations: [],
          sourceUrl:
            a.urlOnlinePermits ??
            `https://pals.piercecountywa.gov/palsonline/#/permitSearch/permit/departmentStatus?applPermitId=${a.applicationNumber}`,
          evidence: [
            {
              factPath: "title",
              text: `${a.applicationNumber} ${a.applicationType ?? ""}: ${a.workDescription ?? a.projectName ?? ""}`.trim(),
              pageOrSection: "Permits_Pierce_County layer 0",
            },
            ...(a.applicationStatus
              ? [
                  {
                    factPath: "statusRaw",
                    text: `applicationStatus: ${a.applicationStatus}`,
                    pageOrSection: "applicationStatus field",
                  },
                ]
              : []),
            ...(valuation !== null
              ? [
                  {
                    factPath: "valuationUsd",
                    text: `valuation ${valuation}`,
                    pageOrSection: a.buildingValuation !== null ? "buildingValuation field" : "projectValue field",
                  },
                ]
              : []),
            ...(a.parcelNumber
              ? [
                  {
                    factPath: "parcelIds",
                    text: `parcel ${a.parcelNumber.trim()}`,
                    pageOrSection: "parcelNumber field",
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
