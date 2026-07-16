import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";
import { checkBudget, type BudgetConfig } from "../extraction/budget.js";
import type { ModelExtraction } from "../extraction/contract.js";
import { loadProjectEvidence } from "../extraction/extract-run.js";
import type { ModelProvider } from "../extraction/provider.js";
import { persistModelRun } from "../extraction/runs.js";
import {
  VERIFIER_PROMPT_VERSION,
  validateVerifierOutput,
  type VerifierResult,
} from "./verifier-contract.js";

/**
 * Independent verification pass (spec §15 "Independent verifier passes",
 * §11 reject rules). Re-checks the latest succeeded extraction fact-by-fact
 * against the exact evidence each fact cites. Independence is structural:
 * a fresh model call that sees only facts + cited evidence text — not the
 * extraction run's reasoning — and may only return verdicts, never new
 * claims. Same budget ledger, same model_runs audit trail (job_type
 * 'verification').
 */

const MAX_OUTPUT_TOKENS = 2048;

function estimateJobCostUsd(promptChars: number, maxOutputTokens: number): number {
  const inputTokens = promptChars / 3.5;
  return (inputTokens * 5 + maxOutputTokens * 25) / 1_000_000;
}

const SYSTEM_PROMPT = `You are an independent verifier for construction-project facts extracted from official public-source evidence.

You are given extracted facts and, for each, the exact evidence text it cites. For EVERY fact, decide whether the cited evidence explicitly supports the claimed value.

Rules (non-negotiable):
- Judge each fact ONLY against its own cited evidence text. No outside knowledge, no cross-filling from other evidence.
- "supported" means the evidence states the value explicitly. Paraphrase is acceptable; interpretation, arithmetic, or inference is NOT support for a fact.
- Be strict about: exact scope, bid/procurement state, organization roles, dollar values, unit/lot counts, deadlines, and contacts. When the evidence is vague or only implies the value, mark supported: false.
- A permit is not a bid: any bidding/procurement claim requires an explicit solicitation or invitation in the cited evidence.
- Return exactly one verdict per fact, keyed by the fact's path and evidenceId. Never add verdicts for facts you were not given.
- Respond with a single JSON object and nothing else (no markdown fences, no prose).

Output shape:
{ "verdicts": [{ "path": string, "evidenceId": uuid, "supported": boolean, "reason": string }] }`;

export function buildVerifierPrompt(
  extraction: ModelExtraction,
  evidenceById: ReadonlyMap<string, { evidenceText: string; sourceUrl: string }>,
): string {
  const blocks = extraction.facts
    .map((f) => {
      const ev = evidenceById.get(f.evidenceId);
      return `fact:
  path: ${f.path}
  claimed value: ${JSON.stringify(f.value)}
  evidenceId: ${f.evidenceId}
cited evidence text:
${ev ? ev.evidenceText : "(evidence text unavailable)"}`;
    })
    .join("\n---\n");
  return `Facts to verify, each with its cited evidence:
---
${blocks}
---

Return one verdict per fact.`;
}

export interface VerificationRunResult {
  status: "succeeded" | "rejected" | "blocked" | "error";
  modelRunId: string | null;
  projectId: string;
  /** Present only on success. */
  result?: VerifierResult;
  /** True when every fact's verdict is supported. */
  allSupported?: boolean;
  reason?: string;
}

export interface VerifyOptions {
  budget: BudgetConfig;
  logger?: { info(o: unknown, m?: string): void; warn(o: unknown, m?: string): void };
}

/** The latest succeeded extraction for a project, or null. */
export async function latestExtraction(
  db: Db,
  projectId: string,
): Promise<{ modelRunId: string; extraction: ModelExtraction } | null> {
  const res = await db.execute(sql`
    SELECT id, result_json FROM model_runs
    WHERE project_id = ${projectId} AND job_type = 'extraction' AND status = 'succeeded'
    ORDER BY created_at DESC LIMIT 1`);
  const row = res.rows[0] as { id: string; result_json: ModelExtraction } | undefined;
  if (!row) return null;
  return { modelRunId: row.id, extraction: row.result_json };
}

/** The latest verification run outcome for a project, or null. */
export async function latestVerification(
  db: Db,
  projectId: string,
): Promise<{ status: string; result: VerifierResult | null; createdAt: Date } | null> {
  const res = await db.execute(sql`
    SELECT status, result_json, created_at FROM model_runs
    WHERE project_id = ${projectId} AND job_type = 'verification'
    ORDER BY created_at DESC LIMIT 1`);
  const row = res.rows[0] as
    | { status: string; result_json: VerifierResult | null; created_at: string }
    | undefined;
  if (!row) return null;
  return { status: row.status, result: row.result_json, createdAt: new Date(row.created_at) };
}

/**
 * Verify a project's latest succeeded extraction. `provider === null` records
 * a visible blocked run (no key), mirroring the extraction pipeline.
 */
export async function verifyProject(
  db: Db,
  provider: ModelProvider | null,
  projectId: string,
  opts: VerifyOptions,
): Promise<VerificationRunResult> {
  const latest = await latestExtraction(db, projectId);
  if (!latest) {
    return {
      status: "error",
      modelRunId: null,
      projectId,
      reason: "no succeeded extraction to verify",
    };
  }
  if (latest.extraction.facts.length === 0) {
    // Nothing to verify — vacuously supported, recorded for auditability.
    const modelRunId = await persistModelRun(db, {
      jobType: "verification",
      projectId,
      provider: provider?.name ?? "none",
      model: provider?.model ?? "none",
      promptVersion: VERIFIER_PROMPT_VERSION,
      status: "succeeded",
      resultJson: { verdicts: [] },
      resultHash: createHash("sha256").update("{}").digest("hex"),
    });
    return { status: "succeeded", modelRunId, projectId, result: { verdicts: [] }, allSupported: true };
  }

  if (!provider) {
    const reason = "no model API key configured — verification blocked";
    const modelRunId = await persistModelRun(db, {
      jobType: "verification",
      projectId,
      provider: "none",
      model: "none",
      promptVersion: VERIFIER_PROMPT_VERSION,
      status: "blocked",
      error: reason,
    });
    opts.logger?.warn({ projectId, modelRunId }, reason);
    return { status: "blocked", modelRunId, projectId, reason };
  }

  const loaded = await loadProjectEvidence(db, projectId);
  const evidenceById = new Map(
    (loaded?.evidence ?? []).map((e) => [
      e.id,
      { evidenceText: e.evidenceText, sourceUrl: e.sourceUrl },
    ]),
  );
  const prompt = buildVerifierPrompt(latest.extraction, evidenceById);
  const estimated = estimateJobCostUsd(SYSTEM_PROMPT.length + prompt.length, MAX_OUTPUT_TOKENS);
  const budget = await checkBudget(db, opts.budget, estimated);
  if (!budget.allowed) {
    const reason = budget.reason ?? "budget check failed";
    const modelRunId = await persistModelRun(db, {
      jobType: "verification",
      projectId,
      provider: provider.name,
      model: provider.model,
      promptVersion: VERIFIER_PROMPT_VERSION,
      status: "blocked",
      error: reason,
    });
    opts.logger?.warn({ projectId, modelRunId, spentUsd: budget.spentUsd }, reason);
    return { status: "blocked", modelRunId, projectId, reason };
  }

  const started = Date.now();
  let response;
  try {
    response = await provider.complete({
      system: SYSTEM_PROMPT,
      prompt,
      maxTokens: MAX_OUTPUT_TOKENS,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const modelRunId = await persistModelRun(db, {
      jobType: "verification",
      projectId,
      provider: provider.name,
      model: provider.model,
      promptVersion: VERIFIER_PROMPT_VERSION,
      status: "error",
      latencyMs: Date.now() - started,
      error: reason,
    });
    return { status: "error", modelRunId, projectId, reason };
  }
  const latencyMs = Date.now() - started;
  const resultHash = createHash("sha256").update(response.text).digest("hex");

  const validated = validateVerifierOutput(response.text, latest.extraction.facts);
  if (!validated.ok) {
    const reason = validated.violations.map((v) => `${v.kind}: ${v.detail}`).join("; ");
    const modelRunId = await persistModelRun(db, {
      jobType: "verification",
      projectId,
      provider: provider.name,
      model: provider.model,
      promptVersion: VERIFIER_PROMPT_VERSION,
      status: "rejected",
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      costUsd: response.costUsd,
      latencyMs,
      resultHash,
      error: reason,
    });
    opts.logger?.warn({ projectId, modelRunId }, `verifier contract violation: ${reason}`);
    return { status: "rejected", modelRunId, projectId, reason };
  }

  const allSupported = validated.value.verdicts.every((v) => v.supported);
  const modelRunId = await persistModelRun(db, {
    jobType: "verification",
    projectId,
    provider: provider.name,
    model: provider.model,
    promptVersion: VERIFIER_PROMPT_VERSION,
    status: "succeeded",
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    costUsd: response.costUsd,
    latencyMs,
    resultHash,
    resultJson: validated.value,
  });
  opts.logger?.info(
    { projectId, modelRunId, verdicts: validated.value.verdicts.length, allSupported },
    "verification complete",
  );
  return { status: "succeeded", modelRunId, projectId, result: validated.value, allSupported };
}
