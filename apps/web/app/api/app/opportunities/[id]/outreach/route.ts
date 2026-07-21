import { NextResponse } from "next/server";
import {
  budgetFromEnv,
  buildDecisionMemo,
  generateOutreach,
  providerFromEnv,
} from "@otn/intelligence";
import { jsonError, withAccount } from "../../../../../../lib/api.js";

// POST /api/app/opportunities/{id}/outreach — generate a grounded, pre-drafted
// intro message the estimator can copy and send to the GC, composed from the
// opportunity's verified decision-memo menu (every claim traces to a cited
// fact). Account-scoped: ownership is enforced via the assembled memo's
// accountProfileId before any spend (spec §17). Provider + budget resolve from
// env the same way the worker does; with no model key (or no configured budget)
// the route returns a clean `blocked` status and records a blocked model_runs
// row — it never fabricates a message. It only DRAFTS: nothing is ever sent.
export const POST = withAccount<{ id: string }>(async ({ db, account, params }) => {
  const memo = await buildDecisionMemo(db, params.id);
  if (!memo || memo.accountProfileId !== account.id) return jsonError(404, "opportunity not found");

  // Guard on the model env exactly as the worker does: no key ⇒ provider null ⇒
  // generateOutreach records + returns `blocked` (never unlimited). A missing
  // LLM_MONTHLY_BUDGET_USD blocks at the budget pre-flight for the same reason.
  const provider = providerFromEnv();
  const budget = budgetFromEnv();
  const result = await generateOutreach(db, provider, params.id, { budget });

  return NextResponse.json({
    status: result.status,
    modelRunId: result.modelRunId,
    draft: result.draft ?? null,
    reason: result.reason ?? null,
  });
});
