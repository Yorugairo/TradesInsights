import { loadHtml } from "@otn/documents";
import {
  httpFetchArtifact,
  type DiscoveredArtifact,
  type ParsedSourceRecord,
  type RawArtifact,
  type RunContext,
  type SourceAdapter,
} from "@otn/source-sdk";
import type { NormalizedSourceRecord } from "@otn/domain";

const BASE =
  "https://tacoma.gov/government/departments/finance/procurement-and-payables-division/purchasing/contracting-opportunities";
const CATEGORIES = [
  "public-works-and-improvements-solicitations",
  "services-solicitations",
  "supplies-solicitations",
] as const;

/**
 * P5 — City of Tacoma open solicitations (RFB/RFP/RFQ tables on the city's
 * procurement pages; verified 2026-07-17, robots allows all). A published
 * public solicitation is the spec's "explicit solicitation" evidence class —
 * the ONLY public signal permitted to set `bidding_confirmed` ("a permit is
 * not a bid"). Controlled automation still routes every bidding_confirmed
 * item to human review (externally-actionable bid state), so nothing
 * auto-publishes.
 *
 * Snapshot pages, fetched daily; rows that leave the page simply stop
 * updating (their projects keep history). Addenda change row content →
 * fingerprint diff → applyRecordUpdates refresh.
 */
export class TacomaSolicitationsAdapter implements SourceAdapter {
  readonly key = "tacoma_solicitations";
  readonly parserVersion = "1.0.0";

  async discover(_ctx: RunContext): Promise<DiscoveredArtifact[]> {
    return CATEGORIES.map((slug) => ({
      idempotencyKey: `${this.key}:${slug}`,
      canonicalUrl: `${BASE}/${slug}/`,
      parentUrl: `${BASE}/`,
      expectedContentType: "text/html",
      sourcePublishedAt: null,
      meta: { category: slug },
    }));
  }

  async fetch(item: DiscoveredArtifact, ctx: RunContext): Promise<RawArtifact> {
    return httpFetchArtifact(item, ctx);
  }

  async parse(raw: RawArtifact, ctx: RunContext): Promise<ParsedSourceRecord[]> {
    const $ = loadHtml(raw.body);
    const category = String(
      (raw.discovered.meta as { category?: string } | undefined)?.category ?? "unknown",
    );
    const out: ParsedSourceRecord[] = [];

    const rows = $("table tr").toArray();
    for (const tr of rows) {
      const cells = $(tr)
        .find("td")
        .toArray()
        .map((td) => $(td).text().replace(/\s+/g, " ").trim());
      if (cells.length < 6) continue; // header or layout row

      const [specNumber, type, dueDate, timeDue, titleCell, dateIssued] = cells as [
        string, string, string, string, string, string,
      ];
      // Spec numbers look like PW26-0140F / ES26-0123N / PT26-0001F.
      if (!/^[A-Z]{2}\d{2}-\d{3,5}[A-Z]?$/.test(specNumber)) {
        if (specNumber) ctx.logger.warn({ specNumber, category }, "unrecognized spec number — row skipped");
        continue;
      }
      const usDate = (s: string): string | null => {
        const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s.trim());
        return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
      };
      // The title cell also carries document links; the title is the leading
      // text before known document-link labels.
      const title = titleCell
        .replace(/\b(Specification|Bid Submittal Package|Register for the Bid Holders? List|Plans|Addendum.*|Questions and Answers.*|This bid is distributed.*)\b.*$/i, "")
        .trim();
      const firstLink = $(tr).find("td a[href]").first().attr("href") ?? null;
      const sourceUrl = firstLink && /^https?:\/\//.test(firstLink) ? firstLink : raw.discovered.canonicalUrl;

      const record: NormalizedSourceRecord = {
        sourceKey: this.key,
        externalId: specNumber,
        recordType: "solicitation",
        title: `${specNumber} – ${title || "City of Tacoma solicitation"}`,
        description: `${type} due ${dueDate} ${timeDue} Pacific. Category: ${category.replaceAll("-", " ")}.`,
        permittingJurisdiction: "City of Tacoma",
        county: "Pierce",
        city: "Tacoma",
        addressRaw: null,
        parcelIds: [],
        geometry: null,
        applicationType: type || null,
        permitType: null,
        documentType: "solicitation",
        statusRaw: `open (due ${dueDate})`,
        // Spec §9 exception: an explicit public solicitation IS bid evidence.
        normalizedStage: "bidding_confirmed",
        applicationDate: usDate(dateIssued),
        issueDate: null,
        sourceUpdatedAt: null,
        valuationUsd: null,
        units: null,
        lots: null,
        squareFeet: null,
        organizations: [],
        sourceUrl,
        evidence: [
          {
            factPath: "title",
            text: `${specNumber} ${type}: ${title}`,
            pageOrSection: `${category} table`,
          },
          {
            factPath: "statusRaw",
            text: `Due Date ${dueDate} ${timeDue} (Date Issued ${dateIssued})`,
            pageOrSection: `${category} table`,
          },
        ],
      };
      out.push({
        rawFields: { specNumber, type, dueDate, timeDue, titleCell, dateIssued, category },
        record,
      });
    }
    if (out.length === 0) {
      ctx.logger.warn({ category }, "no solicitation rows parsed — layout may have changed");
    }
    return out;
  }
}
