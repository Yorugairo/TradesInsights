import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";

/**
 * Spec §13 spend limits. The monthly ledger is the sum of cost_usd over
 * model_runs in the current calendar month (UTC) — every spending call must
 * persist a row, so the ledger and reality cannot drift. No configured
 * monthly budget means model jobs are blocked, never "unlimited".
 */

export interface BudgetConfig {
  monthlyCapUsd: number | null;
  perJobCapUsd: number;
}

export const DEFAULT_PER_JOB_CAP_USD = 0.5;

export function budgetFromEnv(env: NodeJS.ProcessEnv = process.env): BudgetConfig {
  const monthly = env.LLM_MONTHLY_BUDGET_USD ? Number(env.LLM_MONTHLY_BUDGET_USD) : null;
  const perJob = env.LLM_JOB_BUDGET_USD ? Number(env.LLM_JOB_BUDGET_USD) : DEFAULT_PER_JOB_CAP_USD;
  return {
    monthlyCapUsd: Number.isFinite(monthly) ? monthly : null,
    perJobCapUsd: Number.isFinite(perJob) && perJob > 0 ? perJob : DEFAULT_PER_JOB_CAP_USD,
  };
}

export async function monthlySpendUsd(db: Db): Promise<number> {
  const res = await db.execute(sql`
    SELECT COALESCE(sum(cost_usd), 0) AS spent
    FROM model_runs
    WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'utc')`);
  return Number((res.rows[0] as { spent: string | number }).spent);
}

export interface BudgetCheck {
  allowed: boolean;
  spentUsd: number;
  reason?: string;
}

/**
 * Pre-flight check before a model call. `estimatedJobCostUsd` is a worst-case
 * estimate (prompt size + max output tokens at the model's pricing); a job
 * whose worst case exceeds the per-job cap or the remaining monthly budget is
 * blocked before any spend happens.
 */
export async function checkBudget(
  db: Db,
  cfg: BudgetConfig,
  estimatedJobCostUsd: number,
): Promise<BudgetCheck> {
  if (cfg.monthlyCapUsd === null) {
    return {
      allowed: false,
      spentUsd: await monthlySpendUsd(db),
      reason: "LLM_MONTHLY_BUDGET_USD is not set — refusing to run model jobs without a budget",
    };
  }
  if (estimatedJobCostUsd > cfg.perJobCapUsd) {
    return {
      allowed: false,
      spentUsd: await monthlySpendUsd(db),
      reason: `estimated job cost $${estimatedJobCostUsd.toFixed(4)} exceeds per-job cap $${cfg.perJobCapUsd}`,
    };
  }
  const spentUsd = await monthlySpendUsd(db);
  if (spentUsd + estimatedJobCostUsd > cfg.monthlyCapUsd) {
    return {
      allowed: false,
      spentUsd,
      reason: `monthly budget exhausted: spent $${spentUsd.toFixed(2)} of $${cfg.monthlyCapUsd}`,
    };
  }
  return { allowed: true, spentUsd };
}
