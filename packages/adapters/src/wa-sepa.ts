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

/**
 * M1.8 — Washington SEPA register (spec §6.5, P0). The Department of
 * Ecology publishes the SEPA register as an official Socrata dataset on
 * data.wa.gov (mmcb-z6jf, provenance "official", attribution WA Ecology) —
 * the documented-API discovery preference; the separ search UI is robots-
 * restricted (/separ/*?*) and is only cited as the per-record link target.
 */
const DATASET = "mmcb-z6jf";
const BASE = `https://data.wa.gov/resource/${DATASET}.json`;
const PAGE_SIZE = 1000;
const OVERLAP_DAYS = 14;
const DEFAULT_WINDOW_DAYS = 120;

/** Pilot counties (spec §1) as the dataset spells them. */
const COUNTIES = ["THURSTON", "PIERCE", "LEWIS", "KING"] as const;

const COUNTY_MAP: Record<string, NormalizedSourceRecord["county"]> = {
  THURSTON: "Thurston",
  PIERCE: "Pierce",
  LEWIS: "Lewis",
  KING: "King",
};

const SepaRowSchema = z
  .object({
    separegisterid: z.string().min(1),
    sepanumber: z.string().min(1),
    proposalname: z.string().optional(),
    proposaltypename: z.string().optional(),
    proposaldescription: z.string().optional(),
    leadagencyname: z.string().optional(),
    leadagencyfilenumber: z.string().optional(),
    leadagencyissuedate: z.string().optional(),
    applicantname: z.string().optional(),
    documenttypecode: z.string().optional(),
    countyname: z.string(),
    regionname: z.string().optional(),
    commentsduedate: z.string().optional(),
    separegisterlink: z.object({ url: z.string() }).optional(),
  })
  .passthrough();

export class WaSepaAdapter implements SourceAdapter {
  readonly key = "wa_sepa";
  readonly parserVersion = "1.0.0";

  private maxIssue = "";

  private windowFor(ctx: RunContext): { from: string; to: string | null } {
    if (ctx.backfill) return { from: ctx.backfill.from, to: ctx.backfill.to };
    const highWater = String(ctx.checkpoint?.["issueDateHighWater"] ?? "");
    const from = highWater
      ? new Date(Date.parse(highWater.slice(0, 10)) - OVERLAP_DAYS * 86_400_000)
      : new Date(Date.now() - DEFAULT_WINDOW_DAYS * 86_400_000);
    return { from: from.toISOString().slice(0, 10), to: null };
  }

  private whereClause(w: { from: string; to: string | null }): string {
    const counties = COUNTIES.map((c) => `'${c}'`).join(",");
    const parts = [
      `countyname in(${counties})`,
      `leadagencyissuedate >= '${w.from}T00:00:00'`,
    ];
    if (w.to) parts.push(`leadagencyissuedate <= '${w.to}T23:59:59'`);
    return parts.join(" AND ");
  }

  async discover(ctx: RunContext): Promise<DiscoveredArtifact[]> {
    const w = this.windowFor(ctx);
    const where = this.whereClause(w);
    const countUrl = `${BASE}?$select=count(*)&$where=${encodeURIComponent(where)}`;
    const body = await httpGet(countUrl, ctx);
    const count = Number(JSON.parse(body.toString("utf8"))?.[0]?.count ?? NaN);
    if (!Number.isFinite(count)) throw new Error("SEPA register count query failed");
    const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
    ctx.logger.info({ count, pages, window: w }, "sepa register window");

    return Array.from({ length: pages }, (_v, i) => {
      const query =
        `$where=${encodeURIComponent(where)}` +
        `&$order=${encodeURIComponent("leadagencyissuedate, separegisterid")}` +
        `&$limit=${PAGE_SIZE}&$offset=${i * PAGE_SIZE}`;
      return {
        idempotencyKey: `${this.key}:from-${w.from}:page-${i + 1}`,
        canonicalUrl: `${BASE}?${query}`,
        parentUrl: "https://ecology.wa.gov/regulations-permits/sepa/environmental-review/sepa-register",
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
    if (!this.maxIssue) {
      this.maxIssue = String(ctx.checkpoint?.["issueDateHighWater"] ?? "");
    }

    for (const entry of rows) {
      const parsed = SepaRowSchema.safeParse(entry);
      if (!parsed.success) {
        ctx.logger.warn({ entry }, "SEPA row does not match expected shape");
        out.push({
          record: { sourceKey: this.key, externalId: "" } as never,
          rawFields: (entry ?? {}) as Record<string, unknown>,
        });
        continue;
      }
      const r = parsed.data;
      const county = COUNTY_MAP[r.countyname.toUpperCase()];
      if (!county) {
        ctx.logger.warn({ countyname: r.countyname }, "SEPA row outside pilot counties; skipping");
        continue;
      }
      const issue = r.leadagencyissuedate?.slice(0, 10) ?? null;
      if (issue && issue > this.maxIssue) this.maxIssue = issue;

      const organizations: { name: string; role: string | null; evidenceText: string }[] = [];
      if (r.applicantname) {
        organizations.push({
          name: r.applicantname,
          role: "applicant",
          evidenceText: `applicantname: ${r.applicantname}`,
        });
      }
      if (r.leadagencyname) {
        organizations.push({
          name: r.leadagencyname,
          role: "lead_agency",
          evidenceText: `leadagencyname: ${r.leadagencyname}`,
        });
      }

      out.push({
        rawFields: parsed.data as Record<string, unknown>,
        record: {
          sourceKey: this.key,
          externalId: r.separegisterid,
          recordType: "sepa_document",
          title: `SEPA ${r.sepanumber}${r.documenttypecode ? ` ${r.documenttypecode}` : ""} – ${r.proposalname ?? r.leadagencyname ?? "unknown"}`,
          description: r.proposaldescription ?? null,
          permittingJurisdiction: r.leadagencyname ?? "unknown",
          county,
          city: null,
          addressRaw: null,
          parcelIds: [],
          geometry: null,
          applicationType: null,
          permitType: null,
          documentType: r.documenttypecode ?? null,
          statusRaw: null,
          normalizedStage: "unknown",
          applicationDate: null,
          issueDate: r.leadagencyissuedate ?? null,
          sourceUpdatedAt: null,
          valuationUsd: null,
          units: null,
          lots: null,
          squareFeet: null,
          organizations,
          sourceUrl:
            r.separegisterlink?.url ??
            `https://data.wa.gov/resource/${DATASET}.json?separegisterid=${encodeURIComponent(r.separegisterid)}`,
          evidence: [
            {
              factPath: "externalId",
              text: `SEPA register id ${r.separegisterid} (SEPA number ${r.sepanumber})`,
              pageOrSection: `dataset ${DATASET}`,
            },
            ...(r.documenttypecode
              ? [
                  {
                    factPath: "documentType",
                    text: r.documenttypecode,
                    pageOrSection: "documenttypecode",
                  },
                ]
              : []),
            ...(r.leadagencyissuedate
              ? [
                  {
                    factPath: "issueDate",
                    text: `leadagencyissuedate: ${r.leadagencyissuedate}`,
                    pageOrSection: "leadagencyissuedate",
                  },
                ]
              : []),
            ...organizations.map((o) => ({
              factPath: "organizations",
              text: o.evidenceText,
              pageOrSection: o.role,
            })),
          ],
        },
      });
    }

    if (this.maxIssue && !ctx.backfill) {
      ctx.setCheckpoint({ issueDateHighWater: this.maxIssue });
    }
    return out;
  }
}
