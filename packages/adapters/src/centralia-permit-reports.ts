import { z } from "zod";
import type { NormalizedSourceRecord } from "@otn/domain";
import type {
  DiscoveredArtifact,
  InvariantViolation,
  ParsedSourceRecord,
  RawArtifact,
  RunContext,
  SourceAdapter,
} from "@otn/source-sdk";
import { httpFetchArtifact, httpGet, reconcileSum } from "@otn/source-sdk";
import { extractPdfTextItems, readXlsx, type PdfTextItem } from "@otn/documents";

/**
 * City of Centralia monthly issued-permit reports (Lewis County's largest
 * city — a Solis home-market SFR gap; the county's own sources cover
 * unincorporated Lewis). The Building Permit Statistics page lists one report
 * per month (series observed Nov 2024 → Jun 2026, verified live 2026-07-18):
 * spreadsheet-style tables with permit number, type, ISSUE date, owner,
 * address, parcel, CONTRACTOR, comments, and stated value — contractor names
 * feed the GC league directly (e.g. Century Communities pulling $379–438k
 * SFR-New permits in Feb 2026).
 *
 * Formats are mixed: most months are PDF; at least one (Mar 2025) is XLSX.
 * Both are parsed; anything else warns and yields no records (never guessed).
 */

export const CENTRALIA_INDEX_URL = "https://www.cityofcentralia.com/524/Building-Permit-Statistics";
const HOST = "https://www.cityofcentralia.com";

const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
};

/** "June 2026 Monthly Permit Report" / "December 2024 - Issued Permits" → "2026-06". */
export function reportMonthFromTitle(title: string): string | null {
  const m = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b[^\d]*(\d{4})/i.exec(
    title,
  );
  if (!m) return null;
  return `${m[2]}-${MONTHS[m[1]!.toLowerCase()]}`;
}

const ROW_ANCHOR_RE = /^\d{7,9}$/; // permit numbers: 20260056, 202500798 (source typo'd 9-digit)
const DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const MONEY_RE = /^\$?\s*([\d,]+\.\d{2})\s*\$?$/;

function usDateToIso(s: string): string | null {
  const m = DATE_RE.exec(s.trim());
  if (!m) return null;
  return `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
}

function parseMoney(s: string): number | null {
  const m = MONEY_RE.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface CentraliaRow {
  permitNumber: string;
  permitType: string | null;
  issueDate: string | null;
  owner: string | null;
  address: string | null;
  parcels: string[];
  contractor: string | null;
  comments: string | null;
  valuation: number | null;
}

type ColName =
  | "permit" | "type" | "date" | "owner" | "address" | "parcel" | "contractor" | "comments" | "value";

const TEXT_COLS: ColName[] = [
  "permit", "type", "date", "owner", "address", "parcel", "contractor", "comments",
];

/**
 * Column x positions cannot come from the header labels (they are rotated /
 * offset from the data in every observed format), and raw x clustering fails
 * on old-format pages whose cells emit WORD-level glyph runs (intra-cell word
 * positions look like columns). Instead, derive geometry STRUCTURALLY from
 * the data itself:
 *
 *   1. Pin the three unambiguous columns by content — permit numbers (7–9
 *      leading digits), dates (leading M/D/YYYY), parcels (10+ leading
 *      digits) — at the modal x of their matching items.
 *   2. The remaining columns are the highest-frequency x clusters in the
 *      intervals between the pins: cell starts repeat on every row, while
 *      intra-cell word positions scatter. type ∈ (permit, date); owner and
 *      address ∈ (date, parcel); contractor and comments right of parcel.
 *
 * Returns null when any column cannot be resolved (e.g. a sparse spill page
 * with one row) — the caller falls back to the previous page's geometry.
 * `body` must already exclude the header band and the TOTAL line.
 */
function findColumns(body: PdfTextItem[]): { name: ColName; x: number }[] | null {
  /** Top-k frequency peaks among rounded xs in (lo, hi), each ≥6 pt apart,
   * returned in ascending x. Word-level pages scatter intra-cell xs thinly
   * while cell starts repeat every row, so peaks are the cell starts. */
  const peaksIn = (values: number[], lo: number, hi: number, k: number): number[] | null => {
    const bins = new Map<number, number>();
    for (const v of values) {
      if (v <= lo || v >= hi) continue;
      const b = Math.round(v);
      bins.set(b, (bins.get(b) ?? 0) + 1);
    }
    const sorted = [...bins.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    const peaks: number[] = [];
    for (const [x] of sorted) {
      if (peaks.some((p) => Math.abs(p - x) <= 6)) continue;
      peaks.push(x);
      if (peaks.length === k) break;
    }
    if (peaks.length < k) return null;
    return peaks.sort((a, b) => a - b);
  };
  const modal = (items: PdfTextItem[]): number | null =>
    peaksIn(items.map((i) => i.x), -Infinity, Infinity, 1)?.[0] ?? null;

  const permitX = modal(body.filter((i) => leadingPermitNumber(i.text) !== null));
  const dateX = modal(body.filter((i) => /^\d{1,2}\/\d{1,2}\/\d{4}(\s|$)/.test(i.text.trim())));
  const parcelX = modal(body.filter((i) => /^\d{10,}(\s|$)/.test(i.text.trim())));
  if (permitX === null || dateX === null || parcelX === null) return null;
  if (!(permitX < dateX && dateX < parcelX)) return null;

  const substantive: number[] = [];
  for (const it of body) {
    const t = it.text.trim();
    if (!t || t === "$" || MONEY_RE.test(t) || /^\d{1,3}$/.test(t) || /^[‐-]+$/.test(t)) continue;
    substantive.push(it.x);
  }
  const type = peaksIn(substantive, permitX + 3, dateX - 3, 1);
  const ownerAddress = peaksIn(substantive, dateX + 3, parcelX - 3, 2);
  const contractorComments = peaksIn(substantive, parcelX + 3, Infinity, 2);
  if (!type || !ownerAddress || !contractorComments) return null;

  const xs = [permitX, type[0]!, dateX, ownerAddress[0]!, ownerAddress[1]!, parcelX, contractorComments[0]!, contractorComments[1]!];
  return TEXT_COLS.map((name, i) => ({ name, x: xs[i]! }));
}

/** Assign an item to a column: money/"$" → value; lone digits or dashes right
 * of the comments column are category-count marks / blank-value dashes → null
 * (dropped); other far-right text is wrapped comment words (old word-level
 * format); else the nearest text column at or left of the item. */
function colOf(
  it: PdfTextItem,
  cols: { name: ColName; x: number }[],
): ColName | null {
  const t = it.text.trim();
  const commentsX = cols[cols.length - 1]!.x;
  if (t === "$" || MONEY_RE.test(t)) return it.x > commentsX ? "value" : null;
  if (it.x > commentsX + 30) {
    return /^\d{1,3}$/.test(t) || /^[‐-]+$/.test(t) ? null : "comments";
  }
  let best: ColName | null = null;
  for (const c of cols) if (it.x >= c.x - 4) best = c.name;
  return best;
}

/**
 * The permit number at the head of a text run, tolerating the source's glyph
 * quirks: the number may be merged with the type ("202500798 Mechanical") and
 * may itself contain an internal space ("2026 0328 Demo" = permit 20260328).
 * Leading digit tokens are joined (capped at 9 digits) and must form a valid
 * permit number; everything after is the spill-over of the TYPE cell.
 */
export function leadingPermitNumber(text: string): { permit: string; rest: string } | null {
  const tokens = text.trim().split(/\s+/);
  let joined = "";
  let i = 0;
  while (i < tokens.length && /^\d+$/.test(tokens[i]!) && joined.length + tokens[i]!.length <= 9) {
    joined += tokens[i]!;
    i += 1;
  }
  if (!ROW_ANCHOR_RE.test(joined)) return null;
  return { permit: joined, rest: tokens.slice(i).join(" ") };
}

/** Anchor = a permit-column item whose leading digits form a permit number. */
function isAnchor(it: PdfTextItem, cols: { name: ColName; x: number }[]): boolean {
  return colOf(it, cols) === "permit" && leadingPermitNumber(it.text) !== null;
}

/**
 * The permit number ANYWHERE in an assembled permit cell. When the type/permit
 * column boundary drifts a few pt (word-level pages where most types merge
 * into the permit glyph run), a wrapped type word can precede the number in
 * the cell ("SFR 20250219 Remodel") — every non-number token is TYPE spill.
 */
export function permitFromCell(text: string): { permit: string; rest: string } | null {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  for (let s = 0; s < tokens.length; s += 1) {
    if (!/^\d+$/.test(tokens[s]!)) continue;
    let joined = "";
    let e = s;
    while (e < tokens.length && /^\d+$/.test(tokens[e]!) && joined.length + tokens[e]!.length <= 9) {
      joined += tokens[e]!;
      e += 1;
    }
    if (ROW_ANCHOR_RE.test(joined)) {
      return { permit: joined, rest: [...tokens.slice(0, s), ...tokens.slice(e)].join(" ") };
    }
  }
  return null;
}

const MONTH_TITLE_RE = new RegExp(`^(${Object.keys(MONTHS).join("|")})\\s+\\d{4}$`, "i");
const MONTH_WORD_RE = new RegExp(`^(${Object.keys(MONTHS).join("|")})$`, "i");

/**
 * Parse one report's pages into rows. Cells are BOTTOM-ALIGNED on the row's
 * permit-number anchor line: a wrapped cell's fragments stack UPWARD, ending
 * on the anchor line ("1027 N" / "Washington" / "Avenue" across three lines).
 * Every body item therefore belongs to the FIRST anchor at-or-below it;
 * items below the last anchor (footers) and the page's month title are
 * dropped, never guessed into a row.
 */
export function parseCentraliaPdf(pages: { pageNumber: number; items: PdfTextItem[] }[]): {
  rows: CentraliaRow[];
  printedTotal: number | null;
} {
  const rows: CentraliaRow[] = [];
  let printedTotal: number | null = null;

  // Pass 1 — per-page table bodies + the printed total.
  const pageBodies: PdfTextItem[][] = [];
  for (const page of pages) {
    // The printed monthly total appears once, on the last page of the table.
    // Its value glyphs sit a few pt below the "TOTAL FOR <Month>" label — one
    // glyph run in recent reports, split word runs ("TOTAL" / "FOR") in the
    // pre-May-2025 format.
    const totalItem = page.items.find((i) => {
      const t = i.text.trim();
      if (/TOTAL FOR/i.test(t)) return true;
      if (!/^TOTAL$/i.test(t)) return false;
      return page.items.some((j) => Math.abs(j.y - i.y) <= 2 && /^FOR$/i.test(j.text.trim()));
    });
    if (totalItem) {
      const money = page.items
        .filter((i) => i.y >= totalItem.y && i.y <= totalItem.y + 8)
        .map((i) => i.text.trim())
        .find((t) => MONEY_RE.test(t));
      if (money) printedTotal = parseMoney(money);
    }
    // Header bands ABOVE the table bound the body; the last page may repeat
    // "PERMIT NUMBER" in a legend BELOW the total, which must not. Recent
    // reports print the label as one glyph run; the pre-May-2025 format
    // stacks it as separate "PERMIT" / "NUMBER" words at the same x — the
    // lower word sits on the actual header line.
    let headerY: number | null = null;
    for (const i of page.items) {
      const t = i.text.trim();
      if (totalItem && i.y >= totalItem.y) continue;
      if (/^PERMIT NUMBER$/i.test(t)) {
        headerY = i.y;
        break;
      }
      // Split-word variant: "PERMIT"/"NUMBER" stacked at the same x. The
      // stacking direction and gap vary by format (tall vertically-centered
      // header cells) — the lower word marks the bottom of the header band.
      if (/^PERMIT$/i.test(t)) {
        const num = page.items.find(
          (j) =>
            /^NUMBER$/i.test(j.text.trim()) &&
            Math.abs(j.x - i.x) <= 3 &&
            j.y !== i.y &&
            Math.abs(j.y - i.y) <= 30,
        );
        if (num) {
          headerY = Math.max(i.y, num.y);
          break;
        }
      }
    }
    pageBodies.push(
      page.items.filter(
        (i) =>
          (headerY === null || i.y > headerY + 2) && (!totalItem || i.y < totalItem.y - 2),
      ),
    );
  }
  // Pass 2 — column geometry is derived structurally PER PAGE (one document
  // can mix layouts, observed Mar 2025); a page too sparse to resolve its own
  // columns (e.g. carrying only the last spilled row) inherits the previous
  // page's geometry.
  let lastCols: { name: ColName; x: number }[] | null = null;
  for (const body of pageBodies) {
    const cols: { name: ColName; x: number }[] | null = findColumns(body) ?? lastCols;
    if (!cols) continue;
    lastCols = cols;
    const anchors = body.filter((i) => isAnchor(i, cols)).sort((a, b) => a.y - b.y);
    if (anchors.length === 0) continue;

    // The month title inside the table region prints as one run ("FEBRUARY
    // 2026") or as split word runs ("MARCH" + "2025") — drop both forms.
    const titleItems = new Set<PdfTextItem>();
    for (const it of body) {
      if (!MONTH_WORD_RE.test(it.text.trim())) continue;
      const yr = body.find(
        (j) =>
          /^\d{4}$/.test(j.text.trim()) &&
          Math.abs(j.y - it.y) <= 2 &&
          j.x > it.x &&
          j.x - it.x <= 80,
      );
      if (yr) {
        titleItems.add(it);
        titleItems.add(yr);
      }
    }

    const blocks: PdfTextItem[][] = anchors.map(() => []);
    for (const it of body) {
      if (MONTH_TITLE_RE.test(it.text.trim()) || titleItems.has(it)) continue;
      const k = anchors.findIndex((a) => it.y <= a.y + 2);
      if (k === -1) continue; // below the last anchor line — footer junk
      blocks[k]!.push(it);
    }

    for (const block of blocks) {
      const cell = (name: ColName) =>
        block
          .filter((i) => colOf(i, cols) === name)
          .sort((a, b) => a.y - b.y || a.x - b.x)
          .map((i) => i.text.trim())
          .filter(Boolean)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
      const lead = permitFromCell(cell("permit"));
      if (!lead) continue;
      const permitNumber = lead.permit;
      // Text merged into the permit glyph run beyond the number itself is
      // the start of the TYPE cell ("202500798 Mechanical", "2026 0328 Demo").
      const typeText = [lead.rest, cell("type")].filter(Boolean).join(" ");
      // Same quirk on the DATE run: "7/31/2025 Kathy Griffin" merges date +
      // the start of the OWNER cell.
      const dateTokens = cell("date").split(/\s+/).filter(Boolean);
      const dateText = dateTokens.find((t) => DATE_RE.test(t)) ?? "";
      const ownerSpill = dateText ? dateTokens.filter((t) => t !== dateText).join(" ") : "";
      const ownerText = [ownerSpill, cell("owner")].filter(Boolean).join(" ");
      rows.push({
        permitNumber,
        permitType: typeText || null,
        issueDate: usDateToIso(dateText),
        owner: ownerText || null,
        address: cell("address") || null,
        parcels: cell("parcel")
          .split(/[/\s]+/)
          .map((p) => p.trim())
          .filter((p) => /^\d{9,}$/.test(p)),
        contractor: cell("contractor") || null,
        comments: cell("comments") || null,
        valuation: parseMoney(cell("value")),
      });
    }
  }
  return { rows, printedTotal };
}

/** XLSX fallback (e.g. March 2025): same logical columns, header-name mapped. */
export function parseCentraliaXlsxRows(
  sheets: { name: string; rows: { value: string | number | null }[][] }[],
): CentraliaRow[] {
  const out: CentraliaRow[] = [];
  for (const sheet of sheets) {
    let headerMap: Partial<Record<ColName, number>> | null = null;
    for (const row of sheet.rows) {
      if (!row) continue;
      const texts = row.map((c) => (c?.value === null || c?.value === undefined ? "" : String(c.value)));
      if (!headerMap) {
        const idx = (re: RegExp) => texts.findIndex((t) => re.test(t.trim()));
        const permit = idx(/^PERMIT NUMBER$/i);
        if (permit >= 0) {
          headerMap = {
            permit,
            type: idx(/^PERMIT TYPE$/i),
            date: idx(/^DATE$/i),
            owner: idx(/^OWNER$/i),
            address: idx(/^ADDRESS$/i),
            parcel: idx(/^PARCEL NUMBER$/i),
            contractor: idx(/^CONTRACTOR$/i),
            comments: idx(/^COMMENTS$/i),
          };
        }
        continue;
      }
      const at = (name: ColName): string => {
        const i = headerMap![name];
        return i !== undefined && i >= 0 ? (texts[i] ?? "").trim() : "";
      };
      const permitNumber = at("permit");
      if (!ROW_ANCHOR_RE.test(permitNumber)) continue;
      // Value lives in the rightmost populated numeric cell.
      const money = [...texts].reverse().find((t) => MONEY_RE.test(t) || /^\d+(\.\d{2})?$/.test(t));
      out.push({
        permitNumber,
        permitType: at("type") || null,
        issueDate: usDateToIso(at("date")) ?? (DATE_RE.test(at("date")) ? at("date") : null),
        owner: at("owner") || null,
        address: at("address") || null,
        parcels: at("parcel")
          .split(/[/\s]+/)
          .filter((p) => /^\d{9,}$/.test(p)),
        contractor: at("contractor") || null,
        comments: at("comments") || null,
        valuation: money ? (parseMoney(money) ?? (Number(money) > 0 ? Number(money) : null)) : null,
      });
    }
  }
  return out;
}

const LinkSchema = z.object({ docId: z.string(), title: z.string(), month: z.string() });

/** "YYYY-MM" shifted back N months. */
function monthMinus(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const total = y * 12 + (m - 1) - n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

/** Reports at/after checkpoint-month minus this are (re)fetched: the prior
 * month's report can be amended/reposted after first publication. */
const OVERLAP_MONTHS = 1;
/** With no checkpoint, cover at least the 90-day backfill window. */
const DEFAULT_WINDOW_MONTHS = 4;

export class CentraliaPermitReportsAdapter implements SourceAdapter {
  readonly key = "centralia_permit_reports";
  readonly parserVersion = "1.0.0";

  async discover(ctx: RunContext): Promise<DiscoveredArtifact[]> {
    const body = (await httpGet(CENTRALIA_INDEX_URL, ctx)).toString("utf8");

    const highWater = String(ctx.checkpoint?.["monthHighWater"] ?? "");
    const floor = ctx.backfill
      ? ctx.backfill.from.slice(0, 7)
      : monthMinus(
          highWater || new Date().toISOString().slice(0, 7),
          highWater ? OVERLAP_MONTHS : DEFAULT_WINDOW_MONTHS,
        );
    const ceiling = ctx.backfill?.to.slice(0, 7) ?? "9999-12";

    let maxMonth = "";
    const out: DiscoveredArtifact[] = [];
    const seen = new Set<string>();
    const re = /href="\/DocumentCenter\/View\/(\d+)\/([^"]+)"[^>]*>([^<]*)</g;
    for (const m of body.matchAll(re)) {
      const title = (m[3] ?? "").trim() || decodeURIComponent(m[2]!).replace(/-/g, " ");
      const month = reportMonthFromTitle(title);
      if (!month) continue;
      if (!/permit|issued/i.test(title)) continue;
      const link = LinkSchema.parse({ docId: m[1]!, title, month });
      if (seen.has(link.docId)) continue;
      seen.add(link.docId);
      if (link.month > maxMonth) maxMonth = link.month;
      if (link.month < floor || link.month > ceiling) continue;
      out.push({
        idempotencyKey: `${this.key}:doc-${link.docId}`,
        canonicalUrl: `${HOST}/DocumentCenter/View/${link.docId}/${m[2]}`,
        parentUrl: CENTRALIA_INDEX_URL,
        expectedContentType: "application/pdf",
        sourcePublishedAt: null,
        meta: { month: link.month, title: link.title, docId: link.docId },
      });
    }
    ctx.logger.info({ reports: out.length, floor, ceiling }, "centralia permit reports discovered");
    if (maxMonth === "") {
      throw new Error("Centralia index yielded zero report links — page layout changed?");
    }
    if (maxMonth && !ctx.backfill) ctx.setCheckpoint({ monthHighWater: maxMonth });
    return out;
  }

  async fetch(item: DiscoveredArtifact, ctx: RunContext): Promise<RawArtifact> {
    return httpFetchArtifact(item, ctx);
  }

  private rowsFor = new WeakMap<RawArtifact, { rows: CentraliaRow[]; printedTotal: number | null }>();

  private async extractRows(raw: RawArtifact, ctx: RunContext) {
    const cached = this.rowsFor.get(raw);
    if (cached) return cached;
    let result: { rows: CentraliaRow[]; printedTotal: number | null };
    const head = raw.body.subarray(0, 4).toString("latin1");
    if (head.startsWith("%PDF")) {
      result = parseCentraliaPdf(await extractPdfTextItems(raw.body));
      if (result.rows.length === 0) {
        throw new Error("Centralia PDF yielded no permit rows — table layout changed?");
      }
    } else if (head.startsWith("PK")) {
      result = { rows: parseCentraliaXlsxRows(await readXlsx(raw.body)), printedTotal: null };
    } else {
      ctx.logger.warn({ head }, "centralia report is neither PDF nor XLSX — no records emitted");
      result = { rows: [], printedTotal: null };
    }
    this.rowsFor.set(raw, result);
    return result;
  }

  async parse(raw: RawArtifact, ctx: RunContext): Promise<ParsedSourceRecord[]> {
    const meta = (raw.discovered.meta ?? {}) as { month?: string; title?: string };
    const { rows } = await this.extractRows(raw, ctx);
    return rows.map((r) => {
      // "Owner" in the contractor column means owner-performed — not an org.
      const contractor = r.contractor && !/^owner$/i.test(r.contractor) ? r.contractor : null;
      const organizations: NormalizedSourceRecord["organizations"] = [
        ...(contractor
          ? [{ name: contractor, role: "primary_contractor", evidenceText: `Contractor: ${contractor}` }]
          : []),
        ...(r.owner ? [{ name: r.owner, role: "owner", evidenceText: `Owner: ${r.owner}` }] : []),
      ];
      return {
        rawFields: { ...r, reportMonth: meta.month ?? null, reportTitle: meta.title ?? null },
        record: {
          sourceKey: this.key,
          externalId: r.permitNumber,
          recordType: "building_permit",
          title: `${r.permitNumber} – ${r.permitType ?? "Centralia permit"}`,
          description: r.comments,
          permittingJurisdiction: "City of Centralia",
          county: "Lewis",
          city: "Centralia",
          addressRaw: r.address,
          parcelIds: r.parcels,
          geometry: null,
          applicationType: r.permitType,
          permitType: null,
          documentType: "monthly_permit_report",
          statusRaw: "Issued",
          // A monthly ISSUED-permits report: every row is an issued permit.
          normalizedStage: "permit_issued",
          applicationDate: null,
          issueDate: r.issueDate,
          sourceUpdatedAt: null,
          valuationUsd: r.valuation,
          units: null,
          lots: null,
          squareFeet: null,
          organizations,
          sourceUrl: raw.discovered.canonicalUrl,
          evidence: [
            {
              factPath: "title",
              text: `${r.permitNumber} ${r.permitType ?? ""}: ${r.comments ?? ""}`.trim(),
              pageOrSection: meta.title ?? "monthly permit report",
            },
            ...(r.issueDate
              ? [{ factPath: "issueDate", text: `Issued ${r.issueDate}`, pageOrSection: "DATE column" }]
              : []),
            ...(r.valuation !== null
              ? [{ factPath: "valuationUsd", text: `Value $${r.valuation}`, pageOrSection: "Value column" }]
              : []),
            ...(contractor
              ? [{ factPath: "organizations", text: `Contractor: ${contractor}`, pageOrSection: "CONTRACTOR column" }]
              : []),
          ],
        },
      };
    });
  }

  /** D1 — the report's own printed monthly total vs the sum of parsed values.
   * Catches silent column drift without trusting the positional parser. */
  async checkInvariants(
    raw: RawArtifact,
    parsed: ParsedSourceRecord[],
    ctx: RunContext,
  ): Promise<InvariantViolation[]> {
    const { printedTotal } = await this.extractRows(raw, ctx);
    const sum = parsed.reduce((s, p) => s + (p.record.valuationUsd ?? 0), 0);
    const v = reconcileSum("centralia_printed_valuation_total", printedTotal, sum, 0.01);
    return v ? [v] : [];
  }
}
