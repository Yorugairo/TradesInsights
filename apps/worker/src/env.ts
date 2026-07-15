import "./load-env.js";

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export interface ModelAvailability {
  available: boolean;
  reason: string;
}

/**
 * The app must boot without model keys (spec §3). Model-dependent jobs check
 * this and enter a visible blocked/skipped state instead of failing.
 */
export function modelAvailability(): ModelAvailability {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    return {
      available: false,
      reason: "no model API key configured — model-dependent jobs are blocked/skipped",
    };
  }
  if (!process.env.LLM_MONTHLY_BUDGET_USD) {
    return {
      available: false,
      reason: "LLM_MONTHLY_BUDGET_USD is not set — refusing to run model jobs without a budget",
    };
  }
  return { available: true, reason: "model provider configured with budget" };
}
