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
import { LACEY_PROJECTS_REST_URL, WpProjectSchema } from "./lacey-projects-rest.js";

const LANDING_URL = "https://cityoflacey.org/current-projects/";

/** Overlap window so records modified around the checkpoint are re-fetched. */
const OVERLAP_DAYS = 1;

const MetaSchema = z.object({
  postId: z.number().int(),
  modified: z.string(),
  published: z.string(),
});

/** "#25-0261 – 41st Ave" → "25-0261". */
export function projectNumberFromTitle(title: string): string | null {
  const m = /#\s*(\d{2}-\d{4})/.exec(title);
  return m?.[1] ?? null;
}

/** Explicitly-stated assessor parcel numbers (8+ digits) near the word "parcel". */
export function parcelsFromText(text: string): string[] {
  const out = new Set<string>();
  // Scan the clause following each "parcel(s)" mention (bounded at the next
  // sentence break) and collect every digit run, so "parcels X and Y" yields
  // both. Lookahead-style indexing keeps overlapping mentions independent.
  for (const m of text.matchAll(/parcels?\b/gi)) {
    const start = m.index + m[0].length;
    const clause = text.slice(start, start + 80).split(/[.;]/)[0] ?? "";
    for (const id of clause.matchAll(/\d{8,}/g)) out.add(id[0]);
  }
  return [...out];
}

/**
 * A deterministic, evidence-bounded proponent extraction: only the pattern
 * "<Legal Entity suffix> is proposing/has proposed/proposes" counts. Anything
 * fuzzier is model territory (M3) — never guessed here.
 */
export function proponentFromDescription(
  description: string,
): { name: string; evidenceText: string } | null {
  const m =
    /([A-Z][\w.,&'’\- ]{2,80}?(?:LLC|L\.L\.C\.|Inc\.?|Incorporated|Corp\.?|Corporation|Company|LLP|LP|PLLC))\s+(?:is proposing|has proposed|proposes)/.exec(
      description,
    );
  if (!m?.[1]) return null;
  return { name: m[1].trim(), evidenceText: m[0].trim() };
}

/**
 * M1.1 — Lacey Current Projects pages (spec §6.1, P0). Discovers project
 * detail pages from the documented WP REST collection (highest-preference
 * discovery), fetches each page, and extracts description, address, parcels,
 * geometry, contacts, and linked documents from the HTML.
 */
export class LaceyProjectPagesAdapter implements SourceAdapter {
  readonly key = "lacey_project_pages";
  readonly parserVersion = "1.0.0";

  /** Max modified time seen this run; persisted as the next checkpoint. */
  private maxModified = "";

  async discover(ctx: RunContext): Promise<DiscoveredArtifact[]> {
    const body = await httpGet(LACEY_PROJECTS_REST_URL, ctx);
    const list = z.array(z.unknown()).parse(JSON.parse(body.toString("utf8")));

    // Date-level floor with an overlap day — records modified on or after it
    // are re-fetched; the content hash makes the re-fetch a no-op.
    const highWater = String(ctx.checkpoint?.["modifiedHighWater"] ?? "");
    const floorDate = highWater
      ? new Date(Date.parse(highWater.slice(0, 10)) - OVERLAP_DAYS * 86_400_000)
          .toISOString()
          .slice(0, 10)
      : "";

    const out: DiscoveredArtifact[] = [];
    for (const entry of list) {
      const parsed = WpProjectSchema.safeParse(entry);
      if (!parsed.success) {
        ctx.logger.warn({ entry }, "skipping malformed WP project list item");
        continue;
      }
      const p = parsed.data;
      if (p.modified > this.maxModified) this.maxModified = p.modified;
      if (ctx.backfill) {
        const modifiedDate = p.modified.slice(0, 10);
        if (modifiedDate < ctx.backfill.from || modifiedDate > ctx.backfill.to) continue;
      } else if (floorDate && p.modified.slice(0, 10) < floorDate) {
        continue; // Unchanged since the last run (with overlap) — skip the page fetch.
      }
      out.push({
        idempotencyKey: `${this.key}:${p.id}`,
        canonicalUrl: p.link,
        parentUrl: LANDING_URL,
        expectedContentType: "text/html",
        sourcePublishedAt: p.date,
        meta: { postId: p.id, modified: p.modified, published: p.date },
      });
    }
    // Checkpoint reflects the full listing, not just fetched pages — set it
    // here so skip-filtered runs still advance/hold the high-water mark.
    if (this.maxModified && !ctx.backfill) {
      ctx.setCheckpoint({ modifiedHighWater: this.maxModified });
    }
    return out;
  }

  async fetch(item: DiscoveredArtifact, ctx: RunContext): Promise<RawArtifact> {
    return httpFetchArtifact(item, ctx);
  }

  async parse(raw: RawArtifact, ctx: RunContext): Promise<ParsedSourceRecord[]> {
    const meta = MetaSchema.parse(raw.discovered.meta ?? {});
    const $ = loadHtml(raw.body);

    const title = collapsedText($("h2.text-center").first());
    const projectNumber = projectNumberFromTitle(title);
    const externalId = projectNumber ?? `wp-${meta.postId}`;

    const backgroundHeading = $("h4")
      .filter((_i, el) => /project\s+background/i.test($(el).text()))
      .first();
    const description = backgroundHeading.length
      ? collapsedText(backgroundHeading.nextAll("p").first()) || null
      : null;

    const marker = $(".marker").first();
    const addressRaw = marker.length
      ? collapsedText(marker.find("p.address").first()) || null
      : null;
    const lat = Number(marker.attr("data-lat"));
    const lng = Number(marker.attr("data-lng"));
    const geometry =
      Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0
        ? ({ type: "Point", coordinates: [lng, lat] } as const)
        : null;

    const parcelIds = description ? parcelsFromText(description) : [];
    const proponent = description ? proponentFromDescription(description) : null;

    const documents = extractLinks($, $("a.doc_block").parent(), raw.discovered.canonicalUrl)
      .filter((l) => l.url.includes("/wp-content/uploads/"));

    const contactName = collapsedText($(".contact_box h5").first()) || null;
    const contactTitle = collapsedText($(".contact_box h6").first()) || null;

    if (!title) {
      // Page shape changed — reject loudly rather than emit an empty record.
      throw new Error(`no h2.text-center project title found at ${raw.discovered.canonicalUrl}`);
    }

    return [
      {
        rawFields: {
          postId: meta.postId,
          title,
          projectNumber,
          addressRaw,
          lat: Number.isFinite(lat) ? lat : null,
          lng: Number.isFinite(lng) ? lng : null,
          contactName,
          contactTitle,
          documents,
          modified: meta.modified,
          published: meta.published,
        },
        record: {
          sourceKey: this.key,
          externalId,
          recordType: "project_page",
          title,
          description,
          permittingJurisdiction: "City of Lacey",
          county: "Thurston",
          city: "Lacey",
          addressRaw,
          parcelIds,
          geometry,
          applicationType: null,
          permitType: null,
          documentType: null,
          statusRaw: null,
          normalizedStage: "unknown",
          applicationDate: null,
          issueDate: null,
          sourceUpdatedAt: meta.modified,
          valuationUsd: null,
          units: null,
          lots: null,
          squareFeet: null,
          organizations: proponent
            ? [{ name: proponent.name, role: "proponent", evidenceText: proponent.evidenceText }]
            : [],
          sourceUrl: raw.discovered.canonicalUrl,
          evidence: [
            { factPath: "title", text: title, pageOrSection: "h2" },
            ...(description
              ? [
                  {
                    factPath: "description",
                    text: description.slice(0, 500),
                    pageOrSection: "Project Background",
                  },
                ]
              : []),
            ...(addressRaw
              ? [{ factPath: "addressRaw", text: addressRaw, pageOrSection: "map marker" }]
              : []),
            ...parcelIds.map((id) => ({
              factPath: "parcelIds",
              text: `parcel ${id}`,
              pageOrSection: "Project Background",
            })),
          ],
        },
      },
    ];
  }
}
