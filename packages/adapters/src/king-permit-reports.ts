import { extractLinks, loadHtml, readXlsx, type XlsxCell } from "@otn/documents";
import {
  checkDateWindow,
  checkNumericRange,
  httpFetchArtifact,
  httpGet,
  type DiscoveredArtifact,
  type InvariantViolation,
  type ParsedSourceRecord,
  type RawArtifact,
  type RunContext,
  type SourceAdapter,
} from "@otn/source-sdk";
import type { NormalizedSourceRecord } from "@otn/domain";

export const KING_REPORTS_URL =
  "https://kingcounty.gov/en/dept/local-services/certificates-permits-licenses/permits/permits-inspections-codes-buildings-land-use/permit-forms-application-materials/reports";

/** Months newer than checkpoint minus this overlap are (re)fetched — reports get revised. */
const OVERLAP_MONTHS = 1;
/** With no checkpoint, cover at least the 90-day backfill window. */
const DEFAULT_WINDOW_MONTHS = 4;

export type KingReportKind = "issued_permits" | "new_applications";

/** "…/kingcounty-issued-permits-2026-06.xlsx?rev=…" → {kind, month}. */
export function reportInfoFromUrl(
  url: string,
): { kind: KingReportKind; month: string; ext: string } | null {
  const name = url.split("/").pop()?.split("?")[0] ?? "";
  const m = /^king-?county-(issued-permits|new-applications)-(\d{4})-(\d{2})\.(xlsx?|docx?)$/i.exec(
    name,
  );
  if (!m) return null;
  return {
    kind: m[1]!.replace("-", "_") as KingReportKind,
    month: `${m[2]}-${m[3]}`,
    ext: m[4]!.toLowerCase(),
  };
}

function monthShift(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

/** Business / agency markers on a party name. A party without any of these is a
 * private individual (homeowner) — its mailing address is NOT promoted to a
 * matchable identifier (PII stays out of the bridge). The name is still emitted.
 * Deliberately excludes a bare "CO" (ambiguous token) and "TRUST" (family trusts
 * are a residence-ownership vehicle, not a contractor) so an individual is never
 * misgated to a business and given a promoted home address. */
const BUSINESS_RE =
  /\b(LLC|L\.L\.C|INC|CORP|COMPANY|LTD|LP|LLP|PLLC|ROOFING|CONSTRUCTION|CONTRACTING|ENGINEERING|ELECTRIC(AL)?|PLUMBING|MECHANICAL|BUILDERS?|DEVELOPMENT|HOMES?|SERVICES?|SYSTEMS?|GROUP|ASSOCIATES|ENTERPRISES?|PARTNERS?|PROPERTIES|MANAGEMENT|HOLDINGS?|INVESTMENTS?|CAPITAL|REALTY|CITY|COUNTY|STATE|DISTRICT|DEPT|DEPARTMENT|PORT|UNIVERSITY|COLLEGE|SCHOOL|AUTHORITY|AGENCY|CHURCH|FOUNDATION)\b/i;
function isBusinessName(name: string): boolean {
  return BUSINESS_RE.test(name);
}

/**
 * Split King's fused "name & address" cell into a clean party name and its
 * mailing address. Two layouts appear in the reports:
 *   owner:      "<name>, <street>\n<city>, ST ZIP"   (comma after the name)
 *   applicant:  "<name> <street>   <city> ST ZIP"    (no comma; address starts
 *                                                     at the first house number)
 * The clean name always replaces the fused blob (so name-matching isn't
 * degraded); the address is returned separately and only PROMOTED for a business
 * (the caller gates on isBusinessName). Returns address: null when none detected.
 */
export function splitNameAddress(cell: string): { name: string; address: string | null } {
  const flat = cell.replace(/\s*\n\s*/g, ", ").replace(/[ \t]+/g, " ").trim();
  // Owner layout: name is the text before the first comma, IF what follows looks
  // like a street (house number or PO box).
  const commaIdx = flat.indexOf(",");
  if (commaIdx > 0) {
    const after = flat.slice(commaIdx + 1).trim();
    if (/^(\d|P\.?\s*O\.?\b|PO\b)/i.test(after)) {
      return { name: flat.slice(0, commaIdx).trim(), address: after || null };
    }
  }
  // Applicant layout: address begins at the first house-number token (or a PO
  // box marker); everything before it is the name.
  const tokens = flat.split(" ");
  let start = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (/^\d/.test(t) || /^P\.?O\.?$/i.test(t)) {
      start = i;
      break;
    }
  }
  if (start > 0) {
    return { name: tokens.slice(0, start).join(" "), address: tokens.slice(start).join(" ") };
  }
  return { name: flat, address: null };
}

type HeaderMap = Map<string, number>;

function headerRow(rows: XlsxCell[][]): { index: number; map: HeaderMap } | null {
  for (let r = 1; r < Math.min(rows.length, 12); r++) {
    const cells = rows[r] ?? [];
    const map: HeaderMap = new Map();
    for (let c = 1; c < cells.length; c++) {
      const v = cells[c]?.value;
      if (typeof v === "string" && v.trim()) map.set(v.trim().toUpperCase(), c);
    }
    if (map.has("PERMIT NBR")) return { index: r, map };
  }
  return null;
}

/**
 * M1.6 — King County monthly permit reports (spec §6.4, P0). Monthly Excel
 * reports of issued permits and new applications for unincorporated King
 * County, parsed by header name so the two layouts (and column reorderings)
 * share one parser.
 */
export class KingPermitReportsAdapter implements SourceAdapter {
  readonly key = "king_permit_reports";
  readonly parserVersion = "1.0.0";

  private maxMonth = "";

  async discover(ctx: RunContext): Promise<DiscoveredArtifact[]> {
    const body = await httpGet(KING_REPORTS_URL, ctx);
    const $ = loadHtml(body);
    const links = extractLinks($, $("body"), KING_REPORTS_URL);

    const highWater = String(ctx.checkpoint?.["monthHighWater"] ?? "");
    const floorMonth = ctx.backfill
      ? ctx.backfill.from.slice(0, 7)
      : highWater
        ? monthShift(highWater, -OVERLAP_MONTHS)
        : monthShift(new Date().toISOString().slice(0, 7), -DEFAULT_WINDOW_MONTHS);
    const ceilMonth = ctx.backfill?.to.slice(0, 7) ?? "9999-12";

    const currentMonth = new Date().toISOString().slice(0, 7);
    const out: DiscoveredArtifact[] = [];
    const seen = new Set<string>();
    for (const l of links) {
      const info = reportInfoFromUrl(l.url);
      if (!info) continue;
      if (info.ext === "xls" || info.ext === "doc" || info.ext === "docx") {
        // Legacy formats predate the 90-day window; never guessed at.
        ctx.logger.info({ url: l.url, ext: info.ext }, "skipping legacy report format");
        continue;
      }
      if (info.month > currentMonth) {
        // The live index really contains a mistyped future-dated file
        // (king-county-new-applications-2028-08.xlsx) — a filing error must
        // not advance the checkpoint or be fetched as a report.
        ctx.logger.warn({ url: l.url, month: info.month }, "skipping future-dated report link");
        continue;
      }
      if (info.month > this.maxMonth) this.maxMonth = info.month;
      if (info.month < floorMonth || info.month > ceilMonth) continue;
      const id = `${info.kind}:${info.month}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        idempotencyKey: `${this.key}:${id}`,
        canonicalUrl: l.url,
        parentUrl: KING_REPORTS_URL,
        expectedContentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sourcePublishedAt: null,
        meta: { kind: info.kind, month: info.month },
      });
    }
    if (this.maxMonth && !ctx.backfill) {
      ctx.setCheckpoint({ monthHighWater: this.maxMonth });
    }
    return out;
  }

  async fetch(item: DiscoveredArtifact, ctx: RunContext): Promise<RawArtifact> {
    return httpFetchArtifact(item, ctx);
  }

  async parse(raw: RawArtifact, ctx: RunContext): Promise<ParsedSourceRecord[]> {
    const meta = raw.discovered.meta as { kind: KingReportKind; month: string };
    const sheets = await readXlsx(raw.body);
    const out: ParsedSourceRecord[] = [];

    for (const sheet of sheets) {
      const header = headerRow(sheet.rows);
      if (!header) continue;
      const col = (name: string) => header.map.get(name.toUpperCase());
      const get = (cells: XlsxCell[], name: string): XlsxCell | null => {
        const c = col(name);
        return c !== undefined ? (cells[c] ?? null) : null;
      };
      const text = (cells: XlsxCell[], name: string): string | null => {
        const v = get(cells, name)?.value;
        const s = v === null || v === undefined ? "" : String(v).trim();
        return s || null;
      };

      for (let r = header.index + 1; r < sheet.rows.length; r++) {
        const cells = sheet.rows[r];
        if (!cells) continue;
        const permitCell = get(cells, "PERMIT NBR");
        const permitNbr = permitCell?.value ? String(permitCell.value).trim() : null;
        if (!permitNbr || permitNbr.toUpperCase() === "PERMIT NBR") continue; // blank/repeat header

        const isIssued = meta.kind === "issued_permits";
        const jobValueRaw = get(cells, "JOB VALUE")?.value;
        const jobValue = typeof jobValueRaw === "number" ? jobValueRaw : Number(jobValueRaw ?? NaN);
        const unitsRaw = text(cells, isIssued ? "DWEL UNITS" : "DWELLING UNITS");
        const units = unitsRaw ? Number.parseInt(unitsRaw, 10) : NaN;
        const applicant = text(cells, "APPLICANT NAME & ADDRESS");
        const owner = text(cells, "OWNER NAME & ADDRESS");
        const status = text(cells, "RECORD STATUS");
        const issuedDate = isIssued ? text(cells, "ISSUED DATE") : null;
        const applDate = isIssued
          ? text(cells, "INTAKE COMPLETE DT")
          : text(cells, "APPL DT");
        const parcelCell = get(cells, "PARCEL");
        const parcel = parcelCell?.value ? String(parcelCell.value).trim() : null;
        const address = text(cells, "SITE ADDRESS/LOCATION") ?? text(cells, "PRIMARY ADDRESS");
        const projectName = text(cells, "PROJECT NAME");

        // WS3a: split the fused "name & address" cells → clean name always; the
        // mailing address promoted only for a business (homeowner → name only).
        const organizations: NormalizedSourceRecord["organizations"] = [];
        for (const [raw, role, label] of [
          [applicant, "applicant", "APPLICANT NAME & ADDRESS"],
          [owner, "owner", "OWNER NAME & ADDRESS"],
        ] as const) {
          if (!raw) continue;
          const { name, address } = splitNameAddress(raw);
          const promoted = address && isBusinessName(name) ? address : null;
          organizations.push({
            name,
            role,
            evidenceText: `${label}: ${raw}`,
            ...(promoted ? { address: promoted } : {}),
          });
        }

        out.push({
          rawFields: {
            reportKind: meta.kind,
            reportMonth: meta.month,
            permitNbr,
            permitType: text(cells, "PERMIT TYPE"),
            projectName,
            status,
            jobValue: Number.isFinite(jobValue) ? jobValue : null,
            parcel,
            parcelGisUrl: parcelCell?.hyperlink ?? null,
            accelaUrl: permitCell?.hyperlink ?? null,
            issuingAgency: text(cells, "ISSUING AGENCY"),
            address,
          },
          record: {
            sourceKey: this.key,
            externalId: permitNbr,
            recordType: isIssued ? "issued_permit" : "permit_application",
            title: `${permitNbr} – ${projectName ?? "permit"}`,
            description: text(cells, "DETAIL DESCRIPTION"),
            permittingJurisdiction: "Unincorporated King County",
            county: "King",
            city: null,
            addressRaw: address,
            parcelIds: parcel ? [parcel] : [],
            geometry: null,
            applicationType: null,
            permitType: text(cells, "PERMIT TYPE"),
            documentType: isIssued ? "issued_permits_report" : "new_applications_report",
            statusRaw: status,
            normalizedStage: isIssued ? "permit_issued" : "permit_applied",
            applicationDate: applDate,
            issueDate: issuedDate,
            sourceUpdatedAt: null,
            valuationUsd: Number.isFinite(jobValue) && jobValue > 0 ? jobValue : null,
            units: Number.isFinite(units) && units > 0 ? units : null,
            lots: null,
            squareFeet: null,
            organizations,
            sourceUrl: raw.discovered.canonicalUrl,
            evidence: [
              {
                factPath: "externalId",
                text: permitNbr,
                pageOrSection: `${meta.kind} report ${meta.month}`,
              },
              ...(status
                ? [
                    {
                      factPath: "statusRaw",
                      text: status,
                      pageOrSection: "RECORD STATUS column",
                    },
                  ]
                : []),
              ...(issuedDate
                ? [
                    {
                      factPath: "issueDate",
                      text: `ISSUED DATE: ${issuedDate}`,
                      pageOrSection: "ISSUED DATE column",
                    },
                  ]
                : []),
              ...(Number.isFinite(jobValue) && jobValue > 0
                ? [
                    {
                      factPath: "valuationUsd",
                      text: `JOB VALUE: ${jobValue}`,
                      pageOrSection: "JOB VALUE column",
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
        });
      }
    }

    if (out.length === 0) {
      throw new Error(
        `no permit rows parsed from ${raw.discovered.canonicalUrl} — report layout changed?`,
      );
    }
    ctx.logger.info({ month: meta.month, kind: meta.kind, rows: out.length }, "report parsed");
    return out;
  }

  /**
   * D1 — self-reconciliation for the Excel reports. A column insert/reorder in a
   * monthly workbook can silently land a job value in the units column (or a
   * date in the valuation column) without changing our field-name fingerprint or
   * the row count. Value-shape checks catch it: valuation and unit counts must be
   * plausible, and dates must fall in a sane window. Nulls are skipped.
   */
  checkInvariants(_raw: RawArtifact, parsed: ParsedSourceRecord[]): InvariantViolation[] {
    const out: InvariantViolation[] = [];
    const v = checkNumericRange(parsed, (p) => p.record.valuationUsd, {
      min: 0,
      max: 5_000_000_000,
      check: "king_valuation_range",
    });
    if (v) out.push(v);
    const u = checkNumericRange(parsed, (p) => p.record.units, {
      min: 0,
      max: 10_000,
      check: "king_units_range",
    });
    if (u) out.push(u);
    for (const [field, get] of [
      ["issue", (p: ParsedSourceRecord) => p.record.issueDate],
      ["application", (p: ParsedSourceRecord) => p.record.applicationDate],
    ] as const) {
      const d = checkDateWindow(parsed, get, {
        minIso: "2000-01-01",
        maxIso: "2100-01-01",
        check: `king_${field}_date_window`,
      });
      if (d) out.push(d);
    }
    return out;
  }
}
