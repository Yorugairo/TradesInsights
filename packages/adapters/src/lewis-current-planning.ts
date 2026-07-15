import { z } from "zod";
import { collapsedText, extractLinks, loadHtml } from "@otn/documents";
import {
  httpFetchArtifact,
  httpGet,
  type DiscoveredArtifact,
  type ParsedSourceRecord,
  type RawArtifact,
  type RunContext,
  type SourceAdapter,
} from "@otn/source-sdk";

export const LEWIS_PLANNING_URL =
  "https://lewiscountywa.gov/departments/community-development/current-planning-applications/";

const RowMetaSchema = z.object({
  kind: z.literal("application"),
  fileNumbers: z.array(z.string()).min(1),
  projectName: z.string().min(1),
  applicationType: z.string().nullable(),
});

/** "SUP25-0001 / SEP25-0011" → ["SUP25-0001", "SEP25-0011"]. */
export function splitFileNumbers(cell: string): string[] {
  return cell
    .split("/")
    .map((s) => s.trim())
    .filter((s) => /^[A-Z]{2,4}\d{2}-\d{4,5}$/.test(s));
}

interface LandingRow {
  fileNumbers: string[];
  projectName: string;
  applicationType: string | null;
  detailUrl: string | null;
}

/** Parse the "Planning Applications Under Review" table rows. */
export function parseLandingRows(html: Buffer | string, baseUrl: string): LandingRow[] {
  const $ = loadHtml(html);
  const rows: LandingRow[] = [];
  $("table tbody tr").each((_i, tr) => {
    const cells = $(tr).find("td");
    if (cells.length < 3) return;
    const fileNumbers = splitFileNumbers(collapsedText($(cells[0]!)));
    if (fileNumbers.length === 0) return; // header/blank/regional rows
    const projectName = collapsedText($(cells[1]!));
    const applicationType = collapsedText($(cells[2]!)) || null;
    const links = cells.length > 3 ? extractLinks($, $(cells[3]!), baseUrl) : [];
    rows.push({
      fileNumbers,
      projectName,
      applicationType,
      detailUrl: links[0]?.url ?? null,
    });
  });
  return rows;
}

/**
 * M1.2 — Lewis Current Planning Applications (spec §6.2, P0). The landing
 * table lists active applications (file numbers, project, type) with a
 * detail subpage per application carrying the notice/application/environmental
 * documents. The landing page is stored for provenance/diff; one record is
 * emitted per application from its detail subpage.
 */
export class LewisCurrentPlanningAdapter implements SourceAdapter {
  readonly key = "lewis_current_planning";
  readonly parserVersion = "1.0.0";

  async discover(ctx: RunContext): Promise<DiscoveredArtifact[]> {
    const body = await httpGet(LEWIS_PLANNING_URL, ctx);
    const rows = parseLandingRows(body, LEWIS_PLANNING_URL);
    if (rows.length === 0) {
      throw new Error("Lewis planning landing table parsed to zero rows — page shape changed?");
    }
    const out: DiscoveredArtifact[] = [
      {
        idempotencyKey: `${this.key}:landing`,
        canonicalUrl: LEWIS_PLANNING_URL,
        parentUrl: null,
        expectedContentType: "text/html",
        sourcePublishedAt: null,
        meta: { kind: "landing" },
      },
    ];
    for (const row of rows) {
      if (!row.detailUrl) {
        ctx.logger.warn({ fileNumbers: row.fileNumbers }, "application row without a files link");
        continue;
      }
      out.push({
        idempotencyKey: `${this.key}:${row.fileNumbers[0]}`,
        canonicalUrl: row.detailUrl,
        parentUrl: LEWIS_PLANNING_URL,
        expectedContentType: "text/html",
        sourcePublishedAt: null,
        meta: {
          kind: "application",
          fileNumbers: row.fileNumbers,
          projectName: row.projectName,
          applicationType: row.applicationType,
        },
      });
    }
    return out;
  }

  async fetch(item: DiscoveredArtifact, ctx: RunContext): Promise<RawArtifact> {
    return httpFetchArtifact(item, ctx);
  }

  async parse(raw: RawArtifact, _ctx: RunContext): Promise<ParsedSourceRecord[]> {
    if ((raw.discovered.meta as { kind?: string } | undefined)?.kind === "landing") {
      return []; // Registry page stored for provenance/diff; rows are parsed via subpages.
    }
    const meta = RowMetaSchema.parse(raw.discovered.meta ?? {});
    const $ = loadHtml(raw.body);

    const h1 = collapsedText($("h1").first());
    if (!h1) {
      throw new Error(`no h1 on Lewis application page ${raw.discovered.canonicalUrl}`);
    }

    // Documents grouped under h2 section headings; every document link on
    // these pages points at /documents/<id>/<name>.
    const documents: { url: string; text: string; section: string | null }[] = [];
    $("a[href]").each((_i, a) => {
      const el = $(a);
      const href = el.attr("href") ?? "";
      if (!/\/documents\//.test(href)) return;
      const url = new URL(href, raw.discovered.canonicalUrl).toString();
      const section = collapsedText(el.closest("div,section").prevAll("h2").first()) || null;
      documents.push({ url, text: collapsedText(el), section });
    });

    const externalId = meta.fileNumbers[0]!;
    const title = `${externalId} – ${meta.projectName}`;

    return [
      {
        rawFields: {
          fileNumbers: meta.fileNumbers,
          projectName: meta.projectName,
          applicationType: meta.applicationType,
          heading: h1,
          documents,
        },
        record: {
          sourceKey: this.key,
          externalId,
          recordType: "planning_application",
          title,
          description: null,
          permittingJurisdiction: "Lewis County",
          county: "Lewis",
          city: null,
          addressRaw: null,
          parcelIds: [],
          geometry: null,
          applicationType: meta.applicationType,
          permitType: null,
          documentType: null,
          statusRaw: "under review",
          normalizedStage: "entitlement",
          applicationDate: null,
          issueDate: null,
          sourceUpdatedAt: null,
          valuationUsd: null,
          units: null,
          lots: null,
          squareFeet: null,
          organizations: [],
          sourceUrl: raw.discovered.canonicalUrl,
          evidence: [
            {
              factPath: "title",
              text: h1,
              pageOrSection: "h1",
            },
            {
              factPath: "statusRaw",
              text: "Listed under 'Planning Applications Under Review'",
              pageOrSection: "Current Planning Applications table",
            },
            ...(meta.applicationType
              ? [
                  {
                    factPath: "applicationType",
                    text: meta.applicationType,
                    pageOrSection: "Current Planning Applications table, Type column",
                  },
                ]
              : []),
          ],
        },
      },
    ];
  }
}
