import { z } from "zod";
import { decodeHtmlEntities } from "@otn/documents";
import {
  httpFetchArtifact,
  policyForRun,
  type DiscoveredArtifact,
  type ParsedSourceRecord,
  type RawArtifact,
  type RunContext,
  type SourceAdapter,
} from "@otn/source-sdk";

export const LACEY_PROJECTS_REST_URL =
  "https://cityoflacey.org/wp-json/wp/v2/projects" +
  "?per_page=100&orderby=modified&order=desc&_fields=id,date,modified,link,title";

const LANDING_URL = "https://cityoflacey.org/current-projects/";

export const WpProjectSchema = z.object({
  id: z.number().int(),
  date: z.string(),
  modified: z.string(),
  link: z.string().url(),
  title: z.object({ rendered: z.string() }),
});

const WpProjectListSchema = z.array(z.unknown());

function pageUrl(page: number): string {
  return page === 1 ? LACEY_PROJECTS_REST_URL : `${LACEY_PROJECTS_REST_URL}&page=${page}`;
}

/**
 * M1.1 — Lacey Projects REST (spec §6.1, P0). The City of Lacey WordPress
 * REST collection of current projects: ID, title, created, modified, link.
 * JSON API — highest discovery preference. Pagination via X-WP-TotalPages.
 */
export class LaceyProjectsRestAdapter implements SourceAdapter {
  readonly key = "lacey_projects_rest";
  readonly parserVersion = "1.0.0";

  /** Max modified time seen across all parsed pages this run. */
  private maxModified = "";

  async discover(ctx: RunContext): Promise<DiscoveredArtifact[]> {
    // One tiny probe for the page count; bodies are fetched in fetch().
    const policy = policyForRun(ctx);
    const probe = await policy.fetch(
      "https://cityoflacey.org/wp-json/wp/v2/projects?per_page=100&_fields=id",
      ctx.logger,
    );
    const totalPages = Math.max(1, Number(probe.headers["x-wp-totalpages"] ?? "1") || 1);
    ctx.logger.info({ totalPages }, "lacey REST page count");

    return Array.from({ length: totalPages }, (_v, i) => {
      const page = i + 1;
      return {
        idempotencyKey: `${this.key}:page-${page}`,
        canonicalUrl: pageUrl(page),
        parentUrl: LANDING_URL,
        expectedContentType: "application/json",
        sourcePublishedAt: null,
      };
    });
  }

  async fetch(item: DiscoveredArtifact, ctx: RunContext): Promise<RawArtifact> {
    return httpFetchArtifact(item, ctx);
  }

  async parse(raw: RawArtifact, ctx: RunContext): Promise<ParsedSourceRecord[]> {
    const list = WpProjectListSchema.parse(JSON.parse(raw.body.toString("utf8")));
    const out: ParsedSourceRecord[] = [];
    if (!this.maxModified) {
      this.maxModified = String(ctx.checkpoint?.["modifiedHighWater"] ?? "");
    }

    for (const entry of list) {
      const parsed = WpProjectSchema.safeParse(entry);
      if (!parsed.success) {
        ctx.logger.warn({ entry }, "WP project item does not match expected shape");
        // Emit an invalid record so the runner's Zod boundary rejects and counts it.
        out.push({
          record: { sourceKey: this.key, externalId: "" } as never,
          rawFields: (entry ?? {}) as Record<string, unknown>,
        });
        continue;
      }
      const p = parsed.data;
      const title = decodeHtmlEntities(p.title.rendered);
      if (p.modified > this.maxModified) this.maxModified = p.modified;

      // Backfill window filters on the source's modified time when requested.
      if (ctx.backfill) {
        const modifiedDate = p.modified.slice(0, 10);
        if (modifiedDate < ctx.backfill.from || modifiedDate > ctx.backfill.to) continue;
      }

      out.push({
        rawFields: p as unknown as Record<string, unknown>,
        record: {
          sourceKey: this.key,
          externalId: String(p.id),
          recordType: "project_listing",
          title,
          description: null,
          permittingJurisdiction: "City of Lacey",
          county: "Thurston",
          city: "Lacey",
          addressRaw: null,
          parcelIds: [],
          geometry: null,
          applicationType: null,
          permitType: null,
          documentType: null,
          statusRaw: null,
          normalizedStage: "unknown",
          applicationDate: null,
          issueDate: null,
          sourceUpdatedAt: p.modified,
          valuationUsd: null,
          units: null,
          lots: null,
          squareFeet: null,
          organizations: [],
          sourceUrl: p.link,
          evidence: [
            {
              factPath: "title",
              text: title,
              pageOrSection: `WP project ${p.id}`,
            },
            {
              factPath: "sourceUpdatedAt",
              text: `modified: ${p.modified}`,
              pageOrSection: `WP project ${p.id}`,
            },
          ],
        },
      });
    }

    if (this.maxModified) ctx.setCheckpoint({ modifiedHighWater: this.maxModified });
    return out;
  }
}
