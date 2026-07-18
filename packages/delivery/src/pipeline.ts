import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";
import { evidenceLeadTime, firstLookByCoverage, type SourceFirstLook } from "./leadtime.js";

/**
 * The customer-facing pipeline headline — the one view that answers "what did
 * OTN get me?": a sourced → pursued → bid → won funnel with dollar attribution,
 * plus the lead-time-vs-boards proof. Every number is reproduced from stored
 * rows (opportunities, the pursuit state machine, opportunity_outcomes) — no
 * manual aggregates, and dollars only where a human recorded them. This is a
 * composition over existing measurements (the pursuit lifecycle, the ROI
 * scorecard, evidence lead time, first-look coverage), not a new source of
 * truth.
 */

export interface PipelineSummary {
  /** Opportunities OTN put in front of the account (priority/digest band or promoted). */
  surfacedByOtn: number;
  /** Pursuits the owner opened from those opportunities. */
  pursuitsStarted: number;
  /** Pursuits that reached a bidding state (bid_confirmed or later). */
  reachedBidding: number;
  /** Pursuits that reached submission (submitted/won/lost). */
  reachedSubmission: number;
  won: number;
  lost: number;
  /** Sum of outcome_value on won pursuits (human-entered). */
  wonValueUsd: number;
  /** Sum of submitted/estimated value on still-active pursuits. */
  inFlightValueUsd: number;
  /** Human-attributed contract value marked OTN-influenced (all time). */
  influencedValueUsd: number;
  /** Median days of advance notice on the account's milestoned projects
   * (evidence lead time). Null when nothing is measured yet. */
  medianAdvanceNoticeDays: number | null;
  /** The strongest first-look line to headline: the source×county with the
   * largest median lead when early. Null until a group meets the sample floor. */
  firstLookHeadline: SourceFirstLook | null;
}

export async function pipelineSummary(
  db: Db,
  accountProfileId: string,
): Promise<PipelineSummary> {
  const surfaced = await db.execute(sql`
    SELECT count(*) AS n FROM opportunities
    WHERE account_profile_id = ${accountProfileId}
      AND state IN ('priority_review', 'weekly_digest', 'promoted')`);

  const funnel = await db.execute(sql`
    SELECT
      count(*) AS started,
      count(*) FILTER (WHERE state IN ('bid_confirmed','bid_decision_pending','estimating','submitted','won','lost')) AS reached_bidding,
      count(*) FILTER (WHERE state IN ('submitted','won','lost')) AS reached_submission,
      count(*) FILTER (WHERE state = 'won') AS won,
      count(*) FILTER (WHERE state = 'lost') AS lost,
      COALESCE(sum(outcome_value) FILTER (WHERE state = 'won'), 0) AS won_value,
      COALESCE(sum(COALESCE(submitted_value, estimated_contract_value))
        FILTER (WHERE state NOT IN ('won','lost','no_bid','archived')), 0) AS in_flight_value
    FROM pursuits WHERE account_profile_id = ${accountProfileId}`);

  const influenced = await db.execute(sql`
    SELECT COALESCE(sum(oo.attributable_value), 0) AS v
    FROM opportunity_outcomes oo
    JOIN opportunities o ON o.id = oo.opportunity_id
    WHERE o.account_profile_id = ${accountProfileId} AND oo.influenced_by_otn = true`);

  const [lead, firstLook] = await Promise.all([
    evidenceLeadTime(db, accountProfileId),
    firstLookByCoverage(db),
  ]);

  const f = funnel.rows[0] as Record<string, unknown>;
  const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
  // firstLookByCoverage is ordered by median-when-early desc, so the first row
  // with a real early lead is the strongest headline.
  const headline = firstLook.find((r) => (r.medianLeadDaysWhenEarly ?? 0) > 0) ?? null;

  return {
    surfacedByOtn: num((surfaced.rows[0] as { n: unknown }).n),
    pursuitsStarted: num(f["started"]),
    reachedBidding: num(f["reached_bidding"]),
    reachedSubmission: num(f["reached_submission"]),
    won: num(f["won"]),
    lost: num(f["lost"]),
    wonValueUsd: num(f["won_value"]),
    inFlightValueUsd: num(f["in_flight_value"]),
    influencedValueUsd: num((influenced.rows[0] as { v: unknown }).v),
    medianAdvanceNoticeDays: lead.medianDays,
    firstLookHeadline: headline,
  };
}
