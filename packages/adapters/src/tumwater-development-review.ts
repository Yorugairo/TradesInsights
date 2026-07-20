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

export const TUMWATER_DRC_URL =
  "https://www.ci.tumwater.wa.us/departments/community-development-department/permitting-building/development-review";

/**
 * City of Tumwater — Development Review Committee (DRC) agendas (spec §6, P0;
 * Thurston home-metro pre-application/development-review pipeline). The page is a
 * simple table (Date / Meeting Type / Agenda) listing one weekly DRC meeting per
 * row, each linking a Laserfiche agenda PDF.
 *
 * Capture-fed, like tumwater_sepa / PALS / Olympia: `ci.tumwater.wa.us` sits
 * behind an Akamai edge policy that fingerprints the client — a genuine in-region
 * browser gets normal content, but curl/automated/datacenter clients get a 403
 * challenge we will not defeat (docs/source-policy.md). So `fetch()` is
 * contract-complete but dead-letters against the live gate, and the PARSER runs
 * over the captured index (fixtures/tumwater_development_review/drc-agendas.index.json).
 *
 * The index carries NO party data — the applicants and projects live inside the
 * linked agenda PDFs, which we do not fetch. That is deliberate: DRC agendas name
 * individual homeowners bringing pre-application projects, and this surface must
 * not carry homeowner PII into the registry bridge. So organizations[] is empty,
 * and a meeting agenda decides nothing, so normalizedStage stays `unknown`
 * (mirrors tumwater_sepa / thurston_active_notices). One record per meeting.
 */

/** A single Development Review Committee meeting row. */
const AgendaRowSchema = z.object({
  agenda: z.string().min(1),
  url: z.string().url(),
  meeting_type: z.string().optional(),
});

/** The captured index shape (fixtures/tumwater_development_review/drc-agendas.index.json). */
const IndexSchema = z.object({
  source_url: z.string().url().optional(),
  agenda_rows: z.array(AgendaRowSchema).min(1),
});

/** "MM-DD-YYYY" or "MM/DD/YYYY" → "YYYY-MM-DD"; null on anything else (never guessed).
 * Both separators appear live (recent rows use hyphens, pre-2025 rows use slashes). */
export function agendaDateIso(raw: string): string | null {
  const m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(raw.trim());
  if (!m) return null;
  return `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
}

export class TumwaterDevelopmentReviewAdapter implements SourceAdapter {
  readonly key = "tumwater_development_review";
  readonly parserVersion = "1.0.0";

  async discover(_ctx: RunContext): Promise<DiscoveredArtifact[]> {
    return [
      {
        idempotencyKey: `${this.key}:drc_agendas_index`,
        canonicalUrl: TUMWATER_DRC_URL,
        parentUrl: null,
        expectedContentType: "application/json",
        sourcePublishedAt: null,
      },
    ];
  }

  async fetch(item: DiscoveredArtifact, _ctx: RunContext): Promise<RawArtifact> {
    // Akamai fingerprints the client: a genuine in-region browser sees the page,
    // but automated/datacenter clients get a 403 challenge we will not defeat.
    // Reproduce the gate as a dead-letter rather than feeding a challenge page to
    // the parser — this source is genuine-visitor capture-fed by design.
    throw new Error(
      `tumwater_development_review: ${item.canonicalUrl} is served behind an Akamai edge ` +
        "policy that 403s automated/datacenter clients (a genuine in-region browser is " +
        "required; no bot bypass). This source is capture-fed; auto-fetch dead-letters " +
        "here by design — the parser runs over the captured DRC agendas index.",
    );
  }

  async parse(raw: RawArtifact, ctx: RunContext): Promise<ParsedSourceRecord[]> {
    if (!raw.body || raw.body.byteLength === 0) {
      throw new Error("tumwater_development_review: empty artifact body — not a captured index");
    }

    let json: unknown;
    try {
      json = JSON.parse(raw.body.toString("utf8"));
    } catch (err) {
      throw new Error(
        `tumwater_development_review: artifact body is not valid JSON — ${(err as Error).message}`,
      );
    }
    const parsed = IndexSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(
        `tumwater_development_review: captured index failed shape validation — ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    const { agenda_rows, source_url } = parsed.data;
    const sourceUrl = source_url ?? TUMWATER_DRC_URL;

    const out: ParsedSourceRecord[] = [];
    const seenIds = new Set<string>();

    for (const row of agenda_rows) {
      const iso = agendaDateIso(row.agenda);
      if (!iso) {
        ctx.logger.warn({ agenda: row.agenda }, "DRC agenda row without a parseable date; skipping");
        continue;
      }
      const externalId = `drc-${iso}`;
      if (seenIds.has(externalId)) {
        ctx.logger.warn({ externalId, agenda: row.agenda }, "duplicate DRC agenda date; keeping first");
        continue;
      }
      seenIds.add(externalId);

      const meetingType = row.meeting_type?.trim() || null;
      const canceled = meetingType != null && /cancel/i.test(meetingType);

      const record: NormalizedSourceRecord = {
        sourceKey: this.key,
        externalId,
        recordType: "public_notice",
        title: `Tumwater DRC agenda – ${iso}${meetingType ? ` (${meetingType})` : ""}`,
        description: null,
        permittingJurisdiction: "City of Tumwater",
        county: "Thurston",
        city: "Tumwater",
        addressRaw: null,
        parcelIds: [],
        geometry: null,
        applicationType: null,
        permitType: null,
        documentType: "development_review_agenda",
        statusRaw: meetingType,
        normalizedStage: "unknown",
        applicationDate: null,
        issueDate: null,
        sourceUpdatedAt: iso,
        valuationUsd: null,
        units: null,
        lots: null,
        squareFeet: null,
        organizations: [],
        sourceUrl,
        evidence: [
          {
            factPath: "title",
            text: `DRC agenda ${row.agenda}${meetingType ? ` — ${meetingType}` : ""}`,
            pageOrSection: "Development Review Committee — DRC Agendas table",
          },
          {
            factPath: "documentType",
            text: `Agenda (${row.agenda})${canceled ? " — meeting canceled" : ""}: ${row.url}`,
            pageOrSection: "Agenda column",
          },
        ],
      };

      out.push({
        record,
        rawFields: {
          agenda: row.agenda,
          agendaDate: iso,
          meetingType,
          url: row.url,
        },
      });
    }

    if (out.length === 0) {
      throw new Error(
        `tumwater_development_review: zero records from ${sourceUrl} — index shape changed?`,
      );
    }
    ctx.logger.info(
      { records: out.length, rows: agenda_rows.length },
      "tumwater_development_review parsed",
    );
    return out;
  }

  /**
   * Reconcile against the captured index: every agenda row with a parseable date
   * yields exactly one record (deduped by date, matching the parser).
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

    const uniqueDated = new Set(
      index.data.agenda_rows.map((r) => agendaDateIso(r.agenda)).filter((d): d is string => d !== null),
    ).size;
    const v = reconcileCount("tumwater_development_review:dated_rows", uniqueDated, parsed.length);
    return v ? [v] : [];
  }
}
