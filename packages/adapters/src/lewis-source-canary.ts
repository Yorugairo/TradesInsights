import { loadHtml } from "@otn/documents";
import {
  httpFetchArtifact,
  type DiscoveredArtifact,
  type ParsedSourceRecord,
  type RawArtifact,
  type RunContext,
  type SourceAdapter,
} from "@otn/source-sdk";

export const LEWIS_CANARY_URL = "https://lewiscountywa.gov/departments/community-development/";

/**
 * The official paths the canary asserts (spec §6.2): planning, permits,
 * records, portal. If a required one disappears from the landing page the
 * parse throws, the run fails, and source health flags the migration.
 */
const WATCHED_LINKS = [
  { name: "planning", pattern: /current-planning-applications/, required: true },
  { name: "permits", pattern: /building-permit-data/, required: true },
  { name: "records", pattern: /docs\.lewiscountywa\.gov/, required: false },
  { name: "portal", pattern: /smartgovcommunity\.com/, required: false },
] as const;

/** Unwrap Outlook safelinks so the watched URL is the real destination. */
export function unwrapSafelink(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith("safelinks.protection.outlook.com")) {
      const inner = u.searchParams.get("url");
      if (inner) return inner;
    }
    return url;
  } catch {
    return url;
  }
}

/**
 * M1.2 — Lewis Community Development landing canary (spec §6.2, P0).
 * Watches the official landing page for the current planning/permit/records/
 * portal links so downstream adapters never operate on stale or guessed URLs
 * (a SmartGov migration or CMS restructure shows up here first).
 */
export class LewisSourceCanaryAdapter implements SourceAdapter {
  readonly key = "lewis_source_canary";
  readonly parserVersion = "1.0.0";

  async discover(_ctx: RunContext): Promise<DiscoveredArtifact[]> {
    return [
      {
        idempotencyKey: `${this.key}:landing`,
        canonicalUrl: LEWIS_CANARY_URL,
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
      if (href) hrefs.add(unwrapSafelink(decodeURIComponent(href)));
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
        `Lewis landing canary: required link(s) missing: ${missing.join(", ")} — possible migration/restructure`,
      );
    }
    for (const w of WATCHED_LINKS) {
      if (!found[w.name]) {
        ctx.logger.warn({ link: w.name }, "canary: optional watched link absent from landing page");
      }
    }

    return [
      {
        rawFields: { links: found },
        record: {
          sourceKey: this.key,
          externalId: "lewis-community-development-landing",
          recordType: "source_canary",
          title: "Lewis Community Development official landing links",
          description: null,
          permittingJurisdiction: "Lewis County",
          county: "Lewis",
          city: null,
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
          sourceUrl: LEWIS_CANARY_URL,
          evidence: Object.entries(found)
            .filter((e): e is [string, string] => e[1] !== null)
            .map(([name, url]) => ({
              factPath: `links.${name}`,
              text: url,
              pageOrSection: "landing page",
            })),
        },
      },
    ];
  }
}
