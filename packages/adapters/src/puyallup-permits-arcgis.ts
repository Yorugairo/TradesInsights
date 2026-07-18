import { z } from "zod";
import type { NormalizedSourceRecord } from "@otn/domain";
import type {
  DiscoveredArtifact,
  ParsedSourceRecord,
  RawArtifact,
  RunContext,
  SourceAdapter,
} from "@otn/source-sdk";
import { httpFetchArtifact, httpGet } from "@otn/source-sdk";

/**
 * City of Puyallup permits (official "Permit Viewer" layer on the city's
 * public ArcGIS org — services8.arcgis.com/5K6vnOH0GkPyJs6A, org identity
 * "City of Puyallup" verified 2026-07-17). Puyallup is the largest Pierce
 * suburb and a Solis home-market SFR gap: neither the PALS extract
 * (unincorporated only) nor Tacoma's Accela extract covers it. 25,595 rows
 * back to 2008 incl. "Residential - New Single Family Dwelling" (×1,484),
 * remodels, commercial TI, and Pre-Application cases; refreshed periodically
 * (max ApplicationDate within days of capture).
 *
 * No valuation field exists — FeeAmount is PERMIT FEES, never a project
 * valuation, and stays in rawFields only (unknown is null, never guessed).
 */

const LAYER =
  "https://services8.arcgis.com/5K6vnOH0GkPyJs6A/arcgis/rest/services/City_View/FeatureServer/0";
const LANDING = "https://experience.arcgis.com/experience/cde5b0c96ea24ef89ebec30da40d93a9";
const PAGE_SIZE = 2000;
/** Wider than the county adapters: IssueDate is a STRING field in this layer
 * (mixed "MM/DD/YYYY"/epoch values — cannot be windowed server-side), so
 * issuance updates are caught only while the APPLICATION date is in-window.
 * 210 days covers Puyallup's typical review cycles with margin. */
const WINDOW_DAYS = 210;

/** Planning-class permit types; Pre-Application pins to `preapplication`. */
const PLANNING_TYPE_RE = /^(pre-application|land use|sepa|plat|binding site)/i;
const PREAPP_TYPE_RE = /^pre-application/i;

/**
 * Official CurrentStatus vocabulary → §9 stages, enumerated live 2026-07-17
 * (fixtures/puyallup_permits_arcgis/metadata.json). statusRaw always
 * preserves the source value; unknown statuses map to "unknown", never
 * guessed. "Closed"/"File Closed" on a permit file reads as work complete —
 * the same treatment as Tacoma's Accela "Closed".
 */
export function puyallupStage(
  status: string | null,
  kind: "permit" | "planning" | "preapp",
): NormalizedSourceRecord["normalizedStage"] {
  const s = (status ?? "").trim().toLowerCase();
  if (!s) return kind === "preapp" ? "preapplication" : "unknown";
  if (/^(void|withdrawn|cancell?ed|denied|expired)/.test(s)) return "withdrawn";
  if (kind === "preapp") return "preapplication"; // case lifecycle ≠ project lifecycle
  if (/^(finaled|closed|file closed)/.test(s)) return "complete";
  if (/^(permit\(s\) issued|issued)/.test(s)) return "permit_issued";
  if (/^(approved|administrative approval|ready for issuance)/.test(s)) return "approved";
  if (
    /^(in plan check|under review|complete application|waiting for|submittals incomplete|returned for correction|pending|open)/.test(
      s,
    )
  ) {
    return kind === "planning" ? "entitlement" : "permit_applied";
  }
  return "unknown";
}

const FeatureSchema = z.object({
  attributes: z
    .object({
      OBJECTID: z.number(),
      PermitNumber: z.string().min(1),
      ParcelNumber: z.string().nullable(),
      PermitType: z.string().nullable(),
      PermitCategory: z.string().nullable(),
      PermitAddress: z.string().nullable(),
      PermitDescription: z.string().nullable(),
      ApplicationDate: z.number().nullable(),
      // The layer mixes types on these: epoch ms on some rows, "MM/DD/YYYY"
      // strings on others (observed live 2026-07-17, 530/1175 strings).
      IssueDate: z.union([z.number(), z.string()]).nullable(),
      ClosedDate: z.union([z.number(), z.string()]).nullable(),
      CurrentStatus: z.string().nullable(),
      PermitStatus: z.string().nullable(),
      WebLink: z.string().nullable(),
    })
    .passthrough(),
  geometry: z.object({ x: z.number(), y: z.number() }).nullish(),
});

const ResponseSchema = z.object({ features: z.array(z.unknown()) });

function epochToIso(ms: number | null | undefined): string | null {
  return ms ? new Date(ms).toISOString() : null;
}

/** Mixed-type date field → ISO date string. Epoch ms or "MM/DD/YYYY";
 * anything else is unknown → null, never guessed. */
function mixedDateToIso(v: number | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return epochToIso(v);
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v.trim());
  return m ? `${m[3]}-${m[1]}-${m[2]}T00:00:00.000Z` : null;
}

/** ArcGIS SQL timestamp literal for a UTC date. */
function tsLiteral(d: Date): string {
  return `TIMESTAMP '${d.toISOString().slice(0, 19).replace("T", " ")}'`;
}

export class PuyallupPermitsArcgisAdapter implements SourceAdapter {
  readonly key = "puyallup_permits_arcgis";
  readonly parserVersion = "1.0.0";

  private windowWhere(ctx: RunContext): string {
    if (ctx.backfill) {
      return (
        `ApplicationDate >= ${tsLiteral(new Date(`${ctx.backfill.from}T00:00:00Z`))}` +
        ` AND ApplicationDate <= ${tsLiteral(new Date(`${ctx.backfill.to}T23:59:59Z`))}`
      );
    }
    // Quantized to the UTC day so same-day reruns produce identical query
    // URLs → identical page bytes dedupe on the unchanged-hash path. Windowed
    // on the two typed-date fields only (IssueDate is a string column).
    const since = new Date(
      Math.floor((Date.now() - WINDOW_DAYS * 86_400_000) / 86_400_000) * 86_400_000,
    );
    return `ApplicationDate >= ${tsLiteral(since)} OR ClosedDate >= ${tsLiteral(since)}`;
  }

  async discover(ctx: RunContext): Promise<DiscoveredArtifact[]> {
    const where = this.windowWhere(ctx);
    const countUrl = `${LAYER}/query?where=${encodeURIComponent(where)}&returnCountOnly=true&f=json`;
    const body = await httpGet(countUrl, ctx);
    const count = Number(JSON.parse(body.toString("utf8"))?.count ?? NaN);
    if (!Number.isFinite(count)) throw new Error("Puyallup ArcGIS count query failed");
    const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
    ctx.logger.info({ count, pages, where }, "puyallup arcgis window");

    return Array.from({ length: pages }, (_v, i) => {
      const query =
        `where=${encodeURIComponent(where)}&outFields=*&returnGeometry=true&outSR=4326` +
        `&orderByFields=${encodeURIComponent("OBJECTID ASC")}` +
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
        ctx.logger.warn({ entry }, "puyallup feature does not match expected shape");
        out.push({
          record: { sourceKey: this.key, externalId: "" } as never,
          rawFields: (entry ?? {}) as Record<string, unknown>,
        });
        continue;
      }
      const a = parsed.data.attributes;
      const isPreapp = PREAPP_TYPE_RE.test(a.PermitType ?? "");
      const isPlanning = PLANNING_TYPE_RE.test(a.PermitType ?? "");
      const stage = puyallupStage(
        a.CurrentStatus,
        isPreapp ? "preapp" : isPlanning ? "planning" : "permit",
      );
      if (stage === "unknown" && a.CurrentStatus) {
        ctx.logger.warn(
          { status: a.CurrentStatus },
          "unmapped Puyallup CurrentStatus — stage left unknown",
        );
      }
      const geometry: { type: "Point"; coordinates: [number, number] } | null = parsed.data
        .geometry
        ? { type: "Point", coordinates: [parsed.data.geometry.x, parsed.data.geometry.y] }
        : null;
      const title = `${a.PermitNumber} – ${a.PermitType?.trim() || "Puyallup permit"}`;

      out.push({
        rawFields: {
          ...a,
          ApplicationDateIso: epochToIso(a.ApplicationDate),
          IssueDateIso: mixedDateToIso(a.IssueDate),
          ClosedDateIso: mixedDateToIso(a.ClosedDate),
        },
        record: {
          sourceKey: this.key,
          externalId: a.PermitNumber,
          recordType: isPlanning ? "planning_application" : "building_permit",
          title,
          description: a.PermitDescription,
          permittingJurisdiction: "City of Puyallup",
          county: "Pierce",
          city: "Puyallup",
          addressRaw: a.PermitAddress,
          parcelIds: a.ParcelNumber ? [a.ParcelNumber.trim()] : [],
          geometry,
          applicationType: a.PermitType,
          permitType: a.PermitCategory,
          documentType: null,
          statusRaw: a.CurrentStatus,
          normalizedStage: stage,
          applicationDate: epochToIso(a.ApplicationDate)?.slice(0, 10) ?? null,
          issueDate: mixedDateToIso(a.IssueDate)?.slice(0, 10) ?? null,
          sourceUpdatedAt: null,
          // FeeAmount is permit FEES, never a valuation — both stay null.
          valuationUsd: null,
          units: null,
          lots: null,
          squareFeet: null,
          organizations: [],
          sourceUrl: a.WebLink ?? LANDING,
          evidence: [
            {
              factPath: "title",
              text: `${a.PermitNumber} ${a.PermitType ?? ""}: ${a.PermitDescription ?? ""}`.trim(),
              pageOrSection: "City_View Permits layer 0",
            },
            ...(a.CurrentStatus
              ? [
                  {
                    factPath: "statusRaw",
                    text: `CurrentStatus: ${a.CurrentStatus}`,
                    pageOrSection: "CurrentStatus field",
                  },
                ]
              : []),
            ...(a.ParcelNumber
              ? [
                  {
                    factPath: "parcelIds",
                    text: `parcel ${a.ParcelNumber.trim()}`,
                    pageOrSection: "ParcelNumber field",
                  },
                ]
              : []),
            ...(mixedDateToIso(a.IssueDate)
              ? [
                  {
                    factPath: "issueDate",
                    text: `IssueDate: ${mixedDateToIso(a.IssueDate)}`,
                    pageOrSection: "IssueDate field",
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
