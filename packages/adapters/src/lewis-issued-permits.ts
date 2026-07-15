import { extractLinks, extractPdfTextItems, loadHtml, type PdfTextItem } from "@otn/documents";
import {
  httpFetchArtifact,
  httpGet,
  type DiscoveredArtifact,
  type ParsedSourceRecord,
  type RawArtifact,
  type RunContext,
  type SourceAdapter,
} from "@otn/source-sdk";

export const LEWIS_PERMIT_DATA_URL =
  "https://lewiscountywa.gov/departments/community-development/building-permit-data/";

/** Reports newer than checkpoint minus this overlap are (re)fetched. */
const OVERLAP_DAYS = 14;
/** With no checkpoint, cover at least the 90-day backfill window. */
const DEFAULT_WINDOW_DAYS = 120;

/**
 * "06.28.2026_Issued_Permits_with_Valuation.pdf" → "2026-06-28".
 * Tolerates one junk CMS segment after the month (the county's index really
 * contains "06_C0394UQ.14.2026_Issued_Permits_..." for the June 14 report).
 */
export function reportDateFromFilename(url: string): string | null {
  const name = url.split("/").pop() ?? "";
  const m = /^(\d{2})(?:_[A-Za-z0-9]+)?\.(\d{2})\.(\d{4})/.exec(name);
  if (!m) return null;
  return `${m[3]}-${m[1]}-${m[2]}`;
}

/** "06/29/2026" → "2026-06-29". */
function usDateToIso(s: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s.trim());
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

const ANCHOR_RE = /^[A-Z]{1,3}\d{2}-\d{4,5}$/;

export interface LewisPermitRow {
  applicationNumber: string;
  issuedDate: string | null;
  applicationType: string | null;
  siteAddress: string | null;
  parcel: string | null;
  applicant: string | null;
  primaryContractor: string | null;
  valuation: number | null;
}

interface ColumnBands {
  headerY: number;
  bounds: { name: keyof LewisPermitRow | "valuation"; from: number; to: number }[];
}

function findColumns(items: PdfTextItem[]): ColumnBands | null {
  const header = items.find((i) => i.text === "Application Number");
  if (!header) return null;
  const label = (t: string) => items.find((i) => Math.abs(i.y - header.y) < 12 && i.text === t);
  const typeAddr = label("Application Type / Site Address");
  const parcel = label("Parcel");
  const applicant = label("Applicant");
  const contractor = label("Primary Contractor");
  const valuation = label("Valuation");
  const issued = items.find((i) => Math.abs(i.y - header.y) < 12 && i.text === "Issued");
  if (!typeAddr || !parcel || !applicant || !contractor || !valuation || !issued) return null;

  const centers = [
    { name: "applicationNumber" as const, x: header.x },
    { name: "issuedDate" as const, x: issued.x },
    { name: "applicationType" as const, x: typeAddr.x },
    { name: "parcel" as const, x: parcel.x },
    { name: "applicant" as const, x: applicant.x },
    { name: "primaryContractor" as const, x: contractor.x },
    { name: "valuation" as const, x: valuation.x },
  ].sort((a, b) => a.x - b.x);

  const bounds = centers.map((c, i) => ({
    name: c.name,
    from: i === 0 ? -Infinity : (centers[i - 1]!.x + c.x) / 2,
    to: i === centers.length - 1 ? Infinity : (c.x + centers[i + 1]!.x) / 2,
  }));
  return { headerY: header.y, bounds };
}

/**
 * Parse one page of the rotated Lewis issued-permits table. Permits are
 * anchored by the application-number cell; wrapped lines (type, address,
 * contractor names) are attached to the nearest anchor via y-midpoint blocks.
 */
export function parseLewisPermitPage(items: PdfTextItem[]): LewisPermitRow[] {
  const cols = findColumns(items);
  if (!cols) return [];
  const colOf = (x: number) => cols.bounds.find((b) => x >= b.from && x < b.to)?.name ?? null;

  const body = items.filter((i) => i.y > cols.headerY + 6);
  const anchors = body
    .filter((i) => colOf(i.x) === "applicationNumber" && ANCHOR_RE.test(i.text))
    .sort((a, b) => a.y - b.y);
  if (anchors.length === 0) return [];

  const blockEdge = (i: number) =>
    i < 0
      ? cols.headerY + 6
      : i >= anchors.length - 1
        ? Infinity
        : (anchors[i]!.y + anchors[i + 1]!.y) / 2;

  return anchors.map((anchor, ai) => {
    const from = blockEdge(ai - 1);
    const to = blockEdge(ai);
    const block = body.filter((i) => i.y >= from && i.y < to);

    const cells = new Map<string, PdfTextItem[]>();
    for (const it of block) {
      const col = colOf(it.x);
      if (!col) continue;
      if (!cells.has(col)) cells.set(col, []);
      cells.get(col)!.push(it);
    }
    const cellLines = (col: string): string[] =>
      (cells.get(col) ?? [])
        .sort((a, b) => a.y - b.y || a.x - b.x)
        .map((i) => i.text);
    const cellText = (col: string): string | null => {
      const t = cellLines(col).join(" ").replace(/\s+/g, " ").trim();
      return t || null;
    };

    // The type/address column wraps: address is the line starting with a
    // street number; everything else is the application type.
    const taLines = cellLines("applicationType");
    const addressLines = taLines.filter((l) => /^\d+ /.test(l));
    const typeLines = taLines.filter((l) => !/^\d+ /.test(l));

    // Valuation is a single cell printed on the anchor line; anything farther
    // down the block is footer content (e.g. the report's grand total).
    const valuationItem = (cells.get("valuation") ?? []).find(
      (i) => Math.abs(i.y - anchor.y) <= 8,
    );
    const rawValuation = valuationItem?.text ?? null;
    const valuation = rawValuation
      ? Number(rawValuation.replace(/[$,]/g, ""))
      : null;

    const contractor = cellText("primaryContractor");

    return {
      applicationNumber: anchor.text,
      issuedDate: usDateToIso(cellText("issuedDate") ?? ""),
      applicationType: typeLines.join(" ").replace(/\s+/g, " ").trim() || null,
      siteAddress: addressLines.join(" ").replace(/\s+/g, " ").trim() || null,
      parcel: cellText("parcel"),
      applicant: cellText("applicant"),
      primaryContractor: contractor,
      valuation: valuation !== null && Number.isFinite(valuation) && valuation > 0 ? valuation : null,
    };
  });
}

/**
 * M1.3 — Lewis issued building permits (spec §6.2, P0). Weekly
 * "Issued Permits with Valuation" PDFs discovered from the Building Permit
 * Data index page; the rotated table is parsed via positioned text with
 * wrapped-row handling and applicant/primary-contractor separation.
 */
export class LewisIssuedPermitsAdapter implements SourceAdapter {
  readonly key = "lewis_issued_permits";
  readonly parserVersion = "1.0.0";

  private maxReportDate = "";

  async discover(ctx: RunContext): Promise<DiscoveredArtifact[]> {
    const body = await httpGet(LEWIS_PERMIT_DATA_URL, ctx);
    const $ = loadHtml(body);
    const links = extractLinks($, $("body"), LEWIS_PERMIT_DATA_URL).filter((l) =>
      /\/(documents|media\/documents)\//.test(l.url) && /\.pdf(\?|$)/i.test(l.url),
    );

    const highWater = String(ctx.checkpoint?.["reportDateHighWater"] ?? "");
    const floor = ctx.backfill
      ? ctx.backfill.from
      : new Date(
          Date.parse(highWater || new Date().toISOString().slice(0, 10)) -
            (highWater ? OVERLAP_DAYS : DEFAULT_WINDOW_DAYS) * 86_400_000,
        )
          .toISOString()
          .slice(0, 10);
    const ceiling = ctx.backfill?.to ?? "9999-12-31";

    const out: DiscoveredArtifact[] = [];
    const seen = new Set<string>();
    for (const l of links) {
      const date = reportDateFromFilename(l.url);
      if (!date) {
        // Older BldgPermits_* naming without a parseable date — outside the
        // dated weekly series this adapter covers; logged, never guessed.
        ctx.logger.info({ url: l.url }, "skipping non-dated permit report");
        continue;
      }
      if (date > this.maxReportDate) this.maxReportDate = date;
      if (date < floor || date > ceiling) continue;
      const name = l.url.split("/").pop()!;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({
        idempotencyKey: `${this.key}:${name}`,
        canonicalUrl: l.url,
        parentUrl: LEWIS_PERMIT_DATA_URL,
        expectedContentType: "application/pdf",
        sourcePublishedAt: date,
        meta: { reportDate: date },
      });
    }
    if (this.maxReportDate && !ctx.backfill) {
      ctx.setCheckpoint({ reportDateHighWater: this.maxReportDate });
    }
    return out;
  }

  async fetch(item: DiscoveredArtifact, ctx: RunContext): Promise<RawArtifact> {
    return httpFetchArtifact(item, ctx);
  }

  async parse(raw: RawArtifact, _ctx: RunContext): Promise<ParsedSourceRecord[]> {
    const pages = await extractPdfTextItems(raw.body);
    const rows = pages.flatMap((p) => parseLewisPermitPage(p.items));
    if (rows.length === 0) {
      throw new Error(
        `no permit rows parsed from ${raw.discovered.canonicalUrl} — table layout changed?`,
      );
    }
    const reportDate = (raw.discovered.meta as { reportDate?: string } | undefined)?.reportDate ?? null;

    return rows.map((row) => {
      const organizations: { name: string; role: string | null; evidenceText: string }[] = [];
      if (row.applicant) {
        organizations.push({
          name: row.applicant,
          role: "applicant",
          evidenceText: `Applicant: ${row.applicant}`,
        });
      }
      if (row.primaryContractor && !/^TBD\b/i.test(row.primaryContractor)) {
        organizations.push({
          name: row.primaryContractor,
          role: "primary_contractor",
          evidenceText: `Primary Contractor: ${row.primaryContractor}`,
        });
      }
      return {
        rawFields: { ...row, reportDate },
        record: {
          sourceKey: this.key,
          externalId: row.applicationNumber,
          recordType: "building_permit",
          title: `${row.applicationNumber} – ${row.applicationType ?? "permit"}${row.siteAddress ? ` at ${row.siteAddress}` : ""}`,
          description: null,
          permittingJurisdiction: "Lewis County",
          county: "Lewis",
          city: null,
          addressRaw: row.siteAddress,
          parcelIds: row.parcel ? [row.parcel] : [],
          geometry: null,
          applicationType: null,
          permitType: row.applicationType,
          documentType: "issued_permit_report",
          statusRaw: "issued",
          normalizedStage: "permit_issued",
          applicationDate: null,
          issueDate: row.issuedDate,
          sourceUpdatedAt: null,
          valuationUsd: row.valuation,
          units: null,
          lots: null,
          squareFeet: null,
          organizations,
          sourceUrl: raw.discovered.canonicalUrl,
          evidence: [
            {
              factPath: "externalId",
              text: row.applicationNumber,
              pageOrSection: "Issued Permits with Valuation table",
            },
            ...(row.issuedDate
              ? [
                  {
                    factPath: "issueDate",
                    text: `Issued Date: ${row.issuedDate}`,
                    pageOrSection: "Issued Date column",
                  },
                ]
              : []),
            ...(row.valuation !== null
              ? [
                  {
                    factPath: "valuationUsd",
                    text: `Valuation: ${row.valuation}`,
                    pageOrSection: "Valuation column",
                  },
                ]
              : []),
            ...organizations.map((o) => ({
              factPath: "organizations",
              text: o.evidenceText,
              pageOrSection: `${o.role} column`,
            })),
          ],
        },
      };
    });
  }

}
