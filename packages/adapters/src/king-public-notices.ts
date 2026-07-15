import { collapsedText, extractLinks, loadHtml } from "@otn/documents";
import {
  httpFetchArtifact,
  type DiscoveredArtifact,
  type ParsedSourceRecord,
  type RawArtifact,
  type RunContext,
  type SourceAdapter,
} from "@otn/source-sdk";

export const KING_NOTICES_URL =
  "https://kingcounty.gov/en/dept/local-services/buildings-property/public-notices-permit-records-search/public-notices";

const PERMIT_RE = /^[A-Z]{4}\d{2}-\d{4}$/;
const PARCEL_RE = /^\d{10}$/;

/** "SHOR25-0022 / SHOR25-0023" → ["SHOR25-0022","SHOR25-0023"]. */
export function permitNumbersFromCell(cell: string): string[] {
  return cell
    .split(/[\s/]+/)
    .map((s) => s.trim())
    .filter((s) => PERMIT_RE.test(s));
}

/** Stable id for non-permit notices (STRC meetings, non-project SEPA). */
export function slugId(label: string, projectName: string): string {
  const slug = `${label} ${projectName}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `nonpermit-${slug}`;
}

/**
 * M1.5 — King County public notices (spec §6.4, P0). Single rolling HTML
 * table: permit number (Accela-linked), project name, notice type + linked
 * notice documents, parcel numbers. King County notices are unincorporated
 * King County unless explicitly stated (spec §6.4 rule).
 */
export class KingPublicNoticesAdapter implements SourceAdapter {
  readonly key = "king_public_notices";
  readonly parserVersion = "1.0.0";

  async discover(_ctx: RunContext): Promise<DiscoveredArtifact[]> {
    return [
      {
        idempotencyKey: `${this.key}:landing`,
        canonicalUrl: KING_NOTICES_URL,
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
    const rows = $("table tbody tr, table tr").toArray();
    const out: ParsedSourceRecord[] = [];
    const seenIds = new Set<string>();

    for (const tr of rows) {
      const cells = $(tr).find("td");
      if (cells.length < 3) continue;

      const permitCell = collapsedText($(cells[0]!));
      const projectName = collapsedText($(cells[1]!)).replace(/^\s*&nbsp;\s*/, "").trim();
      if (!projectName || /^x+$/i.test(projectName)) continue; // template rows

      const permitNumbers = permitNumbersFromCell(permitCell);
      const noticeCell = $(cells[2]!);
      const noticeLinks = extractLinks($, noticeCell, raw.discovered.canonicalUrl);
      // The first line of the notice cell names the notice type (linked or not).
      const noticeType =
        collapsedText(noticeCell.find("p,a").first()) || collapsedText(noticeCell) || null;
      const documents = noticeLinks.filter((l) => /cdn\.kingcounty\.gov|\.pdf/i.test(l.url));

      const parcelCell = cells.length > 3 ? collapsedText($(cells[3]!)) : "";
      const parcelIds = parcelCell
        .split(/\s+/)
        .map((s) => s.replace(/[^\d]/g, ""))
        .filter((s) => PARCEL_RE.test(s));

      const accelaUrl =
        extractLinks($, $(cells[0]!), raw.discovered.canonicalUrl).find((l) =>
          /accela\.com/.test(l.url),
        )?.url ?? null;

      const externalId = permitNumbers[0] ?? slugId(permitCell || "notice", projectName);
      if (seenIds.has(externalId)) {
        ctx.logger.warn({ externalId }, "duplicate notice row on page; keeping first");
        continue;
      }
      seenIds.add(externalId);

      out.push({
        rawFields: {
          permitNumbers,
          projectName,
          noticeType,
          parcelCell,
          accelaUrl,
          documents,
        },
        record: {
          sourceKey: this.key,
          externalId,
          recordType: "public_notice",
          title: `${permitNumbers[0] ?? "Notice"} – ${projectName}`,
          description: null,
          permittingJurisdiction: "Unincorporated King County",
          county: "King",
          city: null,
          addressRaw: null,
          parcelIds,
          geometry: null,
          applicationType: null,
          permitType: null,
          documentType: noticeType,
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
          sourceUrl: raw.discovered.canonicalUrl,
          evidence: [
            {
              factPath: "title",
              text: `${permitCell || "Notice"} – ${projectName}`,
              pageOrSection: "Public notice lists table",
            },
            ...(noticeType
              ? [
                  {
                    factPath: "documentType",
                    text: noticeType,
                    pageOrSection: "Notice Type column",
                  },
                ]
              : []),
            ...parcelIds.map((id) => ({
              factPath: "parcelIds",
              text: `parcel ${id}`,
              pageOrSection: "Parcel Number(s) column",
            })),
          ],
        },
      });
    }

    if (out.length === 0) {
      throw new Error("King public notices table parsed to zero records — page shape changed?");
    }
    return out;
  }
}
