import { describe, expect, it } from "vitest";
import {
  PRIOR_MIN_CONFIDENCE,
  buildVerifierPrompt,
  matchVerifiedPriors,
  type VerifiedPriorRun,
} from "./verify.js";
import { validateVerifierOutput } from "./verifier-contract.js";

/**
 * Fact propagation (flywheel Phase 2, A3). Priors are CANDIDATES with
 * provenance, never defaults: matching is exact (path + identical JSON value,
 * supported verdict, extraction confidence ≥ 0.9), the prompt labels them as
 * context, and a model rejection of a prior-carrying fact stands untouched.
 */

const EV_A = "11111111-1111-4111-8111-111111111111";
const EV_B = "22222222-2222-4222-8222-222222222222";
const RUN_OLD = "run-old";
const RUN_NEW = "run-new";

function priorRun(over: Partial<VerifiedPriorRun> = {}): VerifiedPriorRun {
  return {
    modelRunId: RUN_NEW,
    facts: [{ path: "project.units", value: 60, evidenceId: EV_A, confidence: 0.95 }],
    verdicts: [{ path: "project.units", evidenceId: EV_A, supported: true, reason: "stated" }],
    ...over,
  };
}

describe("matchVerifiedPriors", () => {
  const currentFact = { path: "project.units", value: 60, evidenceId: EV_A };

  it("matches a same-evidence prior (identical path, evidenceId, value)", () => {
    const priors = matchVerifiedPriors([currentFact], [priorRun()]);
    expect(priors.get(`project.units ${EV_A}`)).toEqual({
      propagatedFrom: RUN_NEW,
      kind: "same_evidence",
    });
  });

  it("matches a sibling-evidence prior when the value was verified against a different record", () => {
    const current = { path: "project.units", value: 60, evidenceId: EV_B };
    const priors = matchVerifiedPriors([current], [priorRun()]);
    expect(priors.get(`project.units ${EV_B}`)).toEqual({
      propagatedFrom: RUN_NEW,
      kind: "sibling_evidence",
    });
  });

  it("ignores priors below the confidence floor", () => {
    const run = priorRun({
      facts: [
        {
          path: "project.units",
          value: 60,
          evidenceId: EV_A,
          confidence: PRIOR_MIN_CONFIDENCE - 0.01,
        },
      ],
    });
    expect(matchVerifiedPriors([currentFact], [run]).size).toBe(0);
  });

  it("ignores unsupported prior verdicts and mismatched values", () => {
    const unsupported = priorRun({
      verdicts: [
        { path: "project.units", evidenceId: EV_A, supported: false, reason: "not stated" },
      ],
    });
    expect(matchVerifiedPriors([currentFact], [unsupported]).size).toBe(0);
    const differentValue = { path: "project.units", value: 61, evidenceId: EV_A };
    expect(matchVerifiedPriors([differentValue], [priorRun()]).size).toBe(0);
  });

  it("the most recent qualifying run wins (runs are ordered most-recent first)", () => {
    const older = priorRun({ modelRunId: RUN_OLD });
    const priors = matchVerifiedPriors([currentFact], [priorRun(), older]);
    expect(priors.get(`project.units ${EV_A}`)?.propagatedFrom).toBe(RUN_NEW);
  });
});

describe("buildVerifierPrompt prior annotation", () => {
  const extraction = {
    facts: [
      { path: "project.units", value: 60, evidenceId: EV_A, confirmed: true, confidence: 0.95 },
      { path: "project.valuationUsd", value: 500000, evidenceId: EV_B, confirmed: true, confidence: 0.9 },
    ],
    inferences: [],
    missingCriticalFacts: [],
  };
  const evidence = new Map([
    [EV_A, { evidenceText: "60 units", sourceUrl: "https://a" }],
    [EV_B, { evidenceText: "$500,000 valuation", sourceUrl: "https://b" }],
  ]);

  it("annotates ONLY facts that carry a prior, with the source run id", () => {
    const priors = new Map([
      [`project.units ${EV_A}`, { propagatedFrom: RUN_NEW, kind: "same_evidence" as const }],
    ]);
    const prompt = buildVerifierPrompt(extraction, evidence, priors);
    expect(prompt).toContain(`prior: an earlier independent verification (run ${RUN_NEW})`);
    // The un-priored fact block carries no prior line.
    const valuationBlock = prompt.split("---").find((b) => b.includes("project.valuationUsd"));
    expect(valuationBlock).toBeDefined();
    expect(valuationBlock).not.toContain("prior:");
  });

  it("without priors the prompt is byte-identical to the pre-propagation form", () => {
    expect(buildVerifierPrompt(extraction, evidence)).toBe(
      buildVerifierPrompt(extraction, evidence, new Map()),
    );
  });
});

describe("rejected prior stands (confirms-or-rejects, never inherits)", () => {
  it("a supported:false verdict on a prior-carrying fact survives validation and provenance merge", () => {
    const facts = [{ path: "project.units", evidenceId: EV_A }];
    const modelOutput = JSON.stringify({
      verdicts: [
        { path: "project.units", evidenceId: EV_A, supported: false, reason: "evidence is vague" },
      ],
    });
    const validated = validateVerifierOutput(modelOutput, facts);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    // Provenance rides BESIDE the verdicts — merging never rewrites them.
    const stored = {
      ...validated.value,
      priors: [
        { path: "project.units", evidenceId: EV_A, propagated_from: RUN_NEW, kind: "same_evidence" },
      ],
    };
    expect(stored.verdicts[0]!.supported).toBe(false);
    expect(stored.verdicts.every((v) => v.supported)).toBe(false);
  });
});
