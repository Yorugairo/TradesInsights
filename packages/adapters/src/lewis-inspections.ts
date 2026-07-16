import { extractLinks, extractPdfTextItems, loadHtml, type PdfTextItem } from "@otn/documents";
import {
  checkPattern,
  httpFetchArtifact,
  httpGet,
  type DiscoveredArtifact,
  type InvariantViolation,
  type ParsedSourceRecord,
  type RawArtifact,
  type RunContext,
  type SourceAdapter,
} from "@otn/source-sdk";

export const LEWIS_INSPECTIONS_URL =
  "https://lewiscountywa.gov/departments/community-development/building-inspections/daily-building-inspections/";

/** "07.15.2026_Scheduled_Inspections_-_Permitting.pdf" → "2026-07-15". */
export function inspectionDateFromFilename(url: string): string | null {
  const name = decodeURIComponent(url.split("/").pop() ?? "");
  const m = /^(\d{2})\.(\d{2})\.(\d{4})_Scheduled_Inspections/i.exec(name);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

const PERMIT_RE = /^[A-Z]{1,3}\d{2}-\d{4,5}$/;

export interface LewisInspectionRow {
  permitNumber: string;
  scheduledDate: string | null;
  inspectionType: string | null;
  reason: string | null;
  siteAddress: string | null;
  projectDescription: string | null;
}

function usDateToIso(s: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s.trim());
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

/** Parse one page of the daily scheduled-inspections table. */
export function parseLewisInspectionPage(items: PdfTextItem[]): LewisInspectionRow[] {
  const header = items.find((i) => i.text === "Permit Number");
  if (!header) return [];
  const label = (t: string) => items.find((i) => Math.abs(i.y - header.y) < 10 && i.text === t);
  const sched = label("Scheduled Date");
  const inspection = label("Inspection");
  const reason = label("Reason");
  const address = label("Site Address");
  const description = label("Project Description");
  if (!sched || !inspection || !reason || !address || !description) return [];

  // Column bounds are midpoints between adjacent header positions — the
  // county's generator jitters cell x positions between rows.
  const headers = [
    { name: "scheduledDate", x: sched.x },
    { name: "permitNumber", x: header.x },
    { name: "inspectionType", x: inspection.x },
    { name: "reason", x: reason.x },
    { name: "siteAddress", x: address.x },
    { name: "projectDescription", x: description.x },
  ].sort((a, b) => a.x - b.x);
  const bounds = headers.map((h, i) => ({
    name: h.name,
    from: i === 0 ? -Infinity : (headers[i - 1]!.x + h.x) / 2,
    to: i === headers.length - 1 ? Infinity : (h.x + headers[i + 1]!.x) / 2,
  }));
  const colOf = (x: number) => bounds.find((b) => x >= b.from && x < b.to)?.name ?? null;

  const body = items.filter((i) => i.y > header.y + 6);
  const anchors = body
    .filter((i) => PERMIT_RE.test(i.text.trim()) && colOf(i.x) === "permitNumber")
    .sort((a, b) => a.y - b.y);

  return anchors.map((anchor, ai) => {
    const from = ai === 0 ? anchor.y - 12 : (anchors[ai - 1]!.y + anchor.y) / 2;
    const to = ai === anchors.length - 1 ? Infinity : (anchor.y + anchors[ai + 1]!.y) / 2;
    const block = body.filter((i) => i.y >= from && i.y < to);
    const totalRe = /total inspection count|number of address locations/i;
    const cell = (name: string) =>
      block
        .filter((i) => colOf(i.x) === name && !totalRe.test(i.text))
        .sort((a, b) => a.y - b.y || a.x - b.x)
        .map((i) => i.text.trim())
        .filter(Boolean);
    const clean = (parts: string[]) => parts.join(" ").replace(/\s+/g, " ").trim() || null;

    // Time cells render truncated ("8:...") — ignored; the date is the fact.
    const dateCell = cell("scheduledDate").find((t) => /^\d{2}\/\d{2}\/\d{4}$/.test(t));

    return {
      permitNumber: anchor.text.trim(),
      scheduledDate: usDateToIso(dateCell ?? ""),
      inspectionType: clean(cell("inspectionType")),
      reason: clean(cell("reason")),
      siteAddress: clean(cell("siteAddress")),
      projectDescription: clean(cell("projectDescription")),
    };
  });
}

/**
 * M4.5 — Lewis County daily scheduled building inspections (spec §6.2 P1
 * `lewis_inspections`). A late-stage trade-timing signal: a FINAL INSPECTION
 * on a residence means finish trades (showers/mirrors) are imminent
 * (spec §12.1). Only the current day's PDF is published — no backfill archive
 * exists; freshness is strict (daily cadence, spec caveat).
 */
export class LewisInspectionsAdapter implements SourceAdapter {
  readonly key = "lewis_inspections";
  readonly parserVersion = "1.0.0";

  async discover(ctx: RunContext): Promise<DiscoveredArtifact[]> {
    const body = await httpGet(LEWIS_INSPECTIONS_URL, ctx);
    const $ = loadHtml(body);
    const links = extractLinks($, $("body"), LEWIS_INSPECTIONS_URL).filter(
      (l) => inspectionDateFromFilename(l.url) !== null,
    );

    const highWater = String(ctx.checkpoint?.["inspectionDateHighWater"] ?? "");
    const out: DiscoveredArtifact[] = [];
    const seen = new Set<string>();
    let maxDate = highWater;
    for (const l of links) {
      const date = inspectionDateFromFilename(l.url)!;
      if (date > maxDate) maxDate = date;
      // Re-fetching the same day is fine (hash dedupe); never refetch older
      // days — the county replaces the file daily and history is not archived.
      if (highWater && date < highWater) continue;
      if (seen.has(date)) continue;
      seen.add(date);
      out.push({
        idempotencyKey: `${this.key}:${date}`,
        canonicalUrl: l.url,
        parentUrl: LEWIS_INSPECTIONS_URL,
        expectedContentType: "application/pdf",
        sourcePublishedAt: date,
        meta: { inspectionDate: date },
      });
    }
    if (maxDate && !ctx.backfill) ctx.setCheckpoint({ inspectionDateHighWater: maxDate });
    return out;
  }

  async fetch(item: DiscoveredArtifact, ctx: RunContext): Promise<RawArtifact> {
    return httpFetchArtifact(item, ctx);
  }

  async parse(raw: RawArtifact, _ctx: RunContext): Promise<ParsedSourceRecord[]> {
    const pages = await extractPdfTextItems(raw.body);
    const rows = pages.flatMap((p) => parseLewisInspectionPage(p.items));
    if (rows.length === 0) {
      throw new Error(
        `no inspection rows parsed from ${raw.discovered.canonicalUrl} — layout changed?`,
      );
    }
    const inspectionDate =
      (raw.discovered.meta as { inspectionDate?: string } | undefined)?.inspectionDate ?? null;

    return rows.map((row) => {
      const isFinal = /FINAL/i.test(row.inspectionType ?? "");
      return {
        rawFields: { ...row, inspectionDate, permitNumbers: [row.permitNumber] },
        record: {
          sourceKey: this.key,
          externalId: `${row.permitNumber}:${row.scheduledDate ?? inspectionDate}:${row.inspectionType ?? "inspection"}`,
          recordType: "inspection",
          title: `${row.permitNumber} – ${row.inspectionType ?? "inspection"}${row.siteAddress ? ` at ${row.siteAddress}` : ""}`,
          description: row.projectDescription,
          permittingJurisdiction: "Lewis County",
          county: "Lewis",
          city: null,
          addressRaw: row.siteAddress,
          parcelIds: [],
          geometry: null,
          applicationType: null,
          permitType: null,
          documentType: "scheduled_inspections",
          statusRaw: row.reason,
          // A final inspection puts the project near completion; any other
          // inspection confirms active construction.
          normalizedStage: isFinal ? "near_final" : "construction",
          applicationDate: null,
          issueDate: null,
          sourceUpdatedAt: row.scheduledDate,
          valuationUsd: null,
          units: null,
          lots: null,
          squareFeet: null,
          organizations: [],
          sourceUrl: raw.discovered.canonicalUrl,
          evidence: [
            {
              factPath: "externalId",
              text: `${row.permitNumber} ${row.inspectionType ?? ""} ${row.reason ?? ""}`.trim(),
              pageOrSection: "Scheduled inspections table",
            },
            ...(row.scheduledDate
              ? [{ factPath: "sourceUpdatedAt", text: `Scheduled Date: ${row.scheduledDate}`, pageOrSection: "Scheduled Date column" }]
              : []),
            ...(row.projectDescription
              ? [{ factPath: "description", text: row.projectDescription, pageOrSection: "Project Description column" }]
              : []),
          ],
        },
      };
    });
  }

  /**
   * D1 — column-shape invariants. The inspections table has no reconcilable
   * printed total, so guard the geometry directly: the permit-number column
   * must keep its format, and a permit number or a date must never appear in
   * the inspection-type or reason column (that is the signature of a horizontal
   * column drift silently mis-assigning cells). Descriptive type/reason values
   * ("FINAL INSPECTION", "footing") never match these patterns, so a clean
   * parse produces no violations.
   */
  checkInvariants(_raw: RawArtifact, parsed: ParsedSourceRecord[]): InvariantViolation[] {
    const out: InvariantViolation[] = [];
    const idViolation = checkPattern(
      parsed,
      (p) => ((p.rawFields as { permitNumber?: string }).permitNumber ?? null),
      { re: PERMIT_RE, check: "lewis_permit_id_format" },
    );
    if (idViolation) out.push(idViolation);

    const DATE_RE = /\b\d{2}\/\d{2}\/\d{4}\b/;
    for (const p of parsed) {
      const rf = p.rawFields as { inspectionType?: string | null; reason?: string | null };
      for (const [field, val] of [
        ["inspectionType", rf.inspectionType],
        ["reason", rf.reason],
      ] as const) {
        if (val && (PERMIT_RE.test(val.trim()) || DATE_RE.test(val))) {
          out.push({
            check: "lewis_column_shift",
            detail: `${p.record.externalId}: ${field}="${val}" looks like a permit/date — column drift`,
            observed: val,
            expected: `descriptive ${field}`,
          });
          break;
        }
      }
    }
    return out;
  }
}
