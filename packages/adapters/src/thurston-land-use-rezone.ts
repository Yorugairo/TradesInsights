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
import type { EventType, NormalizedSourceRecord } from "@otn/domain";

/**
 * ⚠ VERIFY-FIRST SCAFFOLD — SHIPS DISABLED (config enabled:false). WS-G G.3.
 *
 * Thurston County — land-use / rezone & Comprehensive-Plan-Amendment docket.
 * A rezone or land-use amendment is the earliest first-class "Decisions"-layer
 * signal there is: it reshapes what may be built on a parcel YEARS before a
 * permit, and its SEPA determinations + adoption notices are public. The
 * strongest title/rezoning pilot signal in the pilot metro.
 *
 * Confirmed publisher (live web, 2026-07-21):
 *   Docket index: https://www.thurstoncountywa.gov/departments/community-planning-and-economic-development/community-planning/plans-programs-and-code-projects/comprehensive-plan-and-development-code-dockets
 *   Project list: https://www.thurstoncountywa.gov/departments/community-planning-and-economic-development/community-planning/list-plans-programs-codes
 * The live pages list applicant-initiated rezone/land-use amendments (e.g.
 * "Black Lake Quarry (Littlerock) Rezone", "Martin Way Land Use Plan and Rezone
 * Amendment", "Beaver Creek — CPA-20") each carrying dated notices, SEPA
 * determinations, and adoption records.
 *
 * As a DISABLED verify-first scaffold it must not auto-fetch before its
 * robots/terms review (skill step 3) and a real capture (step 4), so fetch() is
 * capture-fed: reads a genuine capture at
 * $OTN_CAPTURE_DIR/thurston_land_use_rezone/ else dead-letters.
 *
 * PENDING VERIFY-FIRST (source-adapter skill steps 1–4,7): confirm the live
 * docket's exact structure, review robots/terms, capture a genuine fixture, and
 * manually compare rows/counts before enabling. Fixture below is SYNTHETIC.
 *
 * Emitted signal (governing-rule honest): normalizedStage `entitlement` when the
 * row carries a dated action, else `unknown` (a bare docket listing with no
 * outcome — never guessed). recordType is chosen so the resolver derives the
 * applicable event — `sepa_document` → `sepa_determination` when a SEPA
 * determination is the most-advanced document, otherwise `public_notice` →
 * `notice_published`. `plat_approved` (an adoption outcome) is DECLARED as an
 * intended event and wired at activation; it is never fabricated on a stage.
 * Applicant-initiated rezones name individual owners, so organizations[] stays
 * empty (homeowner PII out of the bridge).
 */

const INTENDED_EVENTS: readonly EventType[] = [
  "notice_published",
  "sepa_determination",
  "plat_approved",
];

export const THURSTON_REZONE_DOCKET =
  "https://www.thurstoncountywa.gov/departments/community-planning-and-economic-development/community-planning/plans-programs-and-code-projects/comprehensive-plan-and-development-code-dockets";
export const THURSTON_REZONE_PROJECT_LIST =
  "https://www.thurstoncountywa.gov/departments/community-planning-and-economic-development/community-planning/list-plans-programs-codes";

/** Document kinds in lifecycle order; `rank` picks the most-advanced present and
 * drives the derived event. */
const KINDS = [
  { kind: "notice_of_application", label: "Notice of Application", rank: 1, event: "notice_published" as EventType },
  { kind: "sepa_determination", label: "SEPA Determination", rank: 2, event: "sepa_determination" as EventType },
  { kind: "adoption_notice", label: "Adoption / Ordinance", rank: 3, event: "plat_approved" as EventType },
] as const;
type DocKind = (typeof KINDS)[number]["kind"];
const KIND_BY_NAME = new Map(KINDS.map((k) => [k.kind, k]));

/** One dated document within a docket row. */
const DocumentSchema = z.object({
  kind: z.enum(["notice_of_application", "sepa_determination", "adoption_notice"]),
  date: z.string().min(1),
  url: z.string().url(),
});

/** One rezone / land-use amendment docket row, captured verbatim. */
const RowSchema = z.object({
  /** Docket/case number, e.g. "CPA-20", "2026-REZ-004". */
  case_number: z.string().min(1),
  project_name: z.string().min(1),
  /** "Rezone" | "Comprehensive Plan Amendment" | "Land Use Amendment". */
  docket_type: z.string().min(1),
  address: z.string().min(1).nullable().optional(),
  documents: z.array(DocumentSchema).default([]),
});

/** The captured index shape (fixtures/thurston_land_use_rezone/dockets.index.json). */
const IndexSchema = z.object({
  source_url: z.string().url().optional(),
  rows: z.array(RowSchema).min(1),
});

/** "MM/DD/YYYY" → "YYYY-MM-DD"; null on anything else (never guessed). */
function isoDate(raw: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
  if (!m) return null;
  return `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
}

export class ThurstonLandUseRezoneAdapter implements SourceAdapter {
  readonly key = "thurston_land_use_rezone";
  readonly parserVersion = "0.1.0";

  async discover(_ctx: RunContext): Promise<DiscoveredArtifact[]> {
    return [
      {
        idempotencyKey: `${this.key}:rezone_docket`,
        canonicalUrl: THURSTON_REZONE_DOCKET,
        parentUrl: THURSTON_REZONE_PROJECT_LIST,
        expectedContentType: "application/json",
        sourcePublishedAt: null,
      },
    ];
  }

  async fetch(item: DiscoveredArtifact, _ctx: RunContext): Promise<RawArtifact> {
    const captureDir = process.env.OTN_CAPTURE_DIR;
    if (captureDir) {
      try {
        const body = await readFile(join(captureDir, this.key, "dockets.index.json"));
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
        // Capture dir set but file missing/unreadable — fall through to dead-letter.
      }
    }
    throw new Error(
      `thurston_land_use_rezone: DISABLED verify-first scaffold — robots/terms review and a ` +
        `genuine capture are pending before any auto-fetch of ${item.canonicalUrl}. ` +
        "Capture-fed: stage a capture at " +
        "$OTN_CAPTURE_DIR/thurston_land_use_rezone/dockets.index.json — auto-fetch dead-letters " +
        "here by design.",
    );
  }

  async parse(raw: RawArtifact, ctx: RunContext): Promise<ParsedSourceRecord[]> {
    if (!raw.body || raw.body.byteLength === 0) {
      throw new Error("thurston_land_use_rezone: empty artifact body — not a captured index");
    }
    let json: unknown;
    try {
      json = JSON.parse(raw.body.toString("utf8"));
    } catch (err) {
      throw new Error(
        `thurston_land_use_rezone: artifact body is not valid JSON — ${(err as Error).message}`,
      );
    }
    const parsed = IndexSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(
        `thurston_land_use_rezone: captured index failed shape validation — ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    const { rows, source_url } = parsed.data;
    const sourceUrl = source_url ?? THURSTON_REZONE_DOCKET;

    const out: ParsedSourceRecord[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const externalId = row.case_number.toUpperCase();
      if (seen.has(externalId)) {
        ctx.logger.warn({ externalId }, "duplicate rezone docket row; keeping first");
        continue;
      }
      seen.add(externalId);

      // Most-advanced document present drives documentType + the derived event.
      const ranked = row.documents
        .map((d) => ({ ...d, meta: KIND_BY_NAME.get(d.kind as DocKind)! }))
        .sort((a, b) => a.meta.rank - b.meta.rank);
      const mostAdvanced = ranked.at(-1) ?? null;
      const latestIso =
        row.documents
          .map((d) => isoDate(d.date))
          .filter((d): d is string => d !== null)
          .sort()
          .at(-1) ?? null;

      // A SEPA determination is a `sepa_document` (→ sepa_determination); every
      // other docket action is a `public_notice` (→ notice_published). An
      // adoption's `plat_approved` outcome is declared, not stamped on a stage.
      const recordType =
        mostAdvanced?.kind === "sepa_determination" ? "sepa_document" : "public_notice";
      // Honest stage: entitlement while a dated action exists; unknown for a bare
      // listing with no outcome (governing rule — never guessed).
      const normalizedStage = row.documents.length > 0 ? "entitlement" : "unknown";

      const evidence: NormalizedSourceRecord["evidence"] = [
        {
          factPath: "title",
          text: `${row.case_number} — ${row.project_name} (${row.docket_type})`,
          pageOrSection: "Comprehensive Plan & Development Code docket",
        },
        ...ranked.map((d) => ({
          factPath: "documentType",
          text: `${d.meta.label} (${d.date}): ${d.url}`,
          pageOrSection: `${d.meta.label}`,
        })),
      ];

      const record: NormalizedSourceRecord = {
        sourceKey: this.key,
        externalId,
        recordType,
        title: `${row.case_number} – ${row.project_name}`,
        description: null,
        permittingJurisdiction: "Thurston County",
        county: "Thurston",
        city: null,
        addressRaw: row.address ?? null,
        parcelIds: [],
        geometry: null,
        applicationType: row.docket_type,
        permitType: null,
        documentType: mostAdvanced?.meta.label ?? null,
        statusRaw: null,
        normalizedStage,
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
          caseNumber: row.case_number,
          projectName: row.project_name,
          docketType: row.docket_type,
          address: row.address ?? null,
          documents: ranked.map((d) => ({ kind: d.kind, date: d.date, isoDate: isoDate(d.date), url: d.url })),
          // The event the most-advanced document maps to, plus the source's full
          // intended taxonomy (finalized at verify-first activation).
          derivedEventType: mostAdvanced?.meta.event ?? "notice_published",
          intendedEventTypes: INTENDED_EVENTS,
        },
      });
    }

    if (out.length === 0) {
      throw new Error(
        `thurston_land_use_rezone: zero records from ${sourceUrl} — index shape changed?`,
      );
    }
    ctx.logger.info({ records: out.length, rows: rows.length }, "thurston_land_use_rezone parsed");
    return out;
  }

  /** Reconcile against the captured index: every distinct docket case yields
   * exactly one record. */
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
    const expected = new Set(index.data.rows.map((r) => r.case_number.toUpperCase())).size;
    const v = reconcileCount("thurston_land_use_rezone:distinct_cases", expected, parsed.length);
    if (v) violations.push(v);
    return violations;
  }
}
