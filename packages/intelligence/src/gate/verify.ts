import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";
import { checkBudget, type BudgetConfig } from "../extraction/budget.js";
import type { ModelExtraction, ModelFact } from "../extraction/contract.js";
import { loadProjectEvidence } from "../extraction/extract-run.js";
import type { ModelProvider } from "../extraction/provider.js";
import { persistModelRun } from "../extraction/runs.js";
import {
  VERIFIER_PROMPT_VERSION,
  validateVerifierOutput,
  type VerifierResult,
  type VerifierVerdict,
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
- Some facts carry a "prior:" note from an earlier verification pass of this project. A prior is context only — a candidate, never a default. Your verdict must still come from THIS fact's cited evidence text alone; mark supported: false whenever that evidence does not support the value, regardless of the prior.
- Respond with a single JSON object and nothing else (no markdown fences, no prose).

Output shape:
{ "verdicts": [{ "path": string, "evidenceId": uuid, "supported": boolean, "reason": string }] }`;

/**
 * Fact propagation (flywheel Phase 2, A3) — verified priors with provenance.
 *
 * When an earlier verification run of the SAME project found this same
 * (path, value) supported — against the same evidence, or against a sibling
 * record's evidence in the cluster — the verifier prompt carries that prior
 * as labeled context. The prior is a CANDIDATE, never a default: the model
 * still returns its own verdict from the fact's cited evidence alone, so a
 * prior can be rejected (and the rejected-prior case is tested). Provenance
 * (`propagated_from` = the earlier verification model_run id) rides on the
 * stored result so downstream readers can see which verdicts had priors.
 */
export const PRIOR_MIN_CONFIDENCE = 0.9;
/** Bounded look-back: only the most recent N succeeded verifications feed priors. */
export const PRIOR_MAX_RUNS = 5;

export interface VerifiedPriorRun {
  /** model_runs id of the earlier succeeded verification. */
  modelRunId: string;
  /** Facts of the extraction that verification checked. */
  facts: ReadonlyArray<Pick<ModelFact, "path" | "value" | "evidenceId" | "confidence">>;
  verdicts: ReadonlyArray<VerifierVerdict>;
}

export interface FactPrior {
  /** The earlier verification model_run this prior propagates from. */
  propagatedFrom: string;
  /** same_evidence: identical (path, evidenceId, value) previously supported.
   * sibling_evidence: same (path, value) supported against a DIFFERENT
   * record's evidence in the same project cluster. */
  kind: "same_evidence" | "sibling_evidence";
}

const factKey = (f: { path: string; evidenceId: string }): string => `${f.path} ${f.evidenceId}`;

/**
 * Pure matcher: current facts × prior runs (most recent first) → priors.
 * A prior requires a SUPPORTED verdict on a prior fact with the same path and
 * identical JSON value, extracted at confidence ≥ PRIOR_MIN_CONFIDENCE. The
 * most recent qualifying run wins; same-evidence beats sibling-evidence
 * within a run. Nothing is ever guessed: value equality is exact.
 */
export function matchVerifiedPriors(
  facts: ReadonlyArray<Pick<ModelFact, "path" | "value" | "evidenceId">>,
  priorRuns: ReadonlyArray<VerifiedPriorRun>,
): Map<string, FactPrior> {
  const priors = new Map<string, FactPrior>();
  for (const fact of facts) {
    const valueJson = JSON.stringify(fact.value);
    for (const run of priorRuns) {
      const supported = new Set(run.verdicts.filter((v) => v.supported).map(factKey));
      let hit: FactPrior | null = null;
      for (const pf of run.facts) {
        if (pf.path !== fact.path) continue;
        if (pf.confidence < PRIOR_MIN_CONFIDENCE) continue;
        if (JSON.stringify(pf.value) !== valueJson) continue;
        if (!supported.has(factKey(pf))) continue;
        if (pf.evidenceId === fact.evidenceId) {
          hit = { propagatedFrom: run.modelRunId, kind: "same_evidence" };
          break; // same-evidence is the strongest form — stop scanning this run
        }
        hit = hit ?? { propagatedFrom: run.modelRunId, kind: "sibling_evidence" };
      }
      if (hit) {
        priors.set(factKey(fact), hit);
        break; // most recent qualifying run wins
      }
    }
  }
  return priors;
}

/**
 * Load the most recent succeeded verification runs for a project, each paired
 * with the extraction it verified (the latest succeeded extraction at or
 * before the verification's created_at). Rows that fail to pair are skipped.
 */
export async function loadVerifiedPriorRuns(db: Db, projectId: string): Promise<VerifiedPriorRun[]> {
  const res = await db.execute(sql`
    SELECT v.id, v.result_json AS verdicts_json, e.result_json AS extraction_json
    FROM model_runs v
    JOIN LATERAL (
      SELECT result_json FROM model_runs e
      WHERE e.project_id = v.project_id AND e.job_type = 'extraction'
        AND e.status = 'succeeded' AND e.created_at <= v.created_at
      ORDER BY e.created_at DESC LIMIT 1
    ) e ON TRUE
    WHERE v.project_id = ${projectId} AND v.job_type = 'verification' AND v.status = 'succeeded'
    ORDER BY v.created_at DESC
    LIMIT ${PRIOR_MAX_RUNS}`);
  const runs: VerifiedPriorRun[] = [];
  for (const r of res.rows as Record<string, unknown>[]) {
    const verdicts = (r["verdicts_json"] as { verdicts?: VerifierVerdict[] } | null)?.verdicts;
    const facts = (r["extraction_json"] as { facts?: ModelFact[] } | null)?.facts;
    if (!Array.isArray(verdicts) || !Array.isArray(facts)) continue;
    runs.push({ modelRunId: r["id"] as string, facts, verdicts });
  }
  return runs;
}

export function buildVerifierPrompt(
  extraction: ModelExtraction,
  evidenceById: ReadonlyMap<string, { evidenceText: string; sourceUrl: string }>,
  priors?: ReadonlyMap<string, FactPrior>,
): string {
  const blocks = extraction.facts
    .map((f) => {
      const ev = evidenceById.get(f.evidenceId);
      const prior = priors?.get(factKey(f));
      const priorLine = prior
        ? `\n  prior: an earlier independent verification (run ${prior.propagatedFrom}) found this same value supported against ${
            prior.kind === "same_evidence" ? "this same evidence" : "a sibling record's evidence"
          }. Candidate only — judge THIS fact's cited evidence yourself.`
        : "";
      return `fact:
  path: ${f.path}
  claimed value: ${JSON.stringify(f.value)}
  evidenceId: ${f.evidenceId}${priorLine}
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
  // Fact propagation (A3): priors from earlier verifications of this project's
  // cluster, injected as labeled context. Never skips verification.
  const priorRuns = await loadVerifiedPriorRuns(db, projectId);
  const priors = matchVerifiedPriors(latest.extraction.facts, priorRuns);
  const prompt = buildVerifierPrompt(latest.extraction, evidenceById, priors);
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
  // Provenance rides beside the verdicts: which facts carried a prior, and
  // from which earlier run. Verdicts themselves are the model's alone.
  const priorProvenance = [...priors.entries()].map(([key, p]) => {
    const sep = key.lastIndexOf(" ");
    return {
      path: key.slice(0, sep),
      evidenceId: key.slice(sep + 1),
      propagated_from: p.propagatedFrom,
      kind: p.kind,
    };
  });
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
    resultJson:
      priorProvenance.length > 0
        ? { ...validated.value, priors: priorProvenance }
        : validated.value,
  });
  opts.logger?.info(
    {
      projectId,
      modelRunId,
      verdicts: validated.value.verdicts.length,
      priors: priorProvenance.length,
      allSupported,
    },
    "verification complete",
  );
  return { status: "succeeded", modelRunId, projectId, result: validated.value, allSupported };
}
