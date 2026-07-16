import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";

/**
 * M3.7 — feedback + disposition reasons (spec §21 M3.7, §2 "record feedback
 * and improve versioned rules"). Feedback is *input to calibration*: the
 * rollup below is what an operator reads before appending a new rule version
 * (appendRuleVersion). Feedback never mutates rules automatically — every
 * rule change is an explicit, versioned edit.
 */

/** Controlled disposition vocabulary. Free text goes in `notes`. */
export const DISPOSITION_REASONS = [
  "pursuing",
  "already_known",
  "wrong_trade",
  "out_of_territory",
  "too_small",
  "too_large",
  "too_late",
  "too_early",
  "wrong_customer_type",
  "duplicate",
  "insufficient_evidence",
  "other",
] as const;

export type DispositionReason = (typeof DISPOSITION_REASONS)[number];

export function isDispositionReason(v: unknown): v is DispositionReason {
  return typeof v === "string" && (DISPOSITION_REASONS as readonly string[]).includes(v);
}

export interface FeedbackSummary {
  accountProfileId: string;
  total: number;
  answered: { relevant: number; newToCustomer: number; timely: number; worthPursuing: number };
  yesRate: {
    relevant: number | null;
    newToCustomer: number | null;
    timely: number | null;
    worthPursuing: number | null;
  };
  byDisposition: Record<string, number>;
  byRoute: Record<string, { total: number; relevantYes: number; relevantNo: number }>;
}

function rate(yes: number, answered: number): number | null {
  return answered === 0 ? null : Math.round((yes / answered) * 1000) / 1000;
}

/**
 * Aggregate an account's feedback for rule calibration (spec §22 inputs:
 * which routes are missing, which dispositions dominate, relevance rates).
 */
export async function feedbackSummary(
  db: Db,
  accountProfileId: string,
): Promise<FeedbackSummary> {
  const res = await db.execute(sql`
    SELECT f.relevant, f.new_to_customer, f.timely, f.worth_pursuing,
      f.disposition_reason, o.route
    FROM feedback f
    JOIN opportunities o ON o.id = f.opportunity_id
    WHERE o.account_profile_id = ${accountProfileId}`);
  const rows = res.rows as {
    relevant: boolean | null;
    new_to_customer: boolean | null;
    timely: boolean | null;
    worth_pursuing: boolean | null;
    disposition_reason: string | null;
    route: string | null;
  }[];

  const counts = {
    relevant: { yes: 0, answered: 0 },
    newToCustomer: { yes: 0, answered: 0 },
    timely: { yes: 0, answered: 0 },
    worthPursuing: { yes: 0, answered: 0 },
  };
  const byDisposition: Record<string, number> = {};
  const byRoute: Record<string, { total: number; relevantYes: number; relevantNo: number }> = {};

  for (const r of rows) {
    const fields = [
      ["relevant", r.relevant],
      ["newToCustomer", r.new_to_customer],
      ["timely", r.timely],
      ["worthPursuing", r.worth_pursuing],
    ] as const;
    for (const [key, value] of fields) {
      if (value !== null) {
        counts[key].answered++;
        if (value) counts[key].yes++;
      }
    }
    if (r.disposition_reason) {
      byDisposition[r.disposition_reason] = (byDisposition[r.disposition_reason] ?? 0) + 1;
    }
    const route = r.route ?? "(none)";
    const bucket = (byRoute[route] ??= { total: 0, relevantYes: 0, relevantNo: 0 });
    bucket.total++;
    if (r.relevant === true) bucket.relevantYes++;
    if (r.relevant === false) bucket.relevantNo++;
  }

  return {
    accountProfileId,
    total: rows.length,
    answered: {
      relevant: counts.relevant.answered,
      newToCustomer: counts.newToCustomer.answered,
      timely: counts.timely.answered,
      worthPursuing: counts.worthPursuing.answered,
    },
    yesRate: {
      relevant: rate(counts.relevant.yes, counts.relevant.answered),
      newToCustomer: rate(counts.newToCustomer.yes, counts.newToCustomer.answered),
      timely: rate(counts.timely.yes, counts.timely.answered),
      worthPursuing: rate(counts.worthPursuing.yes, counts.worthPursuing.answered),
    },
    byDisposition,
    byRoute,
  };
}
