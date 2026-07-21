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
 * ⚠ VERIFY-FIRST SCAFFOLD — SHIPS DISABLED (config enabled:false). WS-G G.2.
 *
 * Thurston County — Hearing Examiner DECISIONS. The Hearing Examiner is the
 * quasi-judicial officer who rules on plats/subdivisions, special uses,
 * variances, shoreline permits, and conditional uses — the pre-permit
 * ENTITLEMENT decisions that gate a project long before any building permit.
 * A published decision is a first-class "Decisions"-layer signal.
 *
 * Confirmed publisher (live web, 2026-07-21):
 *   Examiner:  https://www.thurstoncountywa.gov/departments/community-planning-and-economic-development/permitting/hearing-examiner
 *   Decisions: https://www.thurstoncountywa.gov/departments/community-planning-and-economic-development/permitting/hearing-examiner/hearing-examiner-decisions
 * The live page is a category-grouped list (Critical Areas/Shorelines, Plats,
 * Gravel Mines, …); each entry is `<case number YYYYNNNNNN> <TYPE> - <applicant>`
 * with a decision PDF link (observed types: SUP, VAR, CUP, SSDP, RUE, LLOT).
 *
 * thurstoncountywa.gov is directly fetchable (thurston_active_notices proves
 * it), so this need not be Akamai-class capture-fed — BUT as a DISABLED
 * verify-first scaffold it must not auto-fetch before its robots/terms review
 * (skill step 3) and a real capture (step 4). So fetch() is capture-fed: it
 * reads a genuine capture at $OTN_CAPTURE_DIR/thurston_hearing_examiner/ and
 * otherwise dead-letters with the verify-first reason.
 *
 * PENDING VERIFY-FIRST (source-adapter skill steps 1–4,7): confirm the live
 * list's exact columns, review robots/terms, capture a genuine fixture, and
 * manually compare rows/counts before enabling. Fixture below is SYNTHETIC.
 *
 * Emitted signal: recordType `public_notice` → resolver derives
 * `notice_published`; normalizedStage `entitlement` (a hearing-examiner land-use
 * case is an entitlement action). The approve/deny OUTCOME — and thus the
 * precise `decision_issued`/`plat_approved` event — lives inside the decision
 * PDF we do not fetch, so it is DECLARED as an intended event and wired at
 * activation, never fabricated. Applicant strings are often individual property
 * owners, so organizations[] stays empty (homeowner PII out of the bridge),
 * exactly like tumwater_sepa.
 */

const INTENDED_EVENTS: readonly EventType[] = ["decision_issued", "notice_published"];

export const THURSTON_HEARING_EXAMINER_LANDING =
  "https://www.thurstoncountywa.gov/departments/community-planning-and-economic-development/permitting/hearing-examiner";
export const THURSTON_HEARING_EXAMINER_DECISIONS =
  "https://www.thurstoncountywa.gov/departments/community-planning-and-economic-development/permitting/hearing-examiner/hearing-examiner-decisions";

/** Decision-type abbreviations observed on the live page → human labels. Unknown
 * codes pass through as-is (never invented). */
const DECISION_TYPES: Record<string, string> = {
  SUP: "Special Use Permit",
  CUP: "Conditional Use Permit",
  VAR: "Variance",
  SSDP: "Shoreline Substantial Development Permit",
  RUE: "Reasonable Use Exception",
  LLOT: "Legal Lot",
  ROM: "Release of Moratorium",
  AAPL: "Appeal",
  PSUB: "Preliminary Plat / Subdivision",
};

/** One published Hearing Examiner decision, captured verbatim. */
const DecisionSchema = z.object({
  /** Case number, live format YYYYNNNNNN (e.g. "2025101757"). */
  case_number: z.string().min(1),
  /** Decision-type abbreviation (SUP/VAR/SSDP/…). */
  decision_type: z.string().min(1),
  applicant: z.string().min(1),
  /** Section heading the decision was listed under. */
  category: z.string().min(1).optional(),
  /** "MM/DD/YYYY" decision date. */
  decision_date: z.string().min(1),
  document_url: z.string().url(),
});

/** The captured index shape (fixtures/thurston_hearing_examiner/decisions.index.json). */
const IndexSchema = z.object({
  source_url: z.string().url().optional(),
  decisions: z.array(DecisionSchema).min(1),
});

/** "MM/DD/YYYY" → "YYYY-MM-DD"; null on anything else (never guessed). */
function isoDate(raw: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
  if (!m) return null;
  return `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
}

export class ThurstonHearingExaminerAdapter implements SourceAdapter {
  readonly key = "thurston_hearing_examiner";
  readonly parserVersion = "0.1.0";

  async discover(_ctx: RunContext): Promise<DiscoveredArtifact[]> {
    return [
      {
        idempotencyKey: `${this.key}:decisions_index`,
        canonicalUrl: THURSTON_HEARING_EXAMINER_DECISIONS,
        parentUrl: THURSTON_HEARING_EXAMINER_LANDING,
        expectedContentType: "application/json",
        sourcePublishedAt: null,
      },
    ];
  }

  async fetch(item: DiscoveredArtifact, _ctx: RunContext): Promise<RawArtifact> {
    const captureDir = process.env.OTN_CAPTURE_DIR;
    if (captureDir) {
      try {
        const body = await readFile(join(captureDir, this.key, "decisions.index.json"));
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
      `thurston_hearing_examiner: DISABLED verify-first scaffold — robots/terms review and a ` +
        "genuine capture are pending before any auto-fetch of " +
        `${item.canonicalUrl}. Capture-fed: stage a capture at ` +
        "$OTN_CAPTURE_DIR/thurston_hearing_examiner/decisions.index.json — auto-fetch " +
        "dead-letters here by design.",
    );
  }

  async parse(raw: RawArtifact, ctx: RunContext): Promise<ParsedSourceRecord[]> {
    if (!raw.body || raw.body.byteLength === 0) {
      throw new Error("thurston_hearing_examiner: empty artifact body — not a captured index");
    }
    let json: unknown;
    try {
      json = JSON.parse(raw.body.toString("utf8"));
    } catch (err) {
      throw new Error(
        `thurston_hearing_examiner: artifact body is not valid JSON — ${(err as Error).message}`,
      );
    }
    const parsed = IndexSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(
        `thurston_hearing_examiner: captured index failed shape validation — ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    const { decisions, source_url } = parsed.data;
    const sourceUrl = source_url ?? THURSTON_HEARING_EXAMINER_DECISIONS;

    const out: ParsedSourceRecord[] = [];
    const seen = new Set<string>();
    for (const d of decisions) {
      // A case can carry more than one decision (e.g. a remand); key on
      // case + type so each is one record and reruns are idempotent.
      const externalId = `${d.case_number}-${d.decision_type.toUpperCase()}`;
      if (seen.has(externalId)) {
        ctx.logger.warn({ externalId }, "duplicate hearing-examiner decision; keeping first");
        continue;
      }
      seen.add(externalId);
      const typeLabel = DECISION_TYPES[d.decision_type.toUpperCase()] ?? d.decision_type;
      const iso = isoDate(d.decision_date);

      const evidence: NormalizedSourceRecord["evidence"] = [
        {
          factPath: "externalId",
          text: `${d.case_number} ${d.decision_type} — ${d.applicant}`,
          pageOrSection: d.category ? `${d.category} decisions` : "Hearing Examiner decisions",
        },
        {
          factPath: "documentType",
          text: `${typeLabel} decision (${d.decision_date}): ${d.document_url}`,
          pageOrSection: "decision document",
        },
      ];

      const record: NormalizedSourceRecord = {
        sourceKey: this.key,
        externalId,
        recordType: "public_notice",
        title: `${d.case_number} ${d.decision_type} – ${d.applicant}`,
        description: null,
        permittingJurisdiction: "Thurston County",
        county: "Thurston",
        city: null,
        addressRaw: null,
        parcelIds: [],
        geometry: null,
        applicationType: null,
        permitType: null,
        documentType: `${typeLabel} Decision`,
        // The examiner has ISSUED a decision, but approve/deny is inside the PDF
        // we don't fetch — so stage stays at the entitlement action, never claims
        // `approved` (mirrors tumwater_sepa's honest `unknown`-on-outcome stance).
        statusRaw: "decision issued",
        normalizedStage: "entitlement",
        applicationDate: null,
        issueDate: null,
        sourceUpdatedAt: iso,
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
          caseNumber: d.case_number,
          decisionType: d.decision_type.toUpperCase(),
          decisionTypeLabel: typeLabel,
          applicant: d.applicant,
          category: d.category ?? null,
          decisionDate: d.decision_date,
          documentUrl: d.document_url,
          intendedEventTypes: INTENDED_EVENTS,
        },
      });
    }

    if (out.length === 0) {
      throw new Error(
        `thurston_hearing_examiner: zero records from ${sourceUrl} — index shape changed?`,
      );
    }
    ctx.logger.info({ records: out.length, decisions: decisions.length }, "thurston_hearing_examiner parsed");
    return out;
  }

  /** Reconcile against the captured index: every distinct case/type decision
   * yields exactly one record. */
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
    const expected = new Set(
      index.data.decisions.map((d) => `${d.case_number}-${d.decision_type.toUpperCase()}`),
    ).size;
    const v = reconcileCount("thurston_hearing_examiner:distinct_decisions", expected, parsed.length);
    if (v) violations.push(v);
    return violations;
  }
}
