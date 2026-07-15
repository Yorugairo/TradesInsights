import { loadHtml } from "@otn/documents";
import {
  httpFetchArtifact,
  type DiscoveredArtifact,
  type ParsedSourceRecord,
  type RawArtifact,
  type RunContext,
  type SourceAdapter,
} from "@otn/source-sdk";

export const SEATTLE_CANARY_URL =
  "https://www.seattle.gov/construction-and-inspections/resources/research-a-project";

/** The official data paths the M1.7 adapters depend on (spec §6.4 canary). */
const WATCHED_LINKS = [
  { name: "building_permits_dataset", pattern: /data\.seattle\.gov\/.*76t5-zqzr/, required: true },
  { name: "land_use_permits_dataset", pattern: /data\.seattle\.gov\/.*ht3q-kdvx/, required: true },
  { name: "open_data_portal", pattern: /^https:\/\/data\.seattle\.gov\/?$/, required: false },
  { name: "permit_history_map", pattern: /maps\.seattle\.gov\/sdcipermithistory/, required: false },
] as const;

/**
 * M1.7 — Seattle Research-a-Project canary (spec §6.4, P0). Watches the
 * official research page for the Socrata dataset links the Seattle adapters
 * query; a dataset move/renumber fails the run and flags the migration.
 */
export class SeattleSourceCanaryAdapter implements SourceAdapter {
  readonly key = "seattle_source_canary";
  readonly parserVersion = "1.0.0";

  async discover(_ctx: RunContext): Promise<DiscoveredArtifact[]> {
    return [
      {
        idempotencyKey: `${this.key}:landing`,
        canonicalUrl: SEATTLE_CANARY_URL,
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
    const hrefs = new Set<string>();
    $("a[href]").each((_i, a) => {
      const href = $(a).attr("href");
      if (href) hrefs.add(href);
    });

    const found: Record<string, string | null> = {};
    const missing: string[] = [];
    for (const w of WATCHED_LINKS) {
      const hit = [...hrefs].find((h) => w.pattern.test(h)) ?? null;
      found[w.name] = hit;
      if (!hit && w.required) missing.push(w.name);
    }
    if (missing.length > 0) {
      throw new Error(
        `Seattle canary: required dataset link(s) missing from research page: ${missing.join(", ")}`,
      );
    }
    for (const w of WATCHED_LINKS) {
      if (!found[w.name]) {
        ctx.logger.warn({ link: w.name }, "canary: optional watched link absent");
      }
    }

    return [
      {
        rawFields: { links: found },
        record: {
          sourceKey: this.key,
          externalId: "seattle-research-a-project",
          recordType: "source_canary",
          title: "Seattle Research-a-Project official data paths",
          description: null,
          permittingJurisdiction: "City of Seattle",
          county: "King",
          city: "Seattle",
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
          sourceUpdatedAt: null,
          valuationUsd: null,
          units: null,
          lots: null,
          squareFeet: null,
          organizations: [],
          sourceUrl: SEATTLE_CANARY_URL,
          evidence: Object.entries(found)
            .filter((e): e is [string, string] => e[1] !== null)
            .map(([name, url]) => ({
              factPath: `links.${name}`,
              text: url,
              pageOrSection: "research-a-project page",
            })),
        },
      },
    ];
  }
}
