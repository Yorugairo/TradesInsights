import { collapsedText, extractLinks, loadHtml } from "@otn/documents";
import {
  httpFetchArtifact,
  type DiscoveredArtifact,
  type ParsedSourceRecord,
  type RawArtifact,
  type RunContext,
  type SourceAdapter,
} from "@otn/source-sdk";

export const THURSTON_NOTICES_URL =
  "https://www.thurstoncountywa.gov/departments/community-planning-and-economic-development/permitting/comment-project";

/** "Project Number: 2019101651 (Moore Garage RUE) Public Hearing - July 28, 2026, at 10 am" */
export function parseNoticeHeading(heading: string): {
  projectNumber: string | null;
  projectName: string | null;
  noticeDate: string | null;
} {
  const num = /Project\s+Number:\s*(\d{7,12})/i.exec(heading)?.[1] ?? null;
  const name = /\(([^)]+)\)/.exec(heading)?.[1]?.trim() ?? null;
  const dateMatch =
    /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(\d{4})/.exec(
      heading,
    );
  let noticeDate: string | null = null;
  if (dateMatch) {
    const months = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ];
    const m = months.indexOf(dateMatch[1]!) + 1;
    noticeDate = `${dateMatch[3]}-${String(m).padStart(2, "0")}-${dateMatch[2]!.padStart(2, "0")}`;
  } else {
    // Numeric style: "Date of Issuance: 3/23/2026" (year sometimes 2-digit).
    const numDate = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(heading);
    if (numDate) {
      const year = numDate[3]!.length === 2 ? `20${numDate[3]}` : numDate[3]!;
      noticeDate = `${year}-${numDate[1]!.padStart(2, "0")}-${numDate[2]!.padStart(2, "0")}`;
    }
  }
  return { projectNumber: num, projectName: name, noticeDate };
}

interface Notice {
  heading: string;
  projectNumber: string | null;
  projectName: string | null;
  noticeDate: string | null;
  description: string | null;
  location: string | null;
  links: { url: string; text: string }[];
}

/**
 * M1.9 — Thurston County active notices (spec §6.1, P0). The Drupal
 * "Comment on a Project" page lists projects with active notices as
 * accordion items: project number + name + hearing/notice date in the
 * button, description / "Location:" line / comment + materials links in the
 * body. One record per project; multiple notices for a project are merged
 * with every notice retained in rawFields. Migration canary: a new
 * permitting system was announced for September 2026 — a zero-notice or
 * shape-changed page fails the run loudly.
 */
export class ThurstonActiveNoticesAdapter implements SourceAdapter {
  readonly key = "thurston_active_notices";
  readonly parserVersion = "1.0.0";

  async discover(_ctx: RunContext): Promise<DiscoveredArtifact[]> {
    return [
      {
        idempotencyKey: `${this.key}:landing`,
        canonicalUrl: THURSTON_NOTICES_URL,
        parentUrl: null,
        expectedContentType: "text/html",
        sourcePublishedAt: null,
      },
    ];
  }

  async fetch(item: DiscoveredArtifact, ctx: RunContext): Promise<RawArtifact> {
    return httpFetchArtifact(item, ctx);
  }

  async parse(raw: RawArtifact, ctx: RunContext): Promise<ParsedSourceRecord[]> {
    const $ = loadHtml(raw.body);

    const sectionHeading = $("h2")
      .filter((_i, el) => /projects with active notices/i.test($(el).text()))
      .first();
    if (!sectionHeading.length) {
      throw new Error("Thurston notices: 'Projects with Active Notices' heading not found — page shape changed?");
    }
    const group = sectionHeading.nextAll(".accordion-group").first();
    const notices: Notice[] = [];
    group.find(".accordion-item").each((_i, item) => {
      const button = $(item).find("button.accordion-title").first();
      const heading = collapsedText(button);
      if (!heading) return;
      const bodyId = button.attr("aria-controls");
      const body = bodyId ? group.find(`#${bodyId}`).first() : $(item).nextAll(".accordion-text").first();

      const paragraphs = body
        .find("p")
        .toArray()
        .map((p) => collapsedText($(p)))
        .filter(Boolean);
      const location =
        paragraphs.find((p) => /^Location:/i.test(p))?.replace(/^Location:\s*/i, "") ?? null;
      const description =
        paragraphs.find(
          (p) => !/^Location:/i.test(p) && !/submit a comment|review comments|review project|review documents/i.test(p) && p.length > 40,
        ) ?? null;
      const links = extractLinks($, body, raw.discovered.canonicalUrl);

      notices.push({
        heading,
        ...parseNoticeHeading(heading),
        description,
        location,
        links,
      });
    });

    if (notices.length === 0) {
      throw new Error("Thurston notices: zero accordion notices parsed — page shape changed?");
    }

    // One record per project; a project can carry several concurrent notices.
    const byProject = new Map<string, Notice[]>();
    for (const n of notices) {
      const key = n.projectNumber ?? `heading:${n.heading.slice(0, 60)}`;
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key)!.push(n);
    }

    const out: ParsedSourceRecord[] = [];
    for (const [key, group_] of byProject) {
      const primary = group_[0]!;
      if (!primary.projectNumber) {
        ctx.logger.warn({ heading: primary.heading }, "notice without a project number; skipping");
        continue;
      }
      out.push({
        rawFields: {
          projectNumber: primary.projectNumber,
          projectName: primary.projectName,
          notices: group_.map((n) => ({
            heading: n.heading,
            noticeDate: n.noticeDate,
            links: n.links,
          })),
        },
        record: {
          sourceKey: this.key,
          externalId: primary.projectNumber,
          recordType: "public_notice",
          title: `${primary.projectNumber} – ${primary.projectName ?? primary.heading}`,
          description: primary.description,
          permittingJurisdiction: "Thurston County",
          county: "Thurston",
          city: null,
          addressRaw: primary.location,
          parcelIds: [],
          geometry: null,
          applicationType: null,
          permitType: null,
          documentType: null,
          statusRaw: "active notice",
          normalizedStage: "unknown",
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
              text: primary.heading,
              pageOrSection: "Projects with Active Notices",
            },
            ...(primary.location
              ? [
                  {
                    factPath: "addressRaw",
                    text: `Location: ${primary.location}`,
                    pageOrSection: "notice body",
                  },
                ]
              : []),
            {
              factPath: "statusRaw",
              text: "Listed under 'Projects with Active Notices'",
              pageOrSection: "Comment on a Project page",
            },
          ],
        },
      });
      void key;
    }

    return out;
  }
}
