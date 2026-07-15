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
  "https://services6.arcgis.com/ovypB8ighP2NPfFE/arcgis/rest/services/DevelopmentProjectsTumwater/FeatureServer/1";
const LANDING = "https://www.ci.tumwater.wa.us/departments/community-development-department";
const PAGE_SIZE = 2000; // layer maxRecordCount

/**
 * Deterministic stage map from the layer's official DevelopmentStatus
 * coded-value domain (captured in fixtures/tumwater_development_arcgis/
 * layer-metadata.json). Data contains both codes and full names.
 */
const STATUS_STAGE: Record<string, { label: string; stage: NormalizedSourceRecord["normalizedStage"] }> = {
  UC: { label: "Under Construction", stage: "construction" },
  "UNDER CONSTRUCTION": { label: "Under Construction", stage: "construction" },
  RP: { label: "Reviewing Permits", stage: "permit_applied" },
  "REVIEWING PERMITS": { label: "Reviewing Permits", stage: "permit_applied" },
  PA: { label: "Permits Approved", stage: "permit_issued" },
  "PERMITS APPROVED": { label: "Permits Approved", stage: "permit_issued" },
  LUAA: { label: "Land Use Application Approved", stage: "approved" },
  "LAND USE APPLICATION APPROVED": { label: "Land Use Application Approved", stage: "approved" },
  FSPR: { label: "Feasibility Site Plan Review", stage: "preapplication" },
  "FEASIBILITY SITE PLAN REVIEW": { label: "Feasibility Site Plan Review", stage: "preapplication" },
  PAC: { label: "Pre-Application Conference", stage: "preapplication" },
  "PRE-APPLICATION CONFERENCE": { label: "Pre-Application Conference", stage: "preapplication" },
};

const PROJECT_TYPE: Record<string, string> = {
  SF: "Single Family",
  MULTI: "Multifamily",
  MIXED: "Mixed Use",
  COMMERCIAL: "Commercial",
  INDUSTRIAL: "Industrial",
};

const FeatureSchema = z.object({
  attributes: z
    .object({
      OBJECTID: z.number(),
      PermitNumber: z.string().nullable(),
      ProjectType: z.string().nullable(),
      ProjectDescription: z.string().nullable(),
      DevelopmentStatus: z.string().nullable(),
      // Parcel fields arrive as strings OR numbers in the live layer.
      Parcel2: z.union([z.string(), z.number()]).nullable(),
      GlobalID: z.string().min(1),
      created_date: z.number().nullable(),
      last_edited_date: z.number().nullable(),
      PIN1: z.union([z.string(), z.number()]).nullable(),
      PIN2: z.union([z.string(), z.number()]).nullable(),
    })
    .passthrough(),
  geometry: z.object({ x: z.number(), y: z.number() }).optional(),
});

const ResponseSchema = z.object({ features: z.array(z.unknown()) });

/** Web Mercator (EPSG:3857) → WGS84 lon/lat. */
export function webMercatorToLonLat(x: number, y: number): [number, number] {
  const lon = (x / 20037508.34) * 180;
  const lat = ((2 * Math.atan(Math.exp((y / 20037508.34) * Math.PI)) - Math.PI / 2) * 180) / Math.PI;
  return [lon, lat];
}

function epochToIso(ms: number | null): string | null {
  return ms ? new Date(ms).toISOString() : null;
}

/**
 * M1.10 — Tumwater development projects (spec §6.1, P0). The city's public
 * ArcGIS FeatureServer layer of private development projects: permit
 * number(s), type, description, official status domain, parcels, point
 * geometry, created/edited times. Full-snapshot layer (44 features at
 * activation) fetched with bounded paging.
 */
export class TumwaterDevelopmentArcgisAdapter implements SourceAdapter {
  readonly key = "tumwater_development_arcgis";
  readonly parserVersion = "1.0.0";

  private maxEdited = "";

  async discover(ctx: RunContext): Promise<DiscoveredArtifact[]> {
    const countUrl = `${LAYER}/query?where=1%3D1&returnCountOnly=true&f=json`;
    const body = await httpGet(countUrl, ctx);
    const count = Number(JSON.parse(body.toString("utf8"))?.count ?? NaN);
    if (!Number.isFinite(count)) throw new Error("Tumwater ArcGIS count query failed");
    const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
    ctx.logger.info({ count, pages }, "tumwater arcgis snapshot");

    return Array.from({ length: pages }, (_v, i) => {
      const query =
        `where=1%3D1&outFields=*&returnGeometry=true` +
        `&orderByFields=${encodeURIComponent("OBJECTID")}` +
        `&resultOffset=${i * PAGE_SIZE}&resultRecordCount=${PAGE_SIZE}&f=json`;
      return {
        idempotencyKey: `${this.key}:page-${i + 1}`,
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
    if (!this.maxEdited) {
      this.maxEdited = String(ctx.checkpoint?.["lastEditedHighWater"] ?? "");
    }

    for (const entry of parsedBody.features) {
      const parsed = FeatureSchema.safeParse(entry);
      if (!parsed.success) {
        ctx.logger.warn({ entry }, "tumwater feature does not match expected shape");
        out.push({
          record: { sourceKey: this.key, externalId: "" } as never,
          rawFields: (entry ?? {}) as Record<string, unknown>,
        });
        continue;
      }
      const a = parsed.data.attributes;
      const edited = epochToIso(a.last_edited_date);
      if (edited && edited > this.maxEdited) this.maxEdited = edited;

      if (ctx.backfill && edited) {
        const d = edited.slice(0, 10);
        if (d < ctx.backfill.from || d > ctx.backfill.to) continue;
      }

      const statusKey = a.DevelopmentStatus?.trim().toUpperCase() ?? "";
      const status = STATUS_STAGE[statusKey] ?? null;
      if (a.DevelopmentStatus && !status) {
        ctx.logger.warn(
          { status: a.DevelopmentStatus },
          "unknown DevelopmentStatus code — stage left unknown; domain may have changed",
        );
      }

      const permitNumbers = (a.PermitNumber ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const parcelIds = [a.PIN1, a.PIN2, a.Parcel2]
        .map((p) => (p === null ? "" : String(p).trim()))
        .filter(Boolean);
      const geometry: { type: "Point"; coordinates: [number, number] } | null = parsed.data
        .geometry
        ? { type: "Point", coordinates: webMercatorToLonLat(parsed.data.geometry.x, parsed.data.geometry.y) }
        : null;
      const typeKey = a.ProjectType?.trim().toUpperCase() ?? "";
      const projectType = PROJECT_TYPE[typeKey] ?? a.ProjectType ?? null;

      out.push({
        rawFields: {
          ...a,
          permitNumbers,
          createdDate: epochToIso(a.created_date),
          lastEditedDate: edited,
        },
        record: {
          sourceKey: this.key,
          externalId: a.GlobalID,
          recordType: "development_project",
          title: `${permitNumbers[0] ?? `Tumwater project ${a.OBJECTID}`}${a.ProjectDescription ? ` – ${a.ProjectDescription.split(" - ")[0]}` : ""}`,
          description: a.ProjectDescription,
          permittingJurisdiction: "City of Tumwater",
          county: "Thurston",
          city: "Tumwater",
          addressRaw: null,
          parcelIds,
          geometry,
          applicationType: projectType,
          permitType: null,
          documentType: null,
          statusRaw: status?.label ?? a.DevelopmentStatus,
          normalizedStage: status?.stage ?? "unknown",
          applicationDate: null,
          issueDate: null,
          sourceUpdatedAt: edited,
          valuationUsd: null,
          units: null,
          lots: null,
          squareFeet: null,
          organizations: [],
          sourceUrl: `${LAYER}/query?where=${encodeURIComponent(`GlobalID='${a.GlobalID}'`)}&outFields=*&f=json`,
          evidence: [
            {
              factPath: "title",
              text: `${a.PermitNumber ?? `OBJECTID ${a.OBJECTID}`}: ${a.ProjectDescription ?? ""}`.trim(),
              pageOrSection: "DevelopmentProjectsTumwater layer 1",
            },
            ...(status
              ? [
                  {
                    factPath: "statusRaw",
                    text: `DevelopmentStatus: ${a.DevelopmentStatus} (${status.label})`,
                    pageOrSection: "DevelopmentStatus field (official domain)",
                  },
                ]
              : []),
            ...parcelIds.map((p) => ({
              factPath: "parcelIds",
              text: `parcel ${p}`,
              pageOrSection: "PIN1/PIN2/Parcel2 fields",
            })),
          ],
        },
      });
    }

    if (this.maxEdited && !ctx.backfill) {
      ctx.setCheckpoint({ lastEditedHighWater: this.maxEdited });
    }
    return out;
  }
}
