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

export const LACEY_PERMIT_REPORTS_URL = "https://cityoflacey.org/permit%20reports/";

const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
};

/**
 * "June-2026-Census-Report-New-Construction.pdf" → "2026-06".
 * Some filenames omit the year ("April-Monthly-Census-Report-…"); fall back to
 * the upload path "/uploads/sites/3/2026/05/" (upload month = report month+1,
 * so the report month is the filename month with the path year).
 */
export function censusMonthFromUrl(url: string): string | null {
  const name = decodeURIComponent(url.split("/").pop() ?? "").toLowerCase();
  if (!/census/.test(name)) return null;
  const monthWord = Object.keys(MONTHS).find((m) => name.startsWith(m));
  if (!monthWord) return null;
  const yearInName = /-(\d{4})-/.exec(name)?.[1];
  const yearInPath = /\/uploads\/sites\/\d+\/(\d{4})\//.exec(url)?.[1];
  const year = yearInName ?? yearInPath;
  if (!year) return null;
  return `${year}-${MONTHS[monthWord]}`;
}

const ANCHOR_RE = /^BLDG\d{2}-\d{3,5}$/;

export interface LaceyCensusRow {
  permitNumber: string;
  permitType: string | null;
  permitSubtype: string | null;
  siteAddress: string | null;
  issuedDate: string | null;
  units: number | null;
  valuation: number | null;
}

function usDateToIso(s: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s.trim());
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

type ColName =
  | "permitNumber" | "permitType" | "permitSubtype" | "siteAddress"
  | "issuedDate" | "units" | "valuation";

interface Columns {
  headerBottom: number;
  bounds: { name: ColName; from: number; to: number }[];
  hasInlineValuation: boolean;
}

/**
 * The census layout varies month to month: headers wrap differently and the
 * per-permit valuation is sometimes an inline column (May 2026), sometimes a
 * separate trailing page (June 2026). Columns are located from the header
 * band itself, never assumed.
 */
function findCensusColumns(items: PdfTextItem[]): Columns | null {
  const master = items.find((i) => i.text.startsWith("Permit Master"));
  if (!master) return null;
  const band = items.filter((i) => i.y >= master.y - 4 && i.y <= master.y + 22);

  // Cluster header fragments by x proximity, then classify each cluster.
  const clusters: { x: number; texts: string[] }[] = [];
  for (const i of band.sort((a, b) => a.x - b.x)) {
    const c = clusters.find((cl) => Math.abs(cl.x - i.x) < 40);
    if (c) c.texts.push(i.text);
    else clusters.push({ x: i.x, texts: [i.text] });
  }
  const named: { name: ColName; x: number }[] = [];
  for (const c of clusters) {
    const t = c.texts.join(" ").toLowerCase();
    if (t.includes("master")) named.push({ name: "permitNumber", x: c.x });
    else if (t.includes("subtype")) named.push({ name: "permitSubtype", x: c.x });
    else if (t.includes("permit type")) named.push({ name: "permitType", x: c.x });
    else if (t.includes("site address")) named.push({ name: "siteAddress", x: c.x });
    else if (t.includes("no_units")) named.push({ name: "units", x: c.x });
    else if (t.includes("valuation")) named.push({ name: "valuation", x: c.x });
    else if (t.includes("issued")) named.push({ name: "issuedDate", x: c.x });
  }
  const required: ColName[] = ["permitNumber", "permitType", "permitSubtype", "siteAddress", "issuedDate", "units"];
  if (!required.every((r) => named.some((n) => n.name === r))) return null;

  const sorted = named.sort((a, b) => a.x - b.x);
  const bounds = sorted.map((c, i) => ({
    name: c.name,
    from: i === 0 ? -Infinity : (sorted[i - 1]!.x + c.x) / 2,
    to: i === sorted.length - 1 ? Infinity : (c.x + sorted[i + 1]!.x) / 2,
  }));
  return {
    headerBottom: master.y + 22,
    bounds,
    hasInlineValuation: named.some((n) => n.name === "valuation"),
  };
}

function parseMoney(s: string): number | null {
  if (!/^\$?[\d,]+\.\d{2}$/.test(s.trim())) return null;
  const v = Number(s.replace(/[$,]/g, ""));
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Parse the census report from positioned text. Type/subtype print only on
 * the first row of each group and carry forward. Footer totals are cut off at
 * the "Total Number of" line. When the valuation column is not inline, a
 * trailing "Permit Valuations Amt" page lists per-row valuations in the same
 * order plus a grand total; they pair by index — on a count mismatch every
 * valuation stays null (never guessed).
 */
export function parseLaceyCensus(pages: { pageNumber: number; items: PdfTextItem[] }[]): {
  rows: LaceyCensusRow[];
  valuationMismatch: boolean;
} {
  const rows: LaceyCensusRow[] = [];
  let carryType: string | null = null;
  let carrySubtype: string | null = null;
  let sawInlineValuation = false;

  for (const page of pages) {
    const items = page.items;
    const cols = findCensusColumns(items);
    if (!cols) continue; // valuation-only page handled below
    if (cols.hasInlineValuation) sawInlineValuation = true;
    const colOf = (x: number) => cols.bounds.find((b) => x >= b.from && x < b.to)?.name ?? null;

    // Footer label wraps differently by month ("Total Number of" / "Total Number").
    const footer = items.find((i) => i.text.startsWith("Total Number"));
    const bodyBottom = footer ? footer.y - 4 : Infinity;
    const body = items.filter((i) => i.y > cols.headerBottom && i.y < bodyBottom);

    const anchors = body
      .filter((i) => colOf(i.x) === "permitNumber" && ANCHOR_RE.test(i.text.trim()))
      .sort((a, b) => a.y - b.y);

    anchors.forEach((anchor, ai) => {
      // A row owns everything from its anchor line down to just above the
      // next anchor — wrapped cells (subtype over three lines) always sit
      // below their anchor, never above the next one.
      const from = anchor.y - 4;
      const to = ai === anchors.length - 1 ? bodyBottom : anchors[ai + 1]!.y - 4;
      const block = body.filter((i) => i.y >= from && i.y < to && i !== anchor);
      const cell = (name: ColName): string[] =>
        block
          .filter((i) => colOf(i.x) === name)
          .sort((a, b) => a.y - b.y || a.x - b.x)
          .map((i) => i.text.trim())
          .filter(Boolean);

      const typeLines = cell("permitType");
      const subtypeLines = cell("permitSubtype");
      if (typeLines.length > 0) carryType = typeLines.join(" ");
      if (subtypeLines.length > 0) carrySubtype = subtypeLines.join(" ");

      // Units and inline valuation are adjacent numeric columns whose cell x
      // jitters across months — disambiguate by content, not position: units
      // are bare small integers, valuations match money format.
      const numericZone = block
        .filter((i) => {
          const col = colOf(i.x);
          return col === "units" || col === "valuation";
        })
        .sort((a, b) => a.y - b.y || a.x - b.x)
        .map((i) => i.text.trim());
      const unitsRaw = numericZone.find((t) => /^\d{1,4}$/.test(t));
      const units = unitsRaw ? Number(unitsRaw) : NaN;
      const valuationRaw = cols.hasInlineValuation
        ? numericZone.find((t) => /^\$?[\d,]+\.\d{2}$/.test(t))
        : undefined;

      rows.push({
        permitNumber: anchor.text.trim(),
        permitType: carryType,
        permitSubtype: carrySubtype,
        siteAddress: cell("siteAddress").join(", ").replace(/\s+/g, " ") || null,
        issuedDate: usDateToIso(cell("issuedDate")[0] ?? ""),
        units: Number.isFinite(units) && units > 0 ? units : null,
        valuation: valuationRaw ? parseMoney(valuationRaw) : null,
      });
    });
  }

  let valuationMismatch = false;
  if (!sawInlineValuation) {
    // Separate valuation page: "$1,234.56" items in row order; the
    // unprefixed grand total is excluded by the $ requirement.
    const valuations = pages
      .flatMap((p) =>
        p.items.some((i) => i.text === "Permit Valuations Amt") ? p.items : [],
      )
      .filter((i) => /^\$[\d,]+\.\d{2}$/.test(i.text.trim()))
      .sort((a, b) => a.y - b.y)
      .map((i) => Number(i.text.replace(/[$,]/g, "")));
    if (valuations.length === rows.length) {
      rows.forEach((r, i) => {
        const v = valuations[i]!;
        r.valuation = Number.isFinite(v) && v > 0 ? v : null;
      });
    } else if (valuations.length > 0) {
      valuationMismatch = true;
    }
  }
  return { rows, valuationMismatch };
}

/**
 * M4.5 — City of Lacey monthly census reports (spec §6.2 P1
 * `lacey_permit_reports`). Permit-level new-construction data (permit number,
 * subtype, address, issue date, dwelling units, valuation) that the Lacey
 * planning-project sources don't carry. Discovered from the official Permit
 * Reports page; monthly cadence; historical PDFs back to 2015 support
 * backfill.
 */
export class LaceyPermitReportsAdapter implements SourceAdapter {
  readonly key = "lacey_permit_reports";
  readonly parserVersion = "1.0.0";

  private maxMonth = "";

  async discover(ctx: RunContext): Promise<DiscoveredArtifact[]> {
    const body = await httpGet(LACEY_PERMIT_REPORTS_URL, ctx);
    const $ = loadHtml(body);
    const links = extractLinks($, $("body"), LACEY_PERMIT_REPORTS_URL).filter((l) =>
      /\/wp-content\/uploads\/.*\.pdf(\?|$)/i.test(l.url),
    );

    const highWater = String(ctx.checkpoint?.["censusMonthHighWater"] ?? "");
    // Month strings compare lexicographically; refetch the last month so a
    // republished report is picked up (content hash dedupes unchanged files).
    const floor = ctx.backfill
      ? ctx.backfill.from.slice(0, 7)
      : highWater || new Date(Date.now() - 120 * 86_400_000).toISOString().slice(0, 7);
    const ceiling = ctx.backfill?.to.slice(0, 7) ?? "9999-12";

    const out: DiscoveredArtifact[] = [];
    const seen = new Set<string>();
    for (const l of links) {
      const month = censusMonthFromUrl(l.url);
      if (!month) continue; // activity/summary PDFs carry counts, not records
      if (month > this.maxMonth) this.maxMonth = month;
      if (month < floor || month > ceiling) continue;
      if (seen.has(month)) continue;
      seen.add(month);
      out.push({
        idempotencyKey: `${this.key}:${month}`,
        canonicalUrl: l.url,
        parentUrl: LACEY_PERMIT_REPORTS_URL,
        expectedContentType: "application/pdf",
        sourcePublishedAt: `${month}-01`,
        meta: { reportMonth: month },
      });
    }
    if (this.maxMonth && !ctx.backfill) {
      ctx.setCheckpoint({ censusMonthHighWater: this.maxMonth });
    }
    return out;
  }

  async fetch(item: DiscoveredArtifact, ctx: RunContext): Promise<RawArtifact> {
    return httpFetchArtifact(item, ctx);
  }

  async parse(raw: RawArtifact, ctx: RunContext): Promise<ParsedSourceRecord[]> {
    const pages = await extractPdfTextItems(raw.body);
    const { rows, valuationMismatch } = parseLaceyCensus(pages);
    if (rows.length === 0) {
      throw new Error(
        `no census rows parsed from ${raw.discovered.canonicalUrl} — layout changed?`,
      );
    }
    if (valuationMismatch) {
      ctx.logger.warn(
        { url: raw.discovered.canonicalUrl },
        "census valuation count mismatch — valuations left null",
      );
    }
    const reportMonth =
      (raw.discovered.meta as { reportMonth?: string } | undefined)?.reportMonth ?? null;

    return rows.map((row) => ({
      rawFields: { ...row, reportMonth },
      record: {
        sourceKey: this.key,
        externalId: row.permitNumber,
        recordType: "building_permit",
        title: `${row.permitNumber} – NEW CONSTRUCTION ${row.permitSubtype ?? ""}`.trim() +
          (row.siteAddress ? ` at ${row.siteAddress}` : ""),
        description: null,
        permittingJurisdiction: "City of Lacey",
        county: "Thurston",
        city: "Lacey",
        addressRaw: row.siteAddress,
        parcelIds: [],
        geometry: null,
        applicationType: null,
        permitType: [row.permitType, row.permitSubtype].filter(Boolean).join(" ") || null,
        documentType: "monthly_census_report",
        statusRaw: "issued",
        normalizedStage: "permit_issued",
        applicationDate: null,
        issueDate: row.issuedDate,
        sourceUpdatedAt: null,
        valuationUsd: row.valuation,
        units: row.units,
        lots: null,
        squareFeet: null,
        organizations: [],
        sourceUrl: raw.discovered.canonicalUrl,
        evidence: [
          {
            factPath: "externalId",
            text: row.permitNumber,
            pageOrSection: "Monthly Census Report (New Construction)",
          },
          ...(row.issuedDate
            ? [{ factPath: "issueDate", text: `Permit Issued: ${row.issuedDate}`, pageOrSection: "Permit Issued column" }]
            : []),
          ...(row.units !== null
            ? [{ factPath: "units", text: `NO_UNITS: ${row.units}`, pageOrSection: "NO_UNITS column" }]
            : []),
          ...(row.valuation !== null
            ? [{ factPath: "valuationUsd", text: `Permit Valuations Amt: ${row.valuation}`, pageOrSection: "Permit Valuations Amt page" }]
            : []),
          ...(row.siteAddress
            ? [{ factPath: "addressRaw", text: row.siteAddress, pageOrSection: "Permit Site Address column" }]
            : []),
        ],
      },
    }));
  }
}
