import { z } from "zod";
import { routeProject, type AccountScoringInput, type ProjectFeatures } from "../scoring.js";

/**
 * M4.1/M4.2 — labeled evaluation harness for the routing/scoring layer.
 * Examples freeze the exact ProjectFeatures the scorer saw at labeling time
 * plus the labeling date (`frozenAt`, used as the scoring clock), so every
 * eval run is a deterministic code-graded replay: same set + same rules →
 * same metrics, forever. Labels are versioned artifacts (fixtures/eval/) —
 * customer calibration revises labels via a new file version, never by
 * silently editing history.
 */

export const EVAL_ACCOUNTS = [
  "lacey_glass_at_home",
  "lacey_glass_commercial",
  "solis_interiors",
] as const;

const featuresSchema = z.object({
  projectId: z.string(),
  county: z.string(),
  permittingJurisdiction: z.string(),
  city: z.string().nullable(),
  stage: z.string(),
  text: z.string(),
  maxUnits: z.number().nullable(),
  maxValuation: z.number().nullable(),
  clusterSize: z.number(),
  hasVelocitySignal: z.boolean(),
  orgs: z.array(z.object({ name: z.string(), role: z.string().nullable() })),
  aGradeEvidence: z.number(),
  lastMaterialChangeAt: z.string().nullable(),
});

export const evalExampleSchema = z.object({
  id: z.string().min(1),
  account: z.enum(EVAL_ACCOUNTS),
  projectId: z.string().uuid(),
  projectName: z.string(),
  label: z.enum(["positive", "hard_negative"]),
  split: z.enum(["dev", "holdout"]),
  /** Short bucket for stratified reporting (e.g. sfr_new, wrong_trade_site_work). */
  category: z.string().min(1),
  rationale: z.string().min(1),
  evidenceRefs: z.array(z.string()).min(1),
  /** Labeling date — injected as the scoring clock for reproducibility. */
  frozenAt: z.string(),
  features: featuresSchema,
});

export type EvalExample = z.infer<typeof evalExampleSchema>;

export function parseEvalSet(jsonl: string): EvalExample[] {
  const examples = jsonl
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line, i) => {
      try {
        return evalExampleSchema.parse(JSON.parse(line));
      } catch (err) {
        throw new Error(`eval set line ${i + 1}: ${err instanceof Error ? err.message : err}`);
      }
    });
  const ids = new Set<string>();
  for (const e of examples) {
    if (ids.has(e.id)) throw new Error(`duplicate eval example id ${e.id}`);
    ids.add(e.id);
  }
  return examples;
}

export interface AccountEvalMetrics {
  examples: number;
  positives: number;
  hardNegatives: number;
  /** System put example in priority_review. */
  priorityFlagged: number;
  priorityTruePositives: number;
  /** ≥90% gate (spec §19/§21 M4). Null when nothing was priority-flagged. */
  priorityPrecision: number | null;
  /** Positives reaching weekly_digest or better. ≥80% gate (spec §19). */
  positivesRecalled: number;
  recall: number | null;
  /** Hard negatives leaking into priority — each one is a precision hit. */
  hardNegativesInPriority: string[];
  /** Positives the system missed entirely (archive or unrouted). */
  positivesMissed: string[];
}

export interface EvalRunResult {
  split: "dev" | "holdout" | "all";
  perAccount: Record<string, AccountEvalMetrics>;
  overall: AccountEvalMetrics;
  gates: {
    priorityPrecisionMin: number;
    recallMin: number;
    priorityPrecisionPass: boolean;
    recallPass: boolean;
  };
}

export const PRIORITY_PRECISION_MIN = 0.9;
export const RECALL_MIN = 0.8;

function emptyMetrics(): AccountEvalMetrics {
  return {
    examples: 0,
    positives: 0,
    hardNegatives: 0,
    priorityFlagged: 0,
    priorityTruePositives: 0,
    priorityPrecision: null,
    positivesRecalled: 0,
    recall: null,
    hardNegativesInPriority: [],
    positivesMissed: [],
  };
}

function finalize(m: AccountEvalMetrics): void {
  m.priorityPrecision = m.priorityFlagged === 0 ? null : m.priorityTruePositives / m.priorityFlagged;
  m.recall = m.positives === 0 ? null : m.positivesRecalled / m.positives;
}

/**
 * Replay every example through the pure router with its frozen features and
 * clock. `accounts` carries the CURRENT rule versions — that is the point:
 * rule iteration is measured against fixed labels.
 */
export function runEval(
  examples: EvalExample[],
  accounts: AccountScoringInput[],
  opts: { split?: "dev" | "holdout" | "all" } = {},
): EvalRunResult {
  const split = opts.split ?? "all";
  const selected = examples.filter((e) => split === "all" || e.split === split);
  const byKey = new Map(accounts.map((a) => [a.key, a]));

  const perAccount: Record<string, AccountEvalMetrics> = {};
  const overall = emptyMetrics();

  for (const e of selected) {
    const account = byKey.get(e.account);
    if (!account) throw new Error(`eval example ${e.id}: account ${e.account} not loaded`);
    const features: ProjectFeatures = {
      ...e.features,
      lastMaterialChangeAt: e.features.lastMaterialChangeAt
        ? new Date(e.features.lastMaterialChangeAt)
        : null,
    };
    const [route] = routeProject(features, [account], new Date(e.frozenAt));
    const state = route?.state ?? "unrouted";

    const m = (perAccount[e.account] ??= emptyMetrics());
    for (const bucket of [m, overall]) {
      bucket.examples++;
      if (e.label === "positive") bucket.positives++;
      else bucket.hardNegatives++;

      if (state === "priority_review") {
        bucket.priorityFlagged++;
        if (e.label === "positive") bucket.priorityTruePositives++;
        else bucket.hardNegativesInPriority.push(e.id);
      }
      if (e.label === "positive") {
        if (state === "priority_review" || state === "weekly_digest") bucket.positivesRecalled++;
        else bucket.positivesMissed.push(e.id);
      }
    }
  }

  for (const m of Object.values(perAccount)) finalize(m);
  finalize(overall);

  return {
    split,
    perAccount,
    overall,
    gates: {
      priorityPrecisionMin: PRIORITY_PRECISION_MIN,
      recallMin: RECALL_MIN,
      priorityPrecisionPass:
        overall.priorityPrecision !== null && overall.priorityPrecision >= PRIORITY_PRECISION_MIN,
      recallPass: overall.recall !== null && overall.recall >= RECALL_MIN,
    },
  };
}
