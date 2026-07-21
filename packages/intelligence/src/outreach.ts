import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";
import { buildDecisionMemo, type DecisionMemo } from "./memo.js";
import { buildBriefMenu, stripRefTokens } from "./brief.js";
import { checkBudget, type BudgetConfig } from "./extraction/budget.js";
import { persistModelRun } from "./extraction/runs.js";
import type { ModelProvider } from "./extraction/provider.js";
import { validateBrief, type BriefMenuItem, type BriefSegment } from "./extraction/brief-contract.js";

/**
 * WS-E — the pre-drafted GC outreach message. A brief-twin: the same
 * already-verified decision-memo menu the brief composes from, re-expressed as
 * a short, professional introduction the subcontractor (the account) could send
 * to the general contractor. The model NEVER introduces information — every
 * segment cites the refId(s) of the menu item(s) it rests on, and any number,
 * date, or name it writes must appear verbatim in a cited item (the shared
 * `validateBrief` guard). A draft that cites an unknown ref or invents a fact is
 * rejected and never surfaced.
 *
 * This only DRAFTS: it persists a `model_runs` row and returns the message for
 * the estimator to copy. It is never sent — there is no email/SMTP path here.
 * Runs without a model key (or budget) record a visible blocked state, never a
 * fabricated message.
 */

/** Bump when the outreach prompt or contract semantics change. */
export const OUTREACH_PROMPT_VERSION = "1.0.0";

// A GC intro is short (≤120 words ≈ ~170 tokens); 500 is safe headroom and
// keeps the worst-case pre-flight estimate well under the per-job cap.
const MAX_OUTPUT_TOKENS = 500;

// Worst-case pre-flight estimate at Opus-tier pricing ($5/$25 per MTok),
// mirroring the brief: the menu is small (curated verified items, not raw
// evidence), so this stays well under the per-job cap.
function estimateOutreachCostUsd(promptChars: number): number {
  const inputTokens = promptChars / 3.5;
  return (inputTokens * 5 + MAX_OUTPUT_TOKENS * 25) / 1_000_000;
}

const SYSTEM_PROMPT = `You draft a short, professional introduction MESSAGE that a trade subcontractor sends to the general contractor (GC) about ONE construction project, from a FIXED MENU of already-verified items. You compose a courteous outreach message; you never add information.

Rules (non-negotiable):
- Use ONLY the menu items. Every segment must cite the refId(s) of the menu item(s) it rests on. A segment citing a refId not in the menu invalidates your entire answer.
- Copy dollar amounts, unit counts, dates, names, and other specifics EXACTLY as written in the cited menu items — never round, reformat, or invent. Any name, phone, email, date, or number not present in a cited item invalidates your answer.
- Address the GC by name ONLY if a menu item states it (e.g. a role/talking-point item). If no menu item names the GC, address "the project team" — never invent a name or contact detail.
- Never claim the project is out to bid or in procurement unless a cited item explicitly says so. A permit is not a bid.
- Write the message as 2 to 4 short segments in the subcontractor's own voice: (1) a brief reference to the project (name/stage/county), citing its menu item(s); (2) a one-line value proposition, citing the fit/route context item; (3) a soft ask to be considered for the trade scope, citing the recommended-action or summary item. Keep the whole message under 120 words. No headings, no lists, no signature, no invented contact info.
- Respond with a single JSON object and nothing else (no markdown fences, no prose outside the JSON).

Output shape:
{ "segments": [ { "text": string, "kind": "fact"|"inference"|"context", "refs": [refId, ...] } ] }`;

export function buildOutreachPrompt(memo: DecisionMemo, menu: BriefMenuItem[]): string {
  const lines = menu.map((m) => `${m.refId} [${m.kind}]: ${m.text}`).join("\n");
  const missing = memo.missingCriticalFacts.map((m) => m.key).join(", ");
  return `Contractor account route: ${memo.route ?? "general"}.
Menu items (the ONLY things you may cite):
${lines}
${missing ? `\nStill unknown (do not invent — never fill these with a guess): ${missing}` : ""}

Draft the GC introduction message per the contract.`;
}

/** Join validated segments into a single message body. Rendered in the
 * subcontractor's own voice (no analyst hedging — this is their own offer, not
 * a brief), with any inline ref-id parentheticals stripped. The grounding guard
 * already ran on the raw text, so every fact here traces to a cited menu item. */
export function renderOutreachMessage(segments: BriefSegment[]): string {
  return segments
    .map((s) => stripRefTokens(s.text))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface OutreachDraft {
  opportunityId: string;
  accountProfileId: string;
  projectId: string;
  message: string;
  segments: BriefSegment[];
  promptVersion: string;
  generatedAt: string;
}

export interface OutreachRunResult {
  status: "succeeded" | "rejected" | "blocked" | "error";
  modelRunId: string | null;
  opportunityId: string;
  draft?: OutreachDraft;
  reason?: string;
}

export interface OutreachOptions {
  budget: BudgetConfig;
  logger?: { info(o: unknown, m?: string): void; warn(o: unknown, m?: string): void };
}

/**
 * Generate + persist one grounded GC outreach draft. A faithful twin of
 * generateBrief: every path — blocked (no key / budget), error (model threw),
 * rejected (contract violation), succeeded — writes an account-scoped
 * `model_runs` row (job_type `outreach_draft`) and NEVER throws. Only the
 * deterministic memo's already-verified menu is sent to the model, so the draft
 * cannot introduce new facts, names, or contact details. A rejected or blocked
 * run returns no draft.
 */
export async function generateOutreach(
  db: Db,
  provider: ModelProvider | null,
  opportunityId: string,
  opts: OutreachOptions,
): Promise<OutreachRunResult> {
  const memo = await buildDecisionMemo(db, opportunityId);
  if (!memo) return { status: "error", modelRunId: null, opportunityId, reason: "opportunity not found" };

  const base = {
    jobType: "outreach_draft",
    projectId: memo.projectId,
    accountProfileId: memo.accountProfileId,
    promptVersion: OUTREACH_PROMPT_VERSION,
  };

  if (!provider) {
    const reason = "no model API key configured — outreach blocked";
    const modelRunId = await persistModelRun(db, {
      ...base,
      provider: "none",
      model: "none",
      status: "blocked",
      error: reason,
    });
    opts.logger?.warn({ opportunityId, modelRunId }, reason);
    return { status: "blocked", modelRunId, opportunityId, reason };
  }

  const menu = buildBriefMenu(memo);
  const prompt = buildOutreachPrompt(memo, menu);
  const estimated = estimateOutreachCostUsd(SYSTEM_PROMPT.length + prompt.length);
  const budget = await checkBudget(db, opts.budget, estimated);
  if (!budget.allowed) {
    const reason = budget.reason ?? "budget check failed";
    const modelRunId = await persistModelRun(db, {
      ...base,
      provider: provider.name,
      model: provider.model,
      status: "blocked",
      error: reason,
    });
    opts.logger?.warn({ opportunityId, modelRunId, spentUsd: budget.spentUsd }, reason);
    return { status: "blocked", modelRunId, opportunityId, reason };
  }

  const started = Date.now();
  let response;
  try {
    response = await provider.complete({ system: SYSTEM_PROMPT, prompt, maxTokens: MAX_OUTPUT_TOKENS });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const modelRunId = await persistModelRun(db, {
      ...base,
      provider: provider.name,
      model: provider.model,
      status: "error",
      latencyMs: Date.now() - started,
      error: reason,
    });
    opts.logger?.warn({ opportunityId, modelRunId }, `outreach model call failed: ${reason}`);
    return { status: "error", modelRunId, opportunityId, reason };
  }
  const latencyMs = Date.now() - started;
  const resultHash = createHash("sha256").update(response.text).digest("hex");

  // Same grounding contract as the brief: unknown refs and un-menued
  // numbers/dates reject the whole draft.
  const validated = validateBrief(response.text, menu);
  if (!validated.ok) {
    const reason = validated.violations.map((v) => `${v.kind}: ${v.detail}`).join("; ");
    const modelRunId = await persistModelRun(db, {
      ...base,
      provider: provider.name,
      model: provider.model,
      status: "rejected",
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      costUsd: response.costUsd,
      latencyMs,
      resultHash,
      error: reason,
    });
    opts.logger?.warn({ opportunityId, modelRunId }, `outreach contract violation: ${reason}`);
    return { status: "rejected", modelRunId, opportunityId, reason };
  }

  const segments = validated.value.segments.map((s) => ({ ...s, text: stripRefTokens(s.text) }));
  const draft: OutreachDraft = {
    opportunityId,
    accountProfileId: memo.accountProfileId,
    projectId: memo.projectId,
    message: renderOutreachMessage(segments),
    segments,
    promptVersion: OUTREACH_PROMPT_VERSION,
    generatedAt: new Date().toISOString(),
  };
  const modelRunId = await persistModelRun(db, {
    ...base,
    provider: provider.name,
    model: provider.model,
    status: "succeeded",
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    costUsd: response.costUsd,
    latencyMs,
    resultHash,
    resultJson: draft as unknown,
  });
  opts.logger?.info(
    { opportunityId, modelRunId, segments: draft.segments.length, costUsd: response.costUsd },
    "outreach succeeded",
  );
  return { status: "succeeded", modelRunId, opportunityId, draft };
}

/** Latest succeeded outreach draft for an opportunity, account-scoped, or null.
 * The draft is stored as the `result_json` of its `outreach_draft` model run. */
export async function latestOutreach(
  db: Db,
  opportunityId: string,
  accountProfileId: string,
  projectId: string,
): Promise<OutreachDraft | null> {
  const res = await db.execute(sql`
    SELECT result_json FROM model_runs
    WHERE job_type = 'outreach_draft' AND status = 'succeeded'
      AND project_id = ${projectId} AND account_profile_id = ${accountProfileId}
    ORDER BY created_at DESC LIMIT 1`);
  // One opportunity per (project, account) pair, so a draft for that pair is
  // this opportunity's draft.
  const row = res.rows[0] as { result_json: OutreachDraft } | undefined;
  return row?.result_json ?? null;
}
