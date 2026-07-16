import { describe, expect, it } from "vitest";
import { validateExtraction } from "./contract.js";

const EV_A = "8b7d2f1e-4c3a-4b5d-9e8f-1a2b3c4d5e6f";
const EV_B = "0f9e8d7c-6b5a-4d3c-8b2a-9f8e7d6c5b4a";
const UNKNOWN = "11111111-2222-4333-8444-555555555555";
const KNOWN = new Set([EV_A, EV_B]);

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    facts: [
      { path: "project.units", value: 78, evidenceId: EV_A, confirmed: true, confidence: 0.99 },
    ],
    inferences: [
      {
        type: "trade_fit",
        value: "commercial_glazing_plausible",
        evidenceIds: [EV_B],
        confidence: 0.72,
        reason: "System and package are not stated.",
      },
    ],
    missingCriticalFacts: ["general_contractor", "procurement_status"],
    ...overrides,
  });
}

describe("§13 contract validation", () => {
  it("accepts the spec's example shape", () => {
    const r = validateExtraction(payload(), KNOWN);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.facts[0]!.path).toBe("project.units");
      expect(r.value.missingCriticalFacts).toContain("procurement_status");
    }
  });

  it("accepts output wrapped in a markdown fence", () => {
    const r = validateExtraction("```json\n" + payload() + "\n```", KNOWN);
    expect(r.ok).toBe(true);
  });

  it("rejects a fact citing an unknown evidence ID (spec: reject unknown IDs)", () => {
    const r = validateExtraction(
      payload({
        facts: [
          { path: "project.units", value: 78, evidenceId: UNKNOWN, confirmed: true, confidence: 0.9 },
        ],
      }),
      KNOWN,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations[0]!.kind).toBe("unknown_evidence_id");
  });

  it("rejects an inference citing any unknown evidence ID", () => {
    const r = validateExtraction(
      payload({
        inferences: [
          {
            type: "trade_fit",
            value: "x",
            evidenceIds: [EV_A, UNKNOWN],
            confidence: 0.5,
            reason: "mixed citations",
          },
        ],
      }),
      KNOWN,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations.some((v) => v.kind === "unknown_evidence_id")).toBe(true);
  });

  it("rejects non-JSON output", () => {
    const r = validateExtraction("I found 78 units in the permit.", KNOWN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations[0]!.kind).toBe("invalid_json");
  });

  it("rejects schema violations (confidence out of range, missing reason)", () => {
    const bad = validateExtraction(
      payload({
        inferences: [
          { type: "trade_fit", value: "x", evidenceIds: [EV_A], confidence: 1.5 },
        ],
      }),
      KNOWN,
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.violations.every((v) => v.kind === "schema")).toBe(true);
  });

  it("rejects an empty evidenceIds list on an inference", () => {
    const r = validateExtraction(
      payload({
        inferences: [
          { type: "trade_fit", value: "x", evidenceIds: [], confidence: 0.5, reason: "none" },
        ],
      }),
      KNOWN,
    );
    expect(r.ok).toBe(false);
  });
});
