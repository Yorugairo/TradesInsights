import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";
import { buildDecisionMemo, type DecisionMemo } from "./memo.js";
import { checkBudget, type BudgetConfig } from "./extraction/budget.js";
import { persistModelRun } from "./extraction/runs.js";
import type { ModelProvider } from "./extraction/provider.js";
import {
  BRIEF_PROMPT_VERSION,
  validateBrief,
  type BriefMenuItem,
  type BriefSegment,
} from "./extraction/brief-contract.js";

/**
 * The verified decision *brief* — a short, plain-English narrative a busy owner
 * reads in 30 seconds, composed by a model from a fixed menu of ALREADY-VERIFIED
 * items (the deterministic decision memo). The model adds nothing: every
 * sentence cites its menu item(s), every number must appear verbatim in a cited
 * item, and any violation rejects the draft — the surface then renders the
 * deterministic memo instead. The brief is a rendering of verified rows, never
 * the system of record; the score, stage, and `bidding_confirmed` state come
 * only from stored data. Runs without model keys record a visible blocked state.
 */

const MAX_OUTPUT_TOKENS = 1200;

// Worst-case pre-flight estimate at Opus-tier pricing ($5/$25 per MTok);
// the brief prompt is smaller than extraction (a curated menu, not raw
// evidence), so this stays well under the per-job cap.
function estimateBriefCostUsd(promptChars: number): number {
  const inputTokens = promptChars / 3.5;
  return (inputTokens * 5 + MAX_OUTPUT_TOKENS * 25) / 1_000_000;
}

const SYSTEM_PROMPT = `You draft a short decision brief for a busy trade-contractor owner, from a FIXED MENU of already-verified items about ONE construction project. You compose readable prose; you never add information.

Rules (non-negotiable):
- Use ONLY the menu items. Every segment must cite the refId(s) of the menu item(s) it rests on. A segment citing a refId not in the menu invalidates your entire answer.
- Copy dollar amounts, unit counts, dates, and other numbers EXACTLY as written in the cited menu items — never round, reformat, or invent. A number not present in a cited item invalidates your answer.
- Cite the RIGHT items: state a hard fact (a number, unit count, date, role) only from an f# fact item; base a likely-fit, timing estimate, or interpretation on an i# inference item; use c_ context items for stage/score/timing/route/next-step framing. (You may tag each segment's kind, but the system derives it from the items you cite, so citing correctly is what matters.)
- Never assert bidding or procurement status unless a cited item explicitly states it. A permit is not a bid.
- Write 3 to 6 short segments in plain English — no jargon, no headings, no lists. Lead with what the project is and why it fits this contractor; then the timing/next-step. Keep the whole brief under 90 words.
- Respond with a single JSON object and nothing else (no markdown fences, no prose outside the JSON).

Output shape:
{ "segments": [ { "text": string, "kind": "fact"|"inference"|"context", "refs": [refId, ...] } ] }`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Present a verified value the way the owner should read it — the model is
 * told to copy it verbatim, so the menu form IS the surfaced form. Dates become
 * "Jul 6, 2026"; valuation-like numbers get "$" and thousands separators. Both
 * still substantiate (the guard strips $/commas before comparing). */
function humanizeFactValue(path: string, v: unknown): string {
  if (v === null || v === undefined) return "unknown";
  if (typeof v === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim());
    if (m) return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
    return v;
  }
  if (typeof v === "number" && /valuation|value|cost|usd|price/i.test(path)) {
    return `$${v.toLocaleString("en-US")}`;
  }
  return String(v);
}

function stringifyValue(v: unknown): string {
  if (v === null || v === undefined) return "unknown";
  return String(v);
}

/** Models sometimes append their citations inline as "(f0, c_why, i1)". Those
 * belong in the refs array, not the prose — strip any parenthetical made up
 * only of ref tokens (and drop a now-empty trailing space before punctuation). */
export function stripRefTokens(text: string): string {
  return text
    .replace(/\s*\((?:\s*(?:f\d+|i\d+|c_[a-z0-9]+)\s*,?)+\)/gi, "")
    .replace(/\s+([.,;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build the model's citation menu from the deterministic memo. Every item is a
 * verified row or a deterministic derivation of one — the model may only
 * re-express these. `text` doubles as the substantiation source: the numbers a
 * segment may use are exactly the numbers printed here.
 */
export function buildBriefMenu(memo: DecisionMemo): BriefMenuItem[] {
  const items: BriefMenuItem[] = [];
  const ctx = (refId: string, text: string) => items.push({ refId, kind: "context", text });

  ctx("c_summary", memo.summary);
  ctx("c_timing", memo.timingAssessment);
  ctx("c_why", `why it fits: ${memo.whyItFits}`);
  ctx("c_action", `recommended next step: ${memo.recommendedAction}`);
  ctx("c_procurement", `procurement state: ${memo.procurementState.replaceAll("_", " ")}`);
  if (memo.whatChanged && memo.whatChanged !== "No material change recorded.")
    ctx("c_changed", `what changed: ${memo.whatChanged}`);
  if (memo.route) ctx("c_route", `account route: ${memo.route.replaceAll("_", " ")}`);
  if (memo.score !== null) ctx("c_score", `opportunity score: ${memo.score}`);
  if (memo.capacityAssessment && memo.capacityAssessment !== "unknown")
    ctx(
      "c_capacity",
      `capacity fit: ${memo.capacityAssessment.replaceAll("_", " ")}${memo.capacityExplanation ? ` — ${memo.capacityExplanation}` : ""}`,
    );
  memo.talkingPoints.forEach((tp, i) => ctx(`c_tp${i}`, tp));

  memo.confirmedFacts.forEach((f, i) =>
    items.push({ refId: `f${i}`, kind: "fact", text: `${f.path} = ${humanizeFactValue(f.path, f.value)}` }),
  );
  memo.inferences.forEach((inf, i) =>
    items.push({
      refId: `i${i}`,
      kind: "inference",
      text: `${inf.type}: ${stringifyValue(inf.value)} — ${inf.reason}`,
    }),
  );
  return items;
}

export function buildBriefPrompt(memo: DecisionMemo, menu: BriefMenuItem[]): string {
  const lines = menu.map((m) => `${m.refId} [${m.kind}]: ${m.text}`).join("\n");
  const missing = memo.missingCriticalFacts.map((m) => m.key).join(", ");
  return `Contractor account route: ${memo.route ?? "general"}.
Menu items (the ONLY things you may cite):
${lines}
${missing ? `\nStill unknown (do not invent — you may mention these are unconfirmed): ${missing}` : ""}

Draft the decision brief per the contract.`;
}

/** Render validated segments into a plain narrative. Inference segments are
 * explicitly hedged so the facts-vs-inference separation survives into prose. */
export function renderBriefNarrative(segments: BriefSegment[]): string {
  const hedged = (t: string) => {
    const s = t.trim();
    if (/^(likely|probably|appears|seems|estimat|historically|typically|may|might|could)/i.test(s))
      return s;
    return `Likely ${s.charAt(0).toLowerCase()}${s.slice(1)}`;
  };
  return segments
    .map((s) => (s.kind === "inference" ? hedged(s.text) : s.text.trim()))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface DecisionBrief {
  opportunityId: string;
  accountProfileId: string;
  projectId: string;
  narrative: string;
  segments: BriefSegment[];
  promptVersion: string;
  generatedAt: string;
}

export interface BriefRunResult {
  status: "succeeded" | "rejected" | "blocked" | "error";
  modelRunId: string | null;
  opportunityId: string;
  brief?: DecisionBrief;
  reason?: string;
}

export interface BriefOptions {
  budget: BudgetConfig;
  logger?: { info(o: unknown, m?: string): void; warn(o: unknown, m?: string): void };
}

/**
 * Generate + persist one verified brief. Mirrors extractProject: every path —
 * blocked (no key / budget), error (model threw), rejected (contract
 * violation), succeeded — writes a model_runs row (job_type `brief_draft`,
 * account-scoped). A rejected or blocked run returns no brief; the caller
 * renders the deterministic memo. Only the deterministic memo's already-verified
 * items are ever sent to the model, so the brief cannot introduce new facts.
 */
export async function generateBrief(
  db: Db,
  provider: ModelProvider | null,
  opportunityId: string,
  opts: BriefOptions,
): Promise<BriefRunResult> {
  const memo = await buildDecisionMemo(db, opportunityId);
  if (!memo) return { status: "error", modelRunId: null, opportunityId, reason: "opportunity not found" };

  const base = {
    jobType: "brief_draft",
    projectId: memo.projectId,
    accountProfileId: memo.accountProfileId,
    promptVersion: BRIEF_PROMPT_VERSION,
  };

  if (!provider) {
    const reason = "no model API key configured — brief blocked";
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
  const prompt = buildBriefPrompt(memo, menu);
  const estimated = estimateBriefCostUsd(SYSTEM_PROMPT.length + prompt.length);
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
    opts.logger?.warn({ opportunityId, modelRunId }, `brief model call failed: ${reason}`);
    return { status: "error", modelRunId, opportunityId, reason };
  }
  const latencyMs = Date.now() - started;
  const resultHash = createHash("sha256").update(response.text).digest("hex");

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
    opts.logger?.warn({ opportunityId, modelRunId }, `brief contract violation: ${reason}`);
    return { status: "rejected", modelRunId, opportunityId, reason };
  }

  // Substantiation already ran on the raw text; now clean the display form
  // (strip any inline ref-id parentheticals the model appended).
  const segments = validated.value.segments.map((s) => ({ ...s, text: stripRefTokens(s.text) }));
  const brief: DecisionBrief = {
    opportunityId,
    accountProfileId: memo.accountProfileId,
    projectId: memo.projectId,
    narrative: renderBriefNarrative(segments),
    segments,
    promptVersion: BRIEF_PROMPT_VERSION,
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
    resultJson: brief as unknown,
  });
  opts.logger?.info(
    { opportunityId, modelRunId, segments: brief.segments.length, costUsd: response.costUsd },
    "brief succeeded",
  );
  return { status: "succeeded", modelRunId, opportunityId, brief };
}

/** Latest succeeded brief for an opportunity, account-scoped, or null. The
 * brief is stored as the `result_json` of its `brief_draft` model run. */
export async function latestBrief(
  db: Db,
  opportunityId: string,
  accountProfileId: string,
  projectId: string,
): Promise<DecisionBrief | null> {
  const res = await db.execute(sql`
    SELECT result_json FROM model_runs
    WHERE job_type = 'brief_draft' AND status = 'succeeded'
      AND project_id = ${projectId} AND account_profile_id = ${accountProfileId}
    ORDER BY created_at DESC LIMIT 1`);
  // One opportunity per (project, account) pair, so a brief for that pair is
  // this opportunity's brief.
  const row = res.rows[0] as { result_json: DecisionBrief } | undefined;
  return row?.result_json ?? null;
}

/**
 * Opportunities worth spending brief budget on: gate-passing, digest-band-or-
 * better, no succeeded brief yet, best score first. Callers evaluate the
 * publication gate before surfacing; this only prioritises spend.
 */
export async function listBriefCandidates(db: Db, limit: number): Promise<string[]> {
  const res = await db.execute(sql`
    SELECT o.id, o.current_score
    FROM opportunities o
    WHERE o.state IN ('priority_review', 'weekly_digest', 'promoted')
      AND NOT EXISTS (
        SELECT 1 FROM model_runs mr
        WHERE mr.project_id = o.project_id
          AND mr.account_profile_id = o.account_profile_id
          AND mr.job_type = 'brief_draft' AND mr.status = 'succeeded')
    ORDER BY o.current_score DESC NULLS LAST
    LIMIT ${limit}`);
  return (res.rows as { id: string }[]).map((r) => r.id);
}
