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

  // Opportunities carrying evidence but NO confirmed row — genuinely unsupported.
  //
  // WAS COUNTING `oe.confirmed = false`, WHICH IS NOT AN UNSUPPORTED FACT.
  // `confirmed = false` is what `classifyClaim` returns for a B- or C-grade
  // source: real, linked, cited corroboration that simply is not an official
  // record. Counting it as unsupported would make legitimate corroboration look
  // like a quality failure — and because the gate requires an A-grade source for
  // the CORE event, an opportunity can be perfectly well supported while
  // carrying many `confirmed = false` rows.
  //
  // Latent, not live: every evidence row is grade A today, so both forms read 0.
  // It breaks the first time a B/C source lands, and the failure mode is a
  // quality metric that alarms on healthy data.
  const unsupported = await db.execute(sql`
    SELECT count(*) AS n FROM opportunities o
    WHERE o.account_profile_id = ${accountProfileId}
      AND EXISTS (SELECT 1 FROM opportunity_evidence oe WHERE oe.opportunity_id = o.id)
      AND NOT EXISTS (
        SELECT 1 FROM opportunity_evidence oe
        WHERE oe.opportunity_id = o.id AND oe.confirmed = true)`);

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

export interface OutcomeBucket {
  key: string;
  wins: number;
  losses: number;
  noBids: number;
  wonValue: number;
}

export interface OutcomeAttribution {
  decided: number;
  wins: number;
  losses: number;
  noBids: number;
  /** wins / (wins + losses); null below 5 decided bids (never a thin rate). */
  winRate: number | null;
  wonValue: number;
  byCounty: OutcomeBucket[];
  byRoute: OutcomeBucket[];
}

const WIN_RATE_MIN_DECIDED = 5;

/**
 * Wave 2 E3 — outcome attribution from the decision-label ledger (Phase 4
 * `pursuit_outcome` snapshots: what the human saw AT decision time, never a
 * re-derivation). All-time, account-scoped; honest-sparse: with few labels the
 * counts are simply small and the win rate stays null.
 */
export async function outcomeAttribution(db: Db, accountProfileId: string): Promise<OutcomeAttribution> {
  const res = await db.execute(sql`
    SELECT COALESCE(snapshot ->> 'county', 'unknown') AS county,
      COALESCE(snapshot ->> 'route', 'unrouted') AS route,
      snapshot ->> 'outcome' AS outcome,
      snapshot ->> 'outcomeValue' AS outcome_value
    FROM decision_labels
    WHERE account_profile_id = ${accountProfileId} AND kind = 'pursuit_outcome'`);

  const totals = { decided: 0, wins: 0, losses: 0, noBids: 0, wonValue: 0 };
  const byCounty = new Map<string, OutcomeBucket>();
  const byRoute = new Map<string, OutcomeBucket>();
  const bucket = (m: Map<string, OutcomeBucket>, key: string): OutcomeBucket => {
    const b = m.get(key) ?? { key, wins: 0, losses: 0, noBids: 0, wonValue: 0 };
    m.set(key, b);
    return b;
  };
  for (const raw of res.rows as { county: string; route: string; outcome: string | null; outcome_value: string | null }[]) {
    const outcome = raw.outcome;
    if (outcome !== "won" && outcome !== "lost" && outcome !== "no_bid") continue;
    totals.decided += 1;
    const value = raw.outcome_value === null ? 0 : Number(raw.outcome_value) || 0;
    for (const b of [bucket(byCounty, raw.county), bucket(byRoute, raw.route)]) {
      if (outcome === "won") {
        b.wins += 1;
        b.wonValue += value;
      } else if (outcome === "lost") b.losses += 1;
      else b.noBids += 1;
    }
    if (outcome === "won") {
      totals.wins += 1;
      totals.wonValue += value;
    } else if (outcome === "lost") totals.losses += 1;
    else totals.noBids += 1;
  }
  const decidedBids = totals.wins + totals.losses;
  const sort = (m: Map<string, OutcomeBucket>) =>
    [...m.values()].sort((a, b) => b.wins + b.losses + b.noBids - (a.wins + a.losses + a.noBids));
  return {
    ...totals,
    winRate: decidedBids >= WIN_RATE_MIN_DECIDED ? Math.round((totals.wins / decidedBids) * 1000) / 1000 : null,
    byCounty: sort(byCounty),
    byRoute: sort(byRoute),
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
