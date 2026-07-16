import { describe, expect, it } from "vitest";
import { decideInclusion, highRiskReasons, type InclusionInput } from "./automation.js";
import type { GateResult } from "./gate.js";

const PASS_GATE: GateResult = {
  opportunityId: "o",
  projectId: "p",
  accountProfileId: "a",
  status: "pass",
  publishable: true,
  checks: [],
};

function input(over: Partial<InclusionInput> = {}): InclusionInput {
  return {
    gate: PASS_GATE,
    extraction: {
      facts: [
        {
          path: "project.units",
          value: 42,
          evidenceId: "8b7d2f1e-4c3a-4b5d-9e8f-1a2b3c4d5e6f",
          confirmed: true,
          confidence: 0.97,
        },
      ],
      inferences: [],
      missingCriticalFacts: [],
    },
    verification: {
      status: "succeeded",
      result: {
        verdicts: [
          {
            path: "project.units",
            evidenceId: "8b7d2f1e-4c3a-4b5d-9e8f-1a2b3c4d5e6f",
            supported: true,
            reason: "stated",
          },
        ],
      },
    },
    route: "interior_trades",
    state: "weekly_digest",
    maxValuation: 250_000,
    stage: "permit_issued",
    text: "tenant improvement",
    ...over,
  };
}

describe("M4.3 auto-inclusion policy", () => {
  it("auto-includes only verified high-confidence complete items", () => {
    expect(decideInclusion(input()).mode).toBe("auto");
  });

  it("requires review without an extraction, verification, or full support", () => {
    expect(decideInclusion(input({ extraction: null })).reasons).toContain("no_model_extraction");
    expect(decideInclusion(input({ verification: null })).reasons).toContain(
      "not_independently_verified",
    );
    const unsupported = input();
    unsupported.verification!.result!.verdicts[0]!.supported = false;
    expect(decideInclusion(unsupported).reasons).toContain("not_independently_verified");
  });

  it("requires review for low confidence or missing critical facts", () => {
    const low = input();
    low.extraction!.facts[0]!.confidence = 0.7;
    expect(decideInclusion(low).reasons).toContain("low_confidence_fact");
    const missing = input();
    missing.extraction!.missingCriticalFacts = ["general_contractor"];
    expect(decideInclusion(missing).reasons).toContain("missing_critical_facts");
  });

  it("never auto-includes when the gate is not a full pass", () => {
    const blocked = decideInclusion(
      input({ gate: { ...PASS_GATE, status: "blocked_on_verifier", publishable: false } }),
    );
    expect(blocked.mode).toBe("review_required");
  });
});

describe("M4.4 high-risk categories always require a human", () => {
  it("flags deadlines/actionable claims, high value, ambiguous routing, contact data, bid state", () => {
    expect(highRiskReasons(input({ text: "bids due august 12" }))).toContain(
      "deadline_or_actionable_claim",
    );
    expect(highRiskReasons(input({ maxValuation: 8_000_000 }))).toContain("high_value_project");
    expect(highRiskReasons(input({ route: "joint_review" }))).toContain("ambiguous_routing");
    expect(highRiskReasons(input({ stage: "bidding_confirmed" }))).toContain(
      "externally_actionable_bid_state",
    );
    const contact = input();
    contact.extraction!.facts.push({
      path: "contacts.estimator_email",
      value: "x@y.z",
      evidenceId: "8b7d2f1e-4c3a-4b5d-9e8f-1a2b3c4d5e6f",
      confirmed: true,
      confidence: 0.99,
    });
    expect(highRiskReasons(contact)).toContain("contact_data");
  });

  it("high-risk items are review_required even when fully verified", () => {
    const d = decideInclusion(input({ maxValuation: 8_000_000 }));
    expect(d.mode).toBe("review_required");
    expect(d.reasons).toEqual(["high_value_project"]);
  });

  it("a recorded human decision (promoted) is the only override", () => {
    const d = decideInclusion(input({ maxValuation: 8_000_000, state: "promoted" }));
    expect(d.mode).toBe("auto");
  });
});
