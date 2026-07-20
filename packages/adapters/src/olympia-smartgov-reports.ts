import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { extractPdfTextItems, type PdfTextItem } from "@otn/documents";
import {
  reconcileCount,
  type DiscoveredArtifact,
  type InvariantViolation,
  type ParsedSourceRecord,
  type RawArtifact,
  type RunContext,
  type SourceAdapter,
} from "@otn/source-sdk";
import type { NormalizedSourceRecord } from "@otn/domain";

const PORTAL = "https://ci-olympia-wa.smartgovcommunity.com/Public/ReportsView";
/** GUID of the "Permits Issued Last 30 Days" report (fixtures/olympia_smartgov_reports/reports-catalog.json). */
const ISSUED_REPORT_GUID = "c7e5b4a5-9452-4861-a415-491cda5b44dc";

/**
 * City of Olympia — SmartGov "Permits Issued Last 30 Days" (spec §6, P1: Olympia
 * was the top uncovered permit-stage gap in the home metro). The report opens
 * through a session-stateful Exago viewer that renders a **PDF only** (every
 * non-PDF `eit` returns HTTP 500; docs/source-policy.md) via a single-use,
 * session-bound `eid`. So — like PALS — this source is genuine-visitor
 * capture-fed: `fetch()` is contract-complete but dead-letters against the live
 * gate, and the PARSER runs over captured PDF artifacts.
 *
 * Layout (fixtures/olympia_smartgov_reports/permits-issued-last-30-days.pdf):
 * permits are grouped under permit-CATEGORY section headers; each category is a
 * table with x-anchored columns (Permit Number / Date Issued / Site Address /
 * Project Name / Project Description / Applicant) whose rows wrap across
 * multiple lines, and ends with a printed `Total <Category> Permits: N`. The
 * report closes with a `Grand Total: N`. The report carries NO phone / licence /
 * valuation / parcel — the applicant name is the only contact identity, so
 * organizations[] is name-only (org-vs-person flagged in rawFields).
 */

/** Column identities in left-to-right order, with the x-anchors observed in the
 * DATA rows as a FALLBACK only. The live anchors are derived per-report from the
 * header row (deriveColumns) so a margin/template shift moves the columns and the
 * parser follows — the WS5 durability lesson: never anchor on absolute page
 * coordinates. These defaults apply only when the header can't be located. */
const DEFAULT_COLUMNS = [
  { name: "permitNumber", x: 38 },
  { name: "dateIssued", x: 106 },
  { name: "siteAddress", x: 157 },
  { name: "projectName", x: 249 },
  { name: "projectDescription", x: 340 },
  { name: "applicant", x: 456 },
] as const;
type ColName = (typeof DEFAULT_COLUMNS)[number]["name"];
interface Column {
  name: ColName;
  x: number;
}

/** Header label → column identity, in document order. */
const HEADER_LABELS: { label: string; name: ColName }[] = [
  { label: "Permit Number", name: "permitNumber" },
  { label: "Date Issued", name: "dateIssued" },
  { label: "Site Address", name: "siteAddress" },
  { label: "Project Name", name: "projectName" },
  { label: "Project Description", name: "projectDescription" },
  { label: "Applicant", name: "applicant" },
];

/**
 * Olympia publishes two rolling 30-day permit reports that share this EXACT PDF
 * layout (same six columns, same category-total + Grand-Total structure),
 * differing only in the date column's meaning and the "Permits" vs "Applications"
 * wording. The APPLICATIONS report is the higher-lead-time signal: at submission
 * the GC has usually not yet bought out its finish subs, so a trade sub (Solis)
 * can still get in — by issuance that window is mostly closed. Both are parsed by
 * the shared logic below; only the date field + stage + status differ.
 */
interface ReportSpec {
  report: string;
  file: string; // capture / fixture filename
  idempotencyKey: string;
  canonicalUrl: string;
  meta: Record<string, unknown>;
  dateField: "issueDate" | "applicationDate";
  stage: "permit_issued" | "permit_applied";
  statusRaw: string;
  documentType: string;
  dateLabel: string; // evidence label for the date column
}

const REPORTS: Record<string, ReportSpec> = {
  permits_issued_last_30_days: {
    report: "permits_issued_last_30_days",
    file: "permits-issued-last-30-days.pdf",
    idempotencyKey: "olympia_smartgov_reports:permits_issued_last_30_days",
    canonicalUrl: `${PORTAL}#report=${ISSUED_REPORT_GUID}`,
    meta: { report: "permits_issued_last_30_days", exagoGuid: ISSUED_REPORT_GUID },
    dateField: "issueDate",
    stage: "permit_issued",
    statusRaw: "issued",
    documentType: "permits_issued_report",
    dateLabel: "Date Issued",
  },
  permit_applications_last_30_days: {
    report: "permit_applications_last_30_days",
    file: "permit-applications-last-30-days.pdf",
    idempotencyKey: "olympia_smartgov_reports:permit_applications_last_30_days",
    canonicalUrl: `${PORTAL}#report=permit_applications_last_30_days`,
    meta: { report: "permit_applications_last_30_days" },
    dateField: "applicationDate",
    stage: "permit_applied",
    statusRaw: "submitted",
    documentType: "permit_applications_report",
    dateLabel: "Submitted Date",
  },
};

/** Resolve the report spec for an artifact (meta.report, else the idempotency-key
 * suffix), defaulting to the issued-permits report for legacy/test artifacts. */
function resolveReport(d: DiscoveredArtifact): ReportSpec {
  const key =
    (d as { meta?: { report?: string } }).meta?.report ?? d.idempotencyKey.split(":")[1] ?? "";
  return REPORTS[key] ?? REPORTS["permits_issued_last_30_days"]!;
}

/** Derive the column x-anchors from the report's own header row, so a reformat
 * that shifts the margins moves the columns with it. Falls back to the observed
 * defaults if the full header can't be located; the printed-total reconciliation
 * in checkInvariants is the final backstop against a mis-derived layout. */
export function deriveColumns(pages: { items: PdfTextItem[] }[]): Column[] {
  for (const pg of pages) {
    const hdr = pg.items.find((i) => i.text === "Permit Number");
    if (!hdr) continue;
    const rowItems = pg.items.filter((i) => Math.abs(i.y - hdr.y) <= 4);
    const found: Column[] = [];
    for (const { label, name } of HEADER_LABELS) {
      const it = rowItems.find((i) => i.text === label);
      if (it) found.push({ name, x: it.x });
    }
    if (found.length === HEADER_LABELS.length) return found.sort((a, b) => a.x - b.x);
  }
  return DEFAULT_COLUMNS.map((c) => ({ name: c.name, x: c.x }));
}

function nearestCol(x: number, columns: Column[]): ColName {
  let best = columns[0]!;
  let bestD = Math.abs(x - best.x);
  for (const c of columns) {
    const d = Math.abs(x - c.x);
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best.name;
}

const isDate = (s: string): boolean => /^\d{2}\/\d{2}\/\d{4}$/.test(s.trim());
function isoDate(s: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s.trim());
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

/** Repeating page furniture (header band + footer) — skipped by content so the
 * logical record stream flows across page breaks. */
function isFurniture(text: string): boolean {
  return (
    /^City of Olympia - Permit/i.test(text) || // "Permits Issued" and "Permit Applications"
    /^Permits? (Issued|Applications)\b/.test(text) ||
    /^Report Run /.test(text) ||
    /^Pg\. /.test(text) ||
    // The applications report's date-column header wraps as two lone items
    // ("Submitted" / "Date") off the Permit-Number header row — skip both so they
    // never leak into an open record.
    text === "Submitted" ||
    text === "Date" ||
    text === "Submitted Date"
  );
}

/** Business markers vs a "Last, First" person name — a signal for downstream
 * matching/PII handling (this report mixes companies and homeowners). Never
 * changes what we emit; just recorded in rawFields. */
const BUSINESS_RE =
  /\b(LLC|L\.L\.C|INC|CORP|CO|COMPANY|LTD|LP|LLP|PLLC|ROOFING|CONSTRUCTION|CONTRACTING|ENGINEERING|ELECTRIC(AL)?|PLUMBING|MECHANICAL|BUILDERS?|DEVELOPMENT|HOMES?|SERVICES?|SYSTEMS?|GROUP|ASSOCIATES|ENTERPRISES?|DEPT|DEPARTMENT|CITY|COUNTY|STATE|DISTRICT|CHURCH|ASSOCIATION|PROPERTIES|MANAGEMENT|SOLAR|HVAC|GLASS|WINDOWS?|CLUB|SCHOOL)\b/i;
function isLikelyBusiness(name: string): boolean {
  if (BUSINESS_RE.test(name)) return true;
  // "SURNAME, GIVEN" with few tokens → an individual (homeowner), not a business.
  if (/^[A-Za-z.'-]+,\s*[A-Za-z]/.test(name) && name.split(/\s+/).length <= 4) return false;
  return false;
}

interface OpenRecord {
  category: string;
  cells: Map<ColName, string[]>;
}

const joinCell = (parts: string[] | undefined): string | null => {
  const t = (parts ?? []).join(" ").replace(/\s+/g, " ").trim();
  return t.length ? t : null;
};

export class OlympiaSmartgovReportsAdapter implements SourceAdapter {
  readonly key = "olympia_smartgov_reports";
  readonly parserVersion = "1.1.0";

  /** Report-class discovery: BOTH rolling 30-day reports. The APPLICATIONS report
   * is the higher-lead-time signal (submission precedes issuance, before the GC
   * buys out its finish subs) and the ISSUED report is the confirmed-work signal.
   * Both parse total-exact — each category's parsed count equals its printed
   * "Total … Applications|Permits: N" and the whole report equals its Grand Total
   * (see checkInvariants + the parse tests: 815 applications, 572 issued). They
   * share one capture-fed source key, so a red on either would suppress the other;
   * both are only discovered because both reconcile. */
  async discover(_ctx: RunContext): Promise<DiscoveredArtifact[]> {
    return Object.values(REPORTS).map((spec) => ({
      idempotencyKey: spec.idempotencyKey,
      canonicalUrl: spec.canonicalUrl,
      parentUrl: PORTAL,
      expectedContentType: "application/pdf",
      sourcePublishedAt: null,
      meta: spec.meta,
    }));
  }

  async fetch(item: DiscoveredArtifact, _ctx: RunContext): Promise<RawArtifact> {
    const spec = resolveReport(item);
    // Capture-fed: an operator-local run points OTN_CAPTURE_DIR at a directory of
    // genuine-browser captures. Read <OTN_CAPTURE_DIR>/olympia_smartgov_reports/
    // <report>.pdf when present. The golden fixtures dir is NOT consulted here, so
    // tests still dead-letter.
    const captureDir = process.env.OTN_CAPTURE_DIR;
    if (captureDir) {
      try {
        const body = await readFile(join(captureDir, this.key, spec.file));
        if (body.byteLength > 0) {
          return {
            discovered: item,
            body,
            contentType: "application/pdf",
            httpStatus: 200,
            headers: { "content-type": "application/pdf" },
            retrievedAt: new Date(),
          };
        }
      } catch {
        // Capture dir set but file missing/unreadable — fall through to the dead-letter.
      }
    }
    // PDF-only + single-use session-bound `eid`: auto-fetch cannot mint the
    // session token and must not drive a headless bot. Reproduce the gate as a
    // dead-letter rather than passing an error page to the parser as data.
    throw new Error(
      `olympia_smartgov_reports: ${item.canonicalUrl} renders only through a session-bound ` +
        "Exago `eid` (non-PDF export 500s). Genuine-visitor capture-fed; stage a captured report " +
        `PDF at $OTN_CAPTURE_DIR/olympia_smartgov_reports/${spec.file} (operator-local run) — ` +
        "auto-fetch dead-letters here by design.",
    );
  }

  async parse(raw: RawArtifact, ctx: RunContext): Promise<ParsedSourceRecord[]> {
    if (!raw.body || raw.body.byteLength === 0) {
      throw new Error("olympia_smartgov_reports: empty artifact body — not a captured report PDF");
    }
    const pages = await extractPdfTextItems(raw.body);
    // Durable geometry: column x-anchors from the header, not baked-in coordinates.
    const columns = deriveColumns(pages);
    // Which report (issued vs applications) — drives the date field + stage.
    const spec = resolveReport(raw.discovered);

    const out: ParsedSourceRecord[] = [];
    let categoryRecords: ParsedSourceRecord[] = []; // emitted for the current category, awaiting its printed total
    let currentCategory: string | null = null;
    let open: OpenRecord | null = null;
    let awaitingTotalCount = false; // inside a wrapped "Total …" block, count not yet seen
    let grandTotalPrinted: number | null = null;
    const categoryTotals: { category: string; printed: number; parsed: number }[] = [];

    const finalizeOpen = (): void => {
      if (!open) return;
      const rec = this.buildRecord(open, raw, spec);
      if (rec) {
        out.push(rec);
        categoryRecords.push(rec);
      }
      open = null;
    };

    for (const page of pages) {
      for (const line of groupLines(page.items)) {
        const first = line[0];
        if (!first) continue;
        const joined = line.map((i) => i.text).join(" ").trim();
        if (isFurniture(joined)) continue;
        if (first.text === "Permit Number") continue; // column-header row

        // The printed count is the number after "Permits:"/"Applications:" in the
        // line TEXT. The issued report leaves it as a separate integer item
        // ("… Permits:  5") while the applications report glues it into the label
        // item ("… Applications: 1"); reading it from the joined text handles both
        // and never reaches forward to grab a permit number off the next category.
        const joinedText = line.map((i) => i.text).join(" ");
        const textCount = /(?:Permits|Applications)\s*:\s*(\d+)\b/i.exec(joinedText);
        const bareInt = [...line].reverse().find((i) => /^\d+$/.test(i.text.trim()));

        // Grand total closes the report.
        if (/Grand Total/i.test(joinedText)) {
          finalizeOpen();
          const g = /Grand Total\s*:?\s*(\d+)/i.exec(joinedText);
          if (g) grandTotalPrinted = Number(g[1]);
          else if (bareInt) grandTotalPrinted = Number(bareInt.text);
          awaitingTotalCount = false;
          continue;
        }

        // Category total line ("Total <Category> Permits|Applications: N"); the
        // count is the number after the noun (glued or separate), else the
        // rightmost bare integer (issued's separate-item form). It may also wrap
        // onto a following line while the label continues.
        //
        // Gate on the permit-number column: a real total label starts at the left
        // margin (x≈42–51 → permitNumber), whereas a project-description line that
        // merely begins with the word "TOTAL" (e.g. "TOTAL DUCT REPLACEMENT") sits
        // in the description column (x≈340). Without this gate that fragment is
        // mistaken for a category total, opening a spurious `awaitingTotalCount`
        // that swallows every following record until the next lone integer — which
        // then reads as a bogus 4-digit "count" off a wrapped permit/valuation.
        if (/^Total\b/i.test(first.text) && nearestCol(first.x, columns) === "permitNumber") {
          finalizeOpen();
          const c = textCount ? Number(textCount[1]) : bareInt ? Number(bareInt.text) : null;
          if (c !== null) {
            this.closeCategoryTotal(currentCategory, c, categoryRecords, categoryTotals);
            categoryRecords = [];
            awaitingTotalCount = false;
          } else {
            awaitingTotalCount = true; // "… : N" is on a later line
          }
          continue;
        }
        // Wrapped total continuation: close on the count. In a wrapped total block
        // the printed count is the lone pure-integer ITEM in the count column
        // (x≈249) — it may share its visual line with a trailing label fragment
        // (e.g. "…Critical Area Confirmation, or Other" + "1"), so a strict
        // length===1 gate would miss it and let `awaitingTotalCount` devour the
        // next category header and its records. Embedded label numbers ("400",
        // "(1-4)", "(5+)") stay inside their label string, never separate integer
        // items, so `bareInt` cannot mistake them for the count. And because the
        // Total-label gate now blocks description "TOTAL …" false positives,
        // `awaitingTotalCount` only ever opens on a real total block whose count
        // follows immediately — it can no longer bleed into a data row's integer.
        if (awaitingTotalCount) {
          const c = textCount ? Number(textCount[1]) : bareInt ? Number(bareInt.text) : null;
          if (c !== null) {
            this.closeCategoryTotal(currentCategory, c, categoryRecords, categoryTotals);
            categoryRecords = [];
            awaitingTotalCount = false;
          }
          continue; // otherwise still accumulating the wrapped label
        }

        // Record start: a permit number in its column AND a date in the date column
        // (columns derived from the header, so a margin shift moves them together).
        const dateItem = line.find((i) => nearestCol(i.x, columns) === "dateIssued" && isDate(i.text));
        const permitItem = line.find(
          (i) => nearestCol(i.x, columns) === "permitNumber" && i.text.trim().length > 0,
        );
        if (dateItem && permitItem) {
          finalizeOpen();
          open = { category: currentCategory ?? "Unknown", cells: new Map() };
          this.assign(open, line, columns);
          continue;
        }

        // Category section header: a lone item in the leftmost (permit) column
        // that reads as TEXT. A permit number whose long prefix wraps (e.g.
        // "REFERENCE-26-" then a lone "0399", or "…-26-" then "4304") drops its
        // numeric suffix onto its own line in the same column; requiring a letter
        // keeps that suffix a continuation of the open record instead of a bogus
        // numeric "category" that splits records and steals the next printed total.
        if (
          line.length === 1 &&
          nearestCol(first.x, columns) === "permitNumber" &&
          /[A-Za-z]/.test(first.text)
        ) {
          finalizeOpen();
          categoryRecords = []; // safety: prior category should have closed on its Total
          currentCategory = first.text.trim();
          continue;
        }

        // Otherwise a wrapped continuation of the open record.
        if (open) this.assign(open, line, columns);
      }
    }
    finalizeOpen();

    // Back-fill the grand total onto every record for the reconciliation check.
    for (const r of out) (r.rawFields as Record<string, unknown>)["grandTotalPrinted"] = grandTotalPrinted;

    if (out.length === 0) {
      throw new Error(
        `olympia_smartgov_reports: no permit rows parsed from ${raw.discovered.canonicalUrl} — report layout changed?`,
      );
    }
    ctx.logger.info(
      { records: out.length, categories: categoryTotals.length, grandTotalPrinted },
      "olympia_smartgov_reports parsed",
    );
    return out;
  }

  /** Record the printed category total and back-fill it onto the category's records. */
  private closeCategoryTotal(
    category: string | null,
    printed: number,
    records: ParsedSourceRecord[],
    totals: { category: string; printed: number; parsed: number }[],
  ): void {
    totals.push({ category: category ?? "Unknown", printed, parsed: records.length });
    for (const r of records) (r.rawFields as Record<string, unknown>)["categoryPrintedTotal"] = printed;
  }

  private assign(open: OpenRecord, line: PdfTextItem[], columns: Column[]): void {
    for (const it of line) {
      const col = nearestCol(it.x, columns);
      const arr = open.cells.get(col) ?? [];
      arr.push(it.text);
      open.cells.set(col, arr);
    }
  }

  private buildRecord(open: OpenRecord, raw: RawArtifact, spec: ReportSpec): ParsedSourceRecord | null {
    void raw;
    const permitNumber = joinCell(open.cells.get("permitNumber"));
    if (!permitNumber) return null;
    const dateStr = joinCell(open.cells.get("dateIssued")); // the date column (issued OR submitted)
    const siteAddress = joinCell(open.cells.get("siteAddress"));
    const projectName = joinCell(open.cells.get("projectName"));
    const projectDesc = joinCell(open.cells.get("projectDescription"));
    const applicant = joinCell(open.cells.get("applicant"));
    const iso = dateStr ? isoDate(dateStr) : null;

    const organizations: NormalizedSourceRecord["organizations"] = [];
    if (applicant) {
      organizations.push({
        name: applicant,
        role: "applicant",
        evidenceText: `Applicant on Olympia permit ${permitNumber}: ${applicant}`,
      });
    }

    const evidence: NormalizedSourceRecord["evidence"] = [
      { factPath: "externalId", text: permitNumber, pageOrSection: `${open.category} table` },
    ];
    if (dateStr)
      evidence.push({ factPath: spec.dateField, text: `${spec.dateLabel}: ${dateStr}`, pageOrSection: `${spec.dateLabel} column` });
    if (applicant)
      evidence.push({ factPath: "organizations", text: `Applicant: ${applicant}`, pageOrSection: "Applicant column" });
    if (siteAddress)
      evidence.push({ factPath: "addressRaw", text: `Site Address: ${siteAddress}`, pageOrSection: "Site Address column" });

    const record: NormalizedSourceRecord = {
      sourceKey: this.key,
      externalId: permitNumber,
      recordType: "building_permit",
      title: `${permitNumber} – ${projectName ?? open.category}`,
      description: projectDesc,
      permittingJurisdiction: "City of Olympia",
      county: "Thurston",
      city: null,
      addressRaw: siteAddress,
      parcelIds: [],
      geometry: null,
      applicationType: null,
      permitType: open.category,
      documentType: spec.documentType,
      statusRaw: spec.statusRaw,
      normalizedStage: spec.stage,
      applicationDate: spec.dateField === "applicationDate" ? iso : null,
      issueDate: spec.dateField === "issueDate" ? iso : null,
      sourceUpdatedAt: null,
      valuationUsd: null,
      units: null,
      lots: null,
      squareFeet: null,
      organizations,
      sourceUrl: PORTAL,
      evidence,
    };

    return {
      record,
      rawFields: {
        permitNumber,
        report: spec.report,
        category: open.category,
        date: dateStr,
        siteAddress,
        projectName,
        projectDescription: projectDesc,
        applicant,
        applicantIsBusiness: applicant ? isLikelyBusiness(applicant) : null,
        // Reconciliation anchors (back-filled by closeCategoryTotal / parse).
        categoryPrintedTotal: null,
        grandTotalPrinted: null,
      },
    };
  }

  /**
   * Reconcile parsed rows against the report's own printed totals: each
   * category's parsed count must equal its `Total <Category> Permits: N`, and
   * the whole report must equal `Grand Total: N`.
   */
  checkInvariants(_raw: RawArtifact, parsed: ParsedSourceRecord[]): InvariantViolation[] {
    const violations: InvariantViolation[] = [];
    const byCategory = new Map<string, { parsed: number; printed: number | null }>();
    let grand: number | null = null;

    for (const p of parsed) {
      const rf = p.rawFields as Record<string, unknown>;
      const cat = String(rf["category"] ?? "Unknown");
      const printed = typeof rf["categoryPrintedTotal"] === "number" ? (rf["categoryPrintedTotal"] as number) : null;
      const g = rf["grandTotalPrinted"];
      if (typeof g === "number") grand = g;
      const entry = byCategory.get(cat) ?? { parsed: 0, printed };
      entry.parsed += 1;
      if (printed !== null) entry.printed = printed;
      byCategory.set(cat, entry);
    }

    for (const [cat, { parsed: got, printed }] of byCategory) {
      if (printed === null) continue; // no total line captured for this category
      const v = reconcileCount(`olympia_category_total:${cat}`, printed, got);
      if (v) violations.push(v);
    }
    if (grand !== null) {
      const v = reconcileCount("olympia_grand_total", grand, parsed.length);
      if (v) violations.push(v);
    }
    return violations;
  }
}

/** Group a page's positioned items into visual lines by y proximity, each sorted
 * left-to-right. (Local copy so the adapter doesn't depend on the documents
 * package re-exporting its line grouper.) */
function groupLines(items: PdfTextItem[], tolerance = 4): PdfTextItem[][] {
  const sorted = [...items]
    .filter((i) => i.text.trim().length > 0)
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: { y: number; items: PdfTextItem[] }[] = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(it.y - last.y) <= tolerance) last.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);
  return lines.map((l) => l.items);
}
