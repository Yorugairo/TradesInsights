import { describe, expect, it } from "vitest";
import { parseEvalSet, runEval, type EvalExample } from "./harness.js";
import type { AccountScoringInput } from "../scoring.js";

const ACCOUNT: AccountScoringInput = {
  key: "lacey_glass_at_home",
  territory: { counties_included: ["Thurston", "Lewis"], counties_excluded: ["King"] },
  weights: {
    product_fit: 25,
    repeatable_units_or_builder_value: 25,
    timing: 20,
    territory: 10,
    builder_developer_identified: 10,
    evidence_quality: 10,
  },
  delivery: { priority_review_min: 80, weekly_digest_min: 65 },
};

function example(over: Partial<EvalExample> & { id: string }): EvalExample {
  return {
    account: "lacey_glass_at_home",
    projectId: "8b7d2f1e-4c3a-4b5d-9e8f-1a2b3c4d5e6f",
    projectName: "TEST",
    label: "positive",
    split: "dev",
    category: "sfr_new",
    rationale: "test",
    evidenceRefs: ["X-1"],
    frozenAt: "2026-07-16T00:00:00Z",
    features: {
      projectId: "8b7d2f1e-4c3a-4b5d-9e8f-1a2b3c4d5e6f",
      county: "Lewis",
      permittingJurisdiction: "Lewis County",
      city: null,
      stage: "permit_issued",
      text: "single family residence new construction",
      maxUnits: null,
      maxValuation: 300_000,
      clusterSize: 1,
      hasVelocitySignal: false,
      orgs: [{ name: "TEST HOMES LLC", role: "applicant" }],
      aGradeEvidence: 2,
      lastMaterialChangeAt: "2026-07-01T00:00:00Z",
    },
    ...over,
  };
}

describe("M4.1 eval harness", () => {
  it("replays frozen features deterministically (clock injected from frozenAt)", () => {
    const ex = example({ id: "e1" });
    const a = runEval([ex], [ACCOUNT]);
    const b = runEval([ex], [ACCOUNT]);
    expect(a.overall).toEqual(b.overall);
    // The example is recent relative to its OWN frozen clock, regardless of
    // when the eval runs.
    expect(a.overall.positivesRecalled).toBe(1);
  });

  it("counts hard negatives in priority against precision", () => {
    const strongNegative = example({
      id: "e2",
      label: "hard_negative",
      features: {
        ...example({ id: "x" }).features,
        // A clustered subdivision — scores priority, but labeled negative.
        text: "plat single family residence subdivision",
        clusterSize: 8,
        hasVelocitySignal: true,
        stage: "permit_issued",
        orgs: [{ name: "BUILDER LLC", role: "applicant" }],
      },
    });
    const result = runEval([example({ id: "e1" }), strongNegative], [ACCOUNT]);
    expect(result.overall.priorityFlagged).toBeGreaterThanOrEqual(1);
    expect(result.overall.hardNegativesInPriority).toContain("e2");
    expect(result.overall.priorityPrecision).toBeLessThan(1);
  });

  it("respects split filtering", () => {
    const dev = example({ id: "e1", split: "dev" });
    const holdout = example({ id: "e2", split: "holdout" });
    expect(runEval([dev, holdout], [ACCOUNT], { split: "dev" }).overall.examples).toBe(1);
    expect(runEval([dev, holdout], [ACCOUNT], { split: "holdout" }).overall.examples).toBe(1);
    expect(runEval([dev, holdout], [ACCOUNT]).overall.examples).toBe(2);
  });

  it("rejects malformed sets and duplicate ids", () => {
    expect(() => parseEvalSet('{"id":"x"}')).toThrow(/line 1/);
    const line = JSON.stringify(example({ id: "dup" }));
    expect(() => parseEvalSet(`${line}\n${line}`)).toThrow(/duplicate/);
  });
});
