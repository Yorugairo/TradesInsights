import { z } from "zod";

/**
 * Spec §13 AI contract — the only shape a model may return. Facts and
 * inferences are separated; every claim must reference evidence the caller
 * already holds (unknown evidence IDs are rejected outright). Model output is
 * never the system of record: validated payloads are stored on the model_runs
 * row for the verifier/UI and never overwrite deterministically parsed facts.
 */

/** Bump when the extraction prompt or contract semantics change. */
export const EXTRACTION_PROMPT_VERSION = "1.0.0";

const jsonValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const modelFactSchema = z.object({
  /** Dotted path into the normalized project shape, e.g. "project.units". */
  path: z.string().min(1),
  value: jsonValue,
  evidenceId: z.string().uuid(),
  confirmed: z.boolean(),
  confidence: z.number().min(0).max(1),
});

export const modelInferenceSchema = z.object({
  type: z.string().min(1),
  value: jsonValue,
  evidenceIds: z.array(z.string().uuid()).min(1),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
});

export const modelExtractionSchema = z.object({
  facts: z.array(modelFactSchema),
  inferences: z.array(modelInferenceSchema),
  missingCriticalFacts: z.array(z.string()),
});

export type ModelFact = z.infer<typeof modelFactSchema>;
export type ModelInference = z.infer<typeof modelInferenceSchema>;
export type ModelExtraction = z.infer<typeof modelExtractionSchema>;

export interface ContractViolation {
  kind: "invalid_json" | "schema" | "unknown_evidence_id";
  detail: string;
}

export type ValidationResult =
  | { ok: true; value: ModelExtraction }
  | { ok: false; violations: ContractViolation[] };

/** Models sometimes wrap JSON in a markdown fence despite instructions. */
function stripFence(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fence?.[1] ?? trimmed;
}

/**
 * Validate raw model output against the §13 contract. Every evidenceId must
 * be one the caller supplied in the prompt — anything else is a fabricated
 * citation and rejects the whole payload (spec: "Reject unknown evidence
 * IDs"), because a partially fabricated answer is not trustworthy evidence
 * mapping.
 */
export function validateExtraction(
  rawText: string,
  knownEvidenceIds: ReadonlySet<string>,
): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(rawText));
  } catch (err) {
    return {
      ok: false,
      violations: [
        { kind: "invalid_json", detail: err instanceof Error ? err.message : String(err) },
      ],
    };
  }

  const result = modelExtractionSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      violations: result.error.issues.map((i) => ({
        kind: "schema" as const,
        detail: `${i.path.join(".")}: ${i.message}`,
      })),
    };
  }

  const violations: ContractViolation[] = [];
  for (const fact of result.data.facts) {
    if (!knownEvidenceIds.has(fact.evidenceId)) {
      violations.push({
        kind: "unknown_evidence_id",
        detail: `fact ${fact.path} cites unknown evidence ${fact.evidenceId}`,
      });
    }
  }
  for (const inf of result.data.inferences) {
    for (const id of inf.evidenceIds) {
      if (!knownEvidenceIds.has(id)) {
        violations.push({
          kind: "unknown_evidence_id",
          detail: `inference ${inf.type} cites unknown evidence ${id}`,
        });
      }
    }
  }
  if (violations.length > 0) return { ok: false, violations };
  return { ok: true, value: result.data };
}
