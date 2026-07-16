import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";
import { deliveryQualityMetrics } from "./metrics.js";

/**
 * S5 (strengthening addendum §8) — outcome/ROI scorecard. Every number is
 * reproduced from stored events; there are no manually edited aggregates.
 * Attributable revenue is only counted when a human set influenced_by_otn.
 */

export interface RoiScorecard {
  periodStart: string;
  periodEnd: string;
  opportunitiesDelivered: number;
  newToCustomer: number;
  relevantRate: number | null;
  worthPursuingRate: number | null;
  relationshipTargetsCreated: number;
  invitationsConnectedToSignal: number;
  bidsSubmitted: number;
  wins: number;
  losses: number;
  noBids: number;
  influencedContractValue: number;
  researchTimeSavedMinutes: number;
  duplicateRate: number | null;
  expiredRate: number | null;
  unsupportedFactCount: number;
}

function num(v: unknown): number {
  return v === null || v === undefined ? 0 : Number(v);
}

export async function roiScorecard(
  db: Db,
  accountProfileId: string,
  period: { start: Date; end: Date },
): Promise<RoiScorecard> {
  const start = period.start.toISOString();
  const end = period.end.toISOString();

  // Delivered + new-to-customer: reproduced from stored delivery metadata items.
  const delivered = await db.execute(sql`
    SELECT COALESCE(SUM(cnt.total), 0) AS delivered, COALESCE(SUM(cnt.new_count), 0) AS new_items
    FROM deliveries d
    CROSS JOIN LATERAL (
      SELECT count(*) AS total, count(*) FILTER (WHERE (it->>'isNew')::boolean) AS new_count
      FROM jsonb_array_elements(COALESCE(d.metadata_json->'items', '[]'::jsonb)) it
    ) cnt
    WHERE d.account_profile_id = ${accountProfileId} AND d.period_end >= ${start} AND d.period_end < ${end}`);
  const dRow = delivered.rows[0] as { delivered: string; new_items: string };

  const fb = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE f.relevant IS NOT NULL) AS relevant_answered,
      count(*) FILTER (WHERE f.relevant = true) AS relevant_yes,
      count(*) FILTER (WHERE f.worth_pursuing IS NOT NULL) AS worth_answered,
      count(*) FILTER (WHERE f.worth_pursuing = true) AS worth_yes
    FROM feedback f JOIN opportunities o ON o.id = f.opportunity_id
    WHERE o.account_profile_id = ${accountProfileId} AND f.created_at >= ${start} AND f.created_at < ${end}`);
  const fRow = fb.rows[0] as { relevant_answered: string; relevant_yes: string; worth_answered: string; worth_yes: string };

  const rel = await db.execute(sql`
    SELECT count(*) AS n FROM account_organization_relationships
    WHERE account_profile_id = ${accountProfileId} AND relationship_state IN ('target', 'preferred')
      AND created_at >= ${start} AND created_at < ${end}`);

  const inv = await db.execute(sql`
    SELECT count(*) AS n FROM bid_invitations
    WHERE account_profile_id = ${accountProfileId} AND match_status = 'matched'
      AND created_at >= ${start} AND created_at < ${end}`);

  const pur = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE t.to_state = 'submitted') AS submitted,
      count(*) FILTER (WHERE t.to_state = 'won') AS wins,
      count(*) FILTER (WHERE t.to_state = 'lost') AS losses,
      count(*) FILTER (WHERE t.to_state = 'no_bid') AS no_bids
    FROM pursuit_transitions t JOIN pursuits p ON p.id = t.pursuit_id
    WHERE p.account_profile_id = ${accountProfileId} AND t.created_at >= ${start} AND t.created_at < ${end}`);
  const pRow = pur.rows[0] as { submitted: string; wins: string; losses: string; no_bids: string };

  const outcome = await db.execute(sql`
    SELECT COALESCE(SUM(oo.attributable_value), 0) AS v
    FROM opportunity_outcomes oo JOIN opportunities o ON o.id = oo.opportunity_id
    WHERE o.account_profile_id = ${accountProfileId} AND oo.influenced_by_otn = true
      AND oo.outcome_at >= ${start} AND oo.outcome_at < ${end}`);

  const research = await db.execute(sql`
    SELECT COALESCE(SUM(minutes_saved_estimate), 0) AS m FROM research_time_entries
    WHERE account_profile_id = ${accountProfileId} AND created_at >= ${start} AND created_at < ${end}`);

  // Unsupported facts on the account's delivered opportunities (gate keeps this 0).
  const unsupported = await db.execute(sql`
    SELECT count(*) AS n FROM opportunity_evidence oe JOIN opportunities o ON o.id = oe.opportunity_id
    WHERE o.account_profile_id = ${accountProfileId} AND oe.confirmed = false`);

  const quality = await deliveryQualityMetrics(db, { accountProfileId });

  const ratio = (yes: string, total: string): number | null =>
    num(total) === 0 ? null : Math.round((num(yes) / num(total)) * 1000) / 1000;

  return {
    periodStart: start,
    periodEnd: end,
    opportunitiesDelivered: num(dRow.delivered),
    newToCustomer: num(dRow.new_items),
    relevantRate: ratio(fRow.relevant_yes, fRow.relevant_answered),
    worthPursuingRate: ratio(fRow.worth_yes, fRow.worth_answered),
    relationshipTargetsCreated: num((rel.rows[0] as { n: string }).n),
    invitationsConnectedToSignal: num((inv.rows[0] as { n: string }).n),
    bidsSubmitted: num(pRow.submitted),
    wins: num(pRow.wins),
    losses: num(pRow.losses),
    noBids: num(pRow.no_bids),
    influencedContractValue: num((outcome.rows[0] as { v: string }).v),
    researchTimeSavedMinutes: num((research.rows[0] as { m: string }).m),
    duplicateRate: quality.duplicateRate,
    expiredRate: quality.expiredRate,
    unsupportedFactCount: num((unsupported.rows[0] as { n: string }).n),
  };
}

/** Record a human-attributed outcome. Attributable revenue only when influencedByOtn. */
export async function addOutcome(
  db: Db,
  input: {
    opportunityId: string;
    pursuitId?: string | null;
    outcomeType: string;
    influencedByOtn: boolean;
    attributableValue?: number | null;
    outcomeAt?: string | null;
    reasonCode?: string | null;
    createdBy?: string | null;
  },
): Promise<{ id: string }> {
  const res = await db.execute(sql`
    INSERT INTO opportunity_outcomes
      (opportunity_id, pursuit_id, outcome_type, influenced_by_otn, attributable_value, outcome_at, reason_code, created_by)
    VALUES (${input.opportunityId}, ${input.pursuitId ?? null}, ${input.outcomeType}, ${input.influencedByOtn},
      ${input.attributableValue ?? null}, ${input.outcomeAt ?? new Date().toISOString()}, ${input.reasonCode ?? null},
      ${input.createdBy ?? null})
    RETURNING id`);
  return { id: (res.rows[0] as { id: string }).id };
}

export async function addResearchTime(
  db: Db,
  input: { accountProfileId: string; opportunityId?: string | null; minutesSavedEstimate: number; estimationMethod?: string | null },
): Promise<{ id: string }> {
  const res = await db.execute(sql`
    INSERT INTO research_time_entries (account_profile_id, opportunity_id, minutes_saved_estimate, estimation_method)
    VALUES (${input.accountProfileId}, ${input.opportunityId ?? null}, ${input.minutesSavedEstimate}, ${input.estimationMethod ?? null})
    RETURNING id`);
  return { id: (res.rows[0] as { id: string }).id };
}
