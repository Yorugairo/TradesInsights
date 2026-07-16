import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";
import { checkBudget, type BudgetConfig } from "./budget.js";
import {
  EXTRACTION_PROMPT_VERSION,
  validateExtraction,
  type ModelExtraction,
} from "./contract.js";
import type { ModelProvider } from "./provider.js";
import { persistModelRun, type ModelRunRow } from "./runs.js";

/**
 * Model extraction over a project's stored evidence (spec §13). Deterministic
 * parsing already happened — the model only interprets captured evidence:
 * it maps facts to the evidence IDs it was shown, labels inferences
 * separately, and lists missing critical facts. Output is Zod-validated,
 * unknown evidence IDs reject the run, and every attempt (including blocked
 * and rejected ones) is persisted to model_runs so spend and failures are
 * visible.
 */

const MAX_EVIDENCE_ITEMS = 40;
const MAX_EVIDENCE_CHARS = 1500;
const MAX_OUTPUT_TOKENS = 4096;

// Worst-case pre-flight estimate at Opus-tier pricing ($5/$25 per MTok);
// intentionally conservative (~3.5 chars/token, full output budget).
function estimateJobCostUsd(promptChars: number, maxOutputTokens: number): number {
  const inputTokens = promptChars / 3.5;
  return (inputTokens * 5 + maxOutputTokens * 25) / 1_000_000;
}

export interface EvidenceForPrompt {
  id: string;
  factPath: string;
  evidenceText: string;
  pageOrSection: string | null;
  sourceUrl: string;
  authorityGrade: string;
}

export interface ProjectForPrompt {
  id: string;
  canonicalName: string;
  county: string;
  permittingJurisdiction: string;
  currentStage: string;
}

export async function loadProjectEvidence(
  db: Db,
  projectId: string,
): Promise<{ project: ProjectForPrompt; evidence: EvidenceForPrompt[] } | null> {
  const proj = await db.execute(sql`
    SELECT id, canonical_name, county, permitting_jurisdiction, current_stage
    FROM projects WHERE id = ${projectId}`);
  const p = proj.rows[0] as Record<string, string> | undefined;
  if (!p) return null;

  const ev = await db.execute(sql`
    SELECT DISTINCT ON (ei.id)
      ei.id, ei.fact_path, ei.evidence_text, ei.page_or_section,
      ei.source_url, ei.authority_grade
    FROM record_resolutions rr
    JOIN evidence_items ei ON ei.source_record_id = rr.source_record_id
    WHERE rr.project_id = ${projectId} AND rr.status = 'active'
    ORDER BY ei.id
    LIMIT ${MAX_EVIDENCE_ITEMS}`);

  return {
    project: {
      id: p["id"]!,
      canonicalName: p["canonical_name"]!,
      county: p["county"]!,
      permittingJurisdiction: p["permitting_jurisdiction"]!,
      currentStage: p["current_stage"]!,
    },
    evidence: (ev.rows as Record<string, string | null>[]).map((r) => ({
      id: r["id"] as string,
      factPath: r["fact_path"] as string,
      evidenceText: (r["evidence_text"] as string).slice(0, MAX_EVIDENCE_CHARS),
      pageOrSection: r["page_or_section"] ?? null,
      sourceUrl: r["source_url"] as string,
      authorityGrade: r["authority_grade"] as string,
    })),
  };
}

const SYSTEM_PROMPT = `You extract construction-project facts from official public-source evidence for a trade-contractor intelligence system.

Rules (non-negotiable):
- Use ONLY the evidence blocks provided. Never use outside knowledge.
- Every fact must cite exactly one evidenceId from the provided blocks; every inference must cite one or more provided evidenceIds. Citing any other ID invalidates your entire answer.
- A fact is something the cited evidence states explicitly (confirmed: true). Anything interpreted, combined, or estimated is an inference, never a fact.
- A permit is not a bid: never claim bidding/procurement status unless an evidence block explicitly states a solicitation or invitation.
- Unknown values are omitted or listed in missingCriticalFacts — never guessed, never zero.
- Respond with a single JSON object and nothing else (no markdown fences, no prose).

Output shape:
{
  "facts": [{ "path": string, "value": string|number|boolean|null, "evidenceId": uuid, "confirmed": true, "confidence": 0..1 }],
  "inferences": [{ "type": string, "value": string|number|boolean|null, "evidenceIds": [uuid], "confidence": 0..1, "reason": string }],
  "missingCriticalFacts": [string]
}

Fact paths to look for when evidenced: project.units, project.valuationUsd, project.address, project.parcel, project.stage, project.description, roles.general_contractor, roles.developer, roles.architect, roles.applicant, dates.bid_date, dates.permit_issued.
Critical facts worth flagging when absent: general_contractor, procurement_status, bid_date, project_valuation, unit_count.`;

export function buildExtractionPrompt(
  project: ProjectForPrompt,
  evidence: EvidenceForPrompt[],
): string {
  const blocks = evidence
    .map(
      (e) =>
        `evidenceId: ${e.id}\nfactPath: ${e.factPath}\nauthorityGrade: ${e.authorityGrade}\nsource: ${e.sourceUrl}${e.pageOrSection ? `\nsection: ${e.pageOrSection}` : ""}\ntext: ${e.evidenceText}`,
    )
    .join("\n---\n");
  return `Project under review:
- name: ${project.canonicalName}
- county: ${project.county}
- permitting jurisdiction: ${project.permittingJurisdiction}
- current stage: ${project.currentStage}

Evidence blocks (the ONLY permitted citations):
---
${blocks}
---

Extract facts, inferences, and missingCriticalFacts per the contract.`;
}

export interface ExtractionRunResult {
  status: "succeeded" | "rejected" | "blocked" | "error";
  modelRunId: string | null;
  projectId: string;
  extraction?: ModelExtraction;
  reason?: string;
}

async function persistRun(db: Db, row: Omit<ModelRunRow, "promptVersion">): Promise<string> {
  return persistModelRun(db, { ...row, promptVersion: EXTRACTION_PROMPT_VERSION });
}

export interface ExtractOptions {
  budget: BudgetConfig;
  jobType?: string;
  logger?: { info(o: unknown, m?: string): void; warn(o: unknown, m?: string): void };
}

/**
 * Run one extraction job. `provider === null` means no model key is
 * configured — the job is recorded as blocked (visible state, spec §3), never
 * silently skipped and never a crash.
 */
export async function extractProject(
  db: Db,
  provider: ModelProvider | null,
  projectId: string,
  opts: ExtractOptions,
): Promise<ExtractionRunResult> {
  const jobType = opts.jobType ?? "extraction";

  const loaded = await loadProjectEvidence(db, projectId);
  if (!loaded) {
    return { status: "error", modelRunId: null, projectId, reason: "project not found" };
  }
  if (loaded.evidence.length === 0) {
    return {
      status: "error",
      modelRunId: null,
      projectId,
      reason: "project has no evidence items — nothing for a model to interpret",
    };
  }

  if (!provider) {
    const reason = "no model API key configured — extraction blocked";
    const modelRunId = await persistRun(db, {
      jobType,
      projectId,
      provider: "none",
      model: "none",
      status: "blocked",
      error: reason,
    });
    opts.logger?.warn({ projectId, modelRunId }, reason);
    return { status: "blocked", modelRunId, projectId, reason };
  }

  const prompt = buildExtractionPrompt(loaded.project, loaded.evidence);
  const estimated = estimateJobCostUsd(SYSTEM_PROMPT.length + prompt.length, MAX_OUTPUT_TOKENS);
  const budget = await checkBudget(db, opts.budget, estimated);
  if (!budget.allowed) {
    const reason = budget.reason ?? "budget check failed";
    const modelRunId = await persistRun(db, {
      jobType,
      projectId,
      provider: provider.name,
      model: provider.model,
      status: "blocked",
      error: reason,
    });
    opts.logger?.warn({ projectId, modelRunId, spentUsd: budget.spentUsd }, reason);
    return { status: "blocked", modelRunId, projectId, reason };
  }

  const knownIds = new Set(loaded.evidence.map((e) => e.id));
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
    const modelRunId = await persistRun(db, {
      jobType,
      projectId,
      provider: provider.name,
      model: provider.model,
      status: "error",
      latencyMs: Date.now() - started,
      error: reason,
    });
    opts.logger?.warn({ projectId, modelRunId }, `model call failed: ${reason}`);
    return { status: "error", modelRunId, projectId, reason };
  }
  const latencyMs = Date.now() - started;
  const resultHash = createHash("sha256").update(response.text).digest("hex");

  const validated = validateExtraction(response.text, knownIds);
  if (!validated.ok) {
    // Spend happened — record it either way; the payload is rejected, so
    // result_json stays null and nothing downstream may consume it.
    const reason = validated.violations.map((v) => `${v.kind}: ${v.detail}`).join("; ");
    const modelRunId = await persistRun(db, {
      jobType,
      projectId,
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
    opts.logger?.warn({ projectId, modelRunId }, `contract violation: ${reason}`);
    return { status: "rejected", modelRunId, projectId, reason };
  }

  const modelRunId = await persistRun(db, {
    jobType,
    projectId,
    provider: provider.name,
    model: provider.model,
    status: "succeeded",
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    costUsd: response.costUsd,
    latencyMs,
    resultHash,
    resultJson: validated.value,
  });
  opts.logger?.info(
    {
      projectId,
      modelRunId,
      facts: validated.value.facts.length,
      inferences: validated.value.inferences.length,
      costUsd: response.costUsd,
    },
    "extraction succeeded",
  );
  return { status: "succeeded", modelRunId, projectId, extraction: validated.value };
}

/**
 * Projects worth spending model budget on: they carry a digest-band-or-better
 * opportunity and have no succeeded extraction yet. Ordered by best current
 * score so the budget goes to the highest-value projects first.
 */
export async function listExtractionCandidates(db: Db, limit: number): Promise<string[]> {
  const res = await db.execute(sql`
    SELECT o.project_id, max(o.current_score) AS best
    FROM opportunities o
    WHERE o.state IN ('priority_review', 'weekly_digest', 'promoted')
      AND NOT EXISTS (
        SELECT 1 FROM model_runs mr
        WHERE mr.project_id = o.project_id
          AND mr.job_type = 'extraction' AND mr.status = 'succeeded')
    GROUP BY o.project_id
    ORDER BY best DESC
    LIMIT ${limit}`);
  return (res.rows as { project_id: string }[]).map((r) => r.project_id);
}
