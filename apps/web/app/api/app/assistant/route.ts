import { NextResponse } from "next/server";
import { assistantQuery, budgetFromEnv, providerFromEnv } from "@otn/intelligence";
import { jsonError, withAccount } from "../../../../lib/api.js";

// POST /api/app/assistant — a Charlie-style natural-language assistant over the
// account's OWN opportunities ("what's winnable in Thurston this week?"). Body:
// { question: string }. Account-scoped by construction: the query is always
// WHERE account_profile_id = account.id (never a caller-supplied param), so one
// account can never see another's opportunities. The model only maps the
// question to a whitelisted, Zod-validated filter and narrates over rows the
// deterministic query already retrieved — it never authors SQL. Provider +
// budget resolve from env the same way the worker does; with no model key (or
// no configured budget) the assistant returns a clean `blocked` status with a
// deterministic answer + a recorded model_runs row — it never fabricates.
export const POST = withAccount(async ({ db, account, req }) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "invalid JSON body");
  }
  const question = (body as { question?: unknown } | null)?.question;
  if (typeof question !== "string" || question.trim().length === 0) {
    return jsonError(400, "question must be a non-empty string");
  }

  const provider = providerFromEnv();
  const budget = budgetFromEnv();
  const result = await assistantQuery(db, provider, account.id, question.trim(), { budget });

  return NextResponse.json({
    status: result.status,
    answer: result.answer,
    opportunityIds: result.opportunityIds,
    matches: result.matches,
    filter: result.filter,
    modelRunId: result.modelRunId,
    reason: result.reason ?? null,
  });
});
