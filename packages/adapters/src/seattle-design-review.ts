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
 * City of Seattle SDCI — Design Review Board (DRB) upcoming meetings/agendas.
 * Design review is a first-class PRE-PERMIT land-use decision layer: a project
 * appears on the DRB calendar (Early Design Guidance, then Recommendation)
 * MONTHS before its building permit issues — exactly the window a commercial
 * finish sub (Solis drywall/paint) wants to see, because the GC buys out the
 * finish trades off the CDs during this review phase, before the permit exists.
 *
 * Confirmed publisher (live web, 2026-07-21):
 *   Program:  https://www.seattle.gov/sdci/about-us/who-we-are/design-review
 *   Meetings: https://www.seattle.gov/sdci/about-us/who-we-are/design-review/virtual-board-meetings
 * The actual meeting schedule is an INTERACTIVE calendar app
 * (web.seattle.gov/dpd/.../DesignReview/UpcomingReviews) rendered client-side —
 * not a static table. So this scaffold is CAPTURE-FED, mirroring
 * olympia_smartgov_reports / tumwater_sepa: fetch() reads a genuine-browser
 * capture staged at $OTN_CAPTURE_DIR/seattle_design_review/, and otherwise
 * dead-letters (it never drives a headless bot against the app).
 *
 * PENDING VERIFY-FIRST (source-adapter skill steps 1–4,7): confirm the live
 * calendar's exact field set, review seattle.gov robots/terms for the calendar
 * app, capture a genuine-browser fixture, and manually compare rows/counts
 * before enabling. The fixture below is CLEARLY-LABELED SYNTHETIC.
 *
 * Emitted signal: recordType `public_notice` → the resolver derives
 * `notice_published` (eventTypeFor); normalizedStage `entitlement` (design
 * review is part of land-use entitlement). A "Recommendation" meeting's OUTCOME
 * maps to `decision_issued`, but that lives in the agenda/report PDF we do not
 * fetch, so it is declared as an intended event and wired at activation — never
 * fabricated here. No party data: applicant/architect names live in the agenda
 * PDFs (not fetched), so organizations[] is empty (PII stays out of the bridge).
 */

/** The EVENT_TYPES this source is designed to feed (typed against the domain
 * enum so the intent can't drift from the taxonomy). `notice_published` is the
 * first-observation event; `decision_issued` is the Recommendation outcome,
 * wired during verify-first activation once the report PDF mapping is defined. */
const INTENDED_EVENTS: readonly EventType[] = ["notice_published", "decision_issued"];

export const SEATTLE_DESIGN_REVIEW_LANDING =
  "https://www.seattle.gov/sdci/about-us/who-we-are/design-review";
export const SEATTLE_DESIGN_REVIEW_MEETINGS =
  "https://www.seattle.gov/sdci/about-us/who-we-are/design-review/virtual-board-meetings";

/** One scheduled Design Review meeting, as captured verbatim from the calendar. */
const MeetingSchema = z.object({
  /** Seattle SDCI master use / design review record number, e.g. "3038291-EG". */
  project_number: z.string().min(1),
  address: z.string().min(1),
  /** "MM/DD/YYYY" — the scheduled meeting date. */
  meeting_date: z.string().min(1),
  /** Geographic board, e.g. "Northwest", "Southwest". */
  board_district: z.string().min(1),
  /** "Early Design Guidance" | "Recommendation" | "Administrative", etc. */
  meeting_type: z.string().min(1),
  agenda_url: z.string().url().nullable().optional(),
});

/** The captured index shape (fixtures/seattle_design_review/drb-agenda.index.json). */
const IndexSchema = z.object({
  source_url: z.string().url().optional(),
  meetings: z.array(MeetingSchema).min(1),
});

/** "MM/DD/YYYY" → "YYYY-MM-DD"; null on anything else (never guessed). */
function isoDate(raw: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
  if (!m) return null;
  return `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
}

export class SeattleDesignReviewAdapter implements SourceAdapter {
  readonly key = "seattle_design_review";
  // 0.x — pre-activation scaffold; bumps to 1.0.0 when verify-first completes.
  readonly parserVersion = "0.1.0";

  async discover(_ctx: RunContext): Promise<DiscoveredArtifact[]> {
    return [
      {
        idempotencyKey: `${this.key}:drb_calendar`,
        canonicalUrl: SEATTLE_DESIGN_REVIEW_MEETINGS,
        parentUrl: SEATTLE_DESIGN_REVIEW_LANDING,
        expectedContentType: "application/json",
        sourcePublishedAt: null,
      },
    ];
  }

  async fetch(item: DiscoveredArtifact, _ctx: RunContext): Promise<RawArtifact> {
    // Capture-fed: an operator-local run points OTN_CAPTURE_DIR at genuine-browser
    // captures. Read <OTN_CAPTURE_DIR>/seattle_design_review/drb-agenda.index.json
    // when present. The golden fixtures dir is NOT consulted here, so tests still
    // dead-letter (conditional-request/http-metadata discipline is added when the
    // live calendar's real transport is confirmed at activation).
    const captureDir = process.env.OTN_CAPTURE_DIR;
    if (captureDir) {
      try {
        const body = await readFile(join(captureDir, this.key, "drb-agenda.index.json"));
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
      `seattle_design_review: ${item.canonicalUrl} is an interactive client-side calendar ` +
        "app, and this source is a DISABLED verify-first scaffold (robots/terms review + a " +
        "genuine-browser capture are pending). Capture-fed: stage a capture at " +
        "$OTN_CAPTURE_DIR/seattle_design_review/drb-agenda.index.json — auto-fetch dead-letters " +
        "here by design; no headless-bot drive against the app.",
    );
  }

  async parse(raw: RawArtifact, ctx: RunContext): Promise<ParsedSourceRecord[]> {
    if (!raw.body || raw.body.byteLength === 0) {
      throw new Error("seattle_design_review: empty artifact body — not a captured index");
    }
    let json: unknown;
    try {
      json = JSON.parse(raw.body.toString("utf8"));
    } catch (err) {
      throw new Error(
        `seattle_design_review: artifact body is not valid JSON — ${(err as Error).message}`,
      );
    }
    const parsed = IndexSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(
        `seattle_design_review: captured index failed shape validation — ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    const { meetings, source_url } = parsed.data;
    const sourceUrl = source_url ?? SEATTLE_DESIGN_REVIEW_MEETINGS;

    const out: ParsedSourceRecord[] = [];
    const seen = new Set<string>();
    for (const m of meetings) {
      // A project can appear twice (EDG then Recommendation); key on
      // project_number + meeting_date so each dated meeting is one record and a
      // rerun of the same capture is idempotent.
      const externalId = `${m.project_number}@${isoDate(m.meeting_date) ?? m.meeting_date}`;
      if (seen.has(externalId)) {
        ctx.logger.warn({ externalId }, "duplicate DRB meeting row; keeping first");
        continue;
      }
      seen.add(externalId);
      const iso = isoDate(m.meeting_date);

      const evidence: NormalizedSourceRecord["evidence"] = [
        {
          factPath: "externalId",
          text: `${m.project_number} — ${m.address}`,
          pageOrSection: "Design Review calendar",
        },
        {
          factPath: "documentType",
          text: `${m.meeting_type} — ${m.board_district} board (${m.meeting_date})${m.agenda_url ? `: ${m.agenda_url}` : ""}`,
          pageOrSection: `${m.board_district} Design Review Board`,
        },
      ];

      const record: NormalizedSourceRecord = {
        sourceKey: this.key,
        externalId,
        recordType: "public_notice",
        title: `${m.project_number} – Design Review (${m.meeting_type})`,
        description: null,
        permittingJurisdiction: "City of Seattle",
        county: "King",
        city: "Seattle",
        addressRaw: m.address,
        parcelIds: [],
        geometry: null,
        applicationType: null,
        permitType: null,
        documentType: m.meeting_type,
        statusRaw: m.meeting_type,
        // Design review is a land-use ENTITLEMENT step; the approve/deny outcome
        // is inside the report PDF we do not fetch, so we never claim `approved`.
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
          projectNumber: m.project_number,
          address: m.address,
          meetingDate: m.meeting_date,
          boardDistrict: m.board_district,
          meetingType: m.meeting_type,
          agendaUrl: m.agenda_url ?? null,
          intendedEventTypes: INTENDED_EVENTS,
        },
      });
    }

    if (out.length === 0) {
      throw new Error(
        `seattle_design_review: zero records from ${sourceUrl} — index shape changed?`,
      );
    }
    ctx.logger.info({ records: out.length, meetings: meetings.length }, "seattle_design_review parsed");
    return out;
  }

  /** Reconcile against the captured index: every distinct dated meeting yields
   * exactly one record (nothing silently dropped, no phantom rows). */
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
      index.data.meetings.map((m) => `${m.project_number}@${isoDate(m.meeting_date) ?? m.meeting_date}`),
    ).size;
    const v = reconcileCount("seattle_design_review:distinct_meetings", expected, parsed.length);
    if (v) violations.push(v);
    return violations;
  }
}
