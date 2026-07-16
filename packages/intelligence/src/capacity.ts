import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";

/**
 * S0 (strengthening addendum §5) — capacity-aware qualification. Reads the
 * versioned capacity snapshot effective at a point in time and produces a
 * DETERMINISTIC, explained assessment. No model, no guessing: every penalty and
 * exclusion has a stated reason, and unknown inputs yield "unknown" (never a
 * fabricated fit).
 */

export interface CapacitySnapshot {
  id: string;
  accountProfileId: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  availableCrews: number | null;
  backlogState: string | null;
  preferredStartWindow: string | null;
  minimumContractValue: number | null;
  idealContractValue: number | null;
  maximumContractValue: number | null;
  maximumTravelMinutes: number | null;
  acceptsPublicWork: boolean | null;
  bondingLimit: number | null;
  tradeCapacityJson: Record<string, unknown> | null;
  provisional: boolean;
  notes: string | null;
}

export type CapacityAssessmentValue =
  | "unknown"
  | "likely_fit"
  | "possible_stretch"
  | "likely_too_large"
  | "excluded";

export interface CapacityAssessment {
  assessment: CapacityAssessmentValue;
  /** Multiplier applied to the deterministic score (1 = no change, 0 = drop). */
  priorityFactor: number;
  explanation: string;
  /** True when the snapshot's values are provisional placeholders (not calibrated). */
  provisional: boolean;
}

/** The snapshot effective at `at` (effective_from ≤ at < effective_to), newest first. */
export async function effectiveCapacitySnapshot(
  db: Db,
  accountProfileId: string,
  at: Date,
): Promise<CapacitySnapshot | null> {
  const res = await db.execute(sql`
    SELECT * FROM account_capacity_snapshots
    WHERE account_profile_id = ${accountProfileId}
      AND effective_from <= ${at.toISOString()}
      AND (effective_to IS NULL OR effective_to > ${at.toISOString()})
    ORDER BY effective_from DESC
    LIMIT 1`);
  const r = res.rows[0] as Record<string, unknown> | undefined;
  if (!r) return null;
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    id: r["id"] as string,
    accountProfileId: r["account_profile_id"] as string,
    effectiveFrom: new Date(r["effective_from"] as string),
    effectiveTo: r["effective_to"] ? new Date(r["effective_to"] as string) : null,
    availableCrews: num(r["available_crews"]),
    backlogState: (r["backlog_state"] as string | null) ?? null,
    preferredStartWindow: (r["preferred_start_window"] as string | null) ?? null,
    minimumContractValue: num(r["minimum_contract_value"]),
    idealContractValue: num(r["ideal_contract_value"]),
    maximumContractValue: num(r["maximum_contract_value"]),
    maximumTravelMinutes: num(r["maximum_travel_minutes"]),
    acceptsPublicWork: (r["accepts_public_work"] as boolean | null) ?? null,
    bondingLimit: num(r["bonding_limit"]),
    tradeCapacityJson: (r["trade_capacity_json"] as Record<string, unknown> | null) ?? null,
    provisional: Boolean(r["provisional"]),
    notes: (r["notes"] as string | null) ?? null,
  };
}

export interface CapacityInput {
  valuationUsd: number | null;
  isPublicWork: boolean;
}

/**
 * Deterministic capacity fit. Hard exclusions (public work the account won't
 * take) come first — they must precede any model call so we never spend a
 * budget on a project we cannot serve. Size fit demotes rather than deletes a
 * strategically large project (it becomes relationship-radar). Every branch
 * carries a human-readable explanation.
 */
export function assessCapacity(
  input: CapacityInput,
  snap: CapacitySnapshot | null,
): CapacityAssessment {
  if (!snap) {
    return {
      assessment: "unknown",
      priorityFactor: 1,
      explanation: "no capacity snapshot on file — size/fit not assessed",
      provisional: false,
    };
  }
  const tag = snap.provisional ? " (provisional — pending calibration)" : "";
  if (input.isPublicWork && snap.acceptsPublicWork === false) {
    return {
      assessment: "excluded",
      priorityFactor: 0,
      explanation: `public-works project, but the account does not accept public work${tag}`,
      provisional: snap.provisional,
    };
  }
  if (input.valuationUsd === null) {
    return {
      assessment: "unknown",
      priorityFactor: 1,
      explanation: "project valuation unknown — size fit not assessed",
      provisional: snap.provisional,
    };
  }
  const v = input.valuationUsd;
  const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
  if (snap.maximumContractValue !== null && v > snap.maximumContractValue) {
    return {
      assessment: "likely_too_large",
      priorityFactor: 0.4,
      explanation: `valuation ${usd(v)} exceeds the account's maximum contract value ${usd(snap.maximumContractValue)} — keep as relationship radar, not a direct pursuit${tag}`,
      provisional: snap.provisional,
    };
  }
  if (snap.minimumContractValue !== null && v < snap.minimumContractValue) {
    return {
      assessment: "possible_stretch",
      priorityFactor: 0.6,
      explanation: `valuation ${usd(v)} is below the account's minimum useful job size ${usd(snap.minimumContractValue)}${tag}`,
      provisional: snap.provisional,
    };
  }
  return {
    assessment: "likely_fit",
    priorityFactor: 1,
    explanation:
      snap.idealContractValue !== null
        ? `valuation ${usd(v)} is within the account's serviceable range (ideal ${usd(snap.idealContractValue)})${tag}`
        : `valuation ${usd(v)} is within the account's serviceable range${tag}`,
    provisional: snap.provisional,
  };
}
