import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
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

export const TUMWATER_NOA_SEPA_URL =
  "https://www.ci.tumwater.wa.us/departments/community-development-department/permitting-building/notice-of-applications-sepa-determinations";

/**
 * City of Tumwater — "Notice of Applications & SEPA Determinations" planning
 * board (spec §6; Thurston home-metro land-use notices, high value for the
 * Lacey/Tumwater trades). The page is a single rolling HTML table: one row per
 * land-use project carrying its embedded case number (`TUM-YY-NNNN`) and, in
 * three columns, the dated links to its Notice of Application, SEPA
 * Determination, and Notice of Decision documents (local Laserfiche PDFs or
 * external Ecology SEPA records).
 *
 * Capture-fed, like PALS/Olympia: `ci.tumwater.wa.us` sits behind an Akamai
 * edge policy that fingerprints the client — a genuine in-region browser gets
 * normal content, but curl/automated/datacenter clients get a 403 challenge we
 * will not defeat (docs/source-policy.md). So `fetch()` is contract-complete
 * but dead-letters against the live gate, and the PARSER runs over the captured
 * index (fixtures/tumwater_sepa/noa-sepa.index.json), which stores the table's
 * rows verbatim.
 *
 * The index carries NO party data — the applicant/owner names live inside the
 * linked PDFs, which we do not fetch. That is deliberate: NOA/decision docs for
 * plats and conditional-use permits routinely name individual property owners,
 * and this surface must not carry homeowner PII into the registry bridge. So
 * organizations[] is empty and the dated notices flow to the event layer, which
 * derives lifecycle from the notice events — the adapter never infers a decision
 * outcome (approved vs denied) it cannot see, so normalizedStage stays
 * `unknown` (mirrors thurston_active_notices / king_public_notices).
 */

/** One notice link within a project row, as captured verbatim. */
const NoticeEntrySchema = z.object({
  date: z.string().min(1),
  url: z.string().url(),
});

/** A single project row of the NOA/SEPA table. */
const RowSchema = z.object({
  project: z.string().min(1),
  notice_of_application: z.array(NoticeEntrySchema).optional(),
  sepa_determination: z.array(NoticeEntrySchema).optional(),
  notice_of_decision: z.array(NoticeEntrySchema).optional(),
});

/** The captured index shape (fixtures/tumwater_sepa/noa-sepa.index.json). */
const IndexSchema = z.object({
  source_url: z.string().url().optional(),
  rows: z.array(RowSchema).min(1),
});

/** Notice columns in lifecycle order; `rank` picks the most-advanced present. */
const KINDS = [
  { field: "notice_of_application", label: "Notice of Application", rank: 1 },
  { field: "sepa_determination", label: "SEPA Determination", rank: 2 },
  { field: "notice_of_decision", label: "Notice of Decision", rank: 3 },
] as const;

const CASE_RE = /TUM-\d{2}-\d{4}/i;

/** "MM/DD/YYYY" → "YYYY-MM-DD"; null on anything else (never guessed). */
function isoDate(raw: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
  if (!m) return null;
  return `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
}

/** Stable id for rows without a `TUM-YY-NNNN` case number (ordinances, comp-plan
 * amendments, un-numbered notices). Mirrors king_public_notices' slug fallback. */
function slugId(project: string): string {
  const slug = project
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `notice-${slug}`;
}

/** A URL that leaves the Tumwater site (Ecology SEPA register / secure access)
 * carries the `____isexternal=true` splash marker; local docs are Laserfiche. */
function isExternal(url: string): boolean {
  return /____isexternal=true/i.test(url) || !/\/home\/showpublisheddocument\//i.test(url);
}

interface FlatNotice {
  kind: string;
  label: string;
  rank: number;
  date: string;
  isoDate: string | null;
  url: string;
  external: boolean;
}

export class TumwaterSepaAdapter implements SourceAdapter {
  readonly key = "tumwater_sepa";
  readonly parserVersion = "1.0.0";

  async discover(_ctx: RunContext): Promise<DiscoveredArtifact[]> {
    return [
      {
        idempotencyKey: `${this.key}:noa_sepa_index`,
        canonicalUrl: TUMWATER_NOA_SEPA_URL,
        parentUrl: null,
        expectedContentType: "application/json",
        sourcePublishedAt: null,
      },
    ];
  }

  async fetch(item: DiscoveredArtifact, _ctx: RunContext): Promise<RawArtifact> {
    // Capture-fed: an operator-local run points OTN_CAPTURE_DIR at a directory of
    // genuine-browser captures (never the datacenter, where Akamai 403s automated
    // clients). Read <OTN_CAPTURE_DIR>/tumwater_sepa/noa-sepa.index.json when present.
    // The golden fixtures dir is NOT consulted here, so tests still dead-letter.
    const captureDir = process.env.OTN_CAPTURE_DIR;
    if (captureDir) {
      try {
        const body = await readFile(join(captureDir, this.key, "noa-sepa.index.json"));
        if (body.byteLength > 0) {
          return {
            discovered: item,
            body,
            contentType: "application/json",
            httpStatus: 200,
            headers: { "content-type": "application/json" },
            retrievedAt: new Date(),
          };
        }
      } catch {
        // Capture dir set but file missing/unreadable — fall through to the dead-letter.
      }
    }
    // Akamai fingerprints the client: a genuine in-region browser sees the page,
    // but automated/datacenter clients get a 403 challenge we will not defeat.
    throw new Error(
      `tumwater_sepa: ${item.canonicalUrl} is served behind an Akamai edge ` +
        "policy that 403s automated/datacenter clients (a genuine in-region browser is " +
        "required; no bot bypass). Capture-fed: stage a genuine-browser capture at " +
        "$OTN_CAPTURE_DIR/tumwater_sepa/noa-sepa.index.json (operator-local run) — auto-fetch " +
        "dead-letters here by design.",
    );
  }

  async parse(raw: RawArtifact, ctx: RunContext): Promise<ParsedSourceRecord[]> {
    if (!raw.body || raw.body.byteLength === 0) {
      throw new Error("tumwater_sepa: empty artifact body — not a captured index");
    }

    let json: unknown;
    try {
      json = JSON.parse(raw.body.toString("utf8"));
    } catch (err) {
      throw new Error(
        `tumwater_sepa: artifact body is not valid JSON — ${(err as Error).message}`,
      );
    }
    const parsed = IndexSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(
        `tumwater_sepa: captured index failed shape validation — ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    const { rows, source_url } = parsed.data;
    const sourceUrl = source_url ?? TUMWATER_NOA_SEPA_URL;

    const out: ParsedSourceRecord[] = [];
    const seenIds = new Set<string>();

    for (const row of rows) {
      const notices = this.flattenNotices(row);
      if (notices.length === 0) {
        ctx.logger.warn({ project: row.project }, "planning-notice row with no notice links; skipping");
        continue;
      }

      const caseNumber = CASE_RE.exec(row.project)?.[0]?.toUpperCase() ?? null;
      const projectName = row.project.replace(/,?\s*TUM-\d{2}-\d{4}\s*$/i, "").trim() || row.project;
      const externalId = caseNumber ?? slugId(row.project);
      if (seenIds.has(externalId)) {
        ctx.logger.warn({ externalId, project: row.project }, "duplicate planning-notice row; keeping first");
        continue;
      }
      seenIds.add(externalId);

      // Most-advanced notice present drives documentType; latest notice date is
      // the honest "source updated at" for the row.
      const mostAdvanced = notices.reduce((a, b) => (b.rank > a.rank ? b : a));
      const latestIso = notices
        .map((n) => n.isoDate)
        .filter((d): d is string => d !== null)
        .sort()
        .at(-1) ?? null;

      const evidence: NormalizedSourceRecord["evidence"] = [
        {
          factPath: "title",
          text: row.project,
          pageOrSection: "Notice of Applications & SEPA Determinations table",
        },
        ...notices.map((n) => ({
          factPath: "documentType",
          text: `${n.label} (${n.date})${n.external ? " — external Ecology record" : ""}: ${n.url}`,
          pageOrSection: `${n.label} column`,
        })),
      ];

      const record: NormalizedSourceRecord = {
        sourceKey: this.key,
        externalId,
        recordType: "public_notice",
        title: `${caseNumber ?? "Notice"} – ${projectName}`,
        description: null,
        permittingJurisdiction: "City of Tumwater",
        county: "Thurston",
        city: "Tumwater",
        addressRaw: null,
        parcelIds: [],
        geometry: null,
        applicationType: null,
        permitType: null,
        documentType: mostAdvanced.label,
        statusRaw: null,
        normalizedStage: "unknown",
        applicationDate: null,
        issueDate: null,
        sourceUpdatedAt: latestIso,
        valuationUsd: null,
        units: null,
        lots: null,
        squareFeet: null,
        organizations: [],
        sourceUrl,
        evidence,
      };

      out.push({
        record,
        rawFields: {
          project: row.project,
          projectName,
          caseNumber,
          notices: notices.map((n) => ({
            kind: n.kind,
            label: n.label,
            date: n.date,
            isoDate: n.isoDate,
            url: n.url,
            external: n.external,
          })),
        },
      });
    }

    if (out.length === 0) {
      throw new Error(
        `tumwater_sepa: zero records from ${sourceUrl} — index shape changed?`,
      );
    }
    ctx.logger.info({ records: out.length, rows: rows.length }, "tumwater_sepa parsed");
    return out;
  }

  /** Flatten a row's three notice columns into a single dated list. */
  private flattenNotices(row: z.infer<typeof RowSchema>): FlatNotice[] {
    const flat: FlatNotice[] = [];
    for (const k of KINDS) {
      const entries = row[k.field];
      if (!entries) continue;
      for (const e of entries) {
        flat.push({
          kind: k.field,
          label: k.label,
          rank: k.rank,
          date: e.date,
          isoDate: isoDate(e.date),
          url: e.url,
          external: isExternal(e.url),
        });
      }
    }
    return flat;
  }

  /**
   * Reconcile against the captured index: every row that carries at least one
   * notice link must yield exactly one record (nothing silently dropped).
   */
  checkInvariants(raw: RawArtifact, parsed: ParsedSourceRecord[]): InvariantViolation[] {
    const violations: InvariantViolation[] = [];
    if (!raw.body || raw.body.byteLength === 0) return violations;
    let json: unknown;
    try {
      json = JSON.parse(raw.body.toString("utf8"));
    } catch {
      return violations;
    }
    const index = IndexSchema.safeParse(json);
    if (!index.success) return violations;

    const expected = index.data.rows.filter((r) => this.flattenNotices(r).length > 0).length;
    const v = reconcileCount("tumwater_sepa:rows_with_notices", expected, parsed.length);
    if (v) violations.push(v);
    return violations;
  }
}
