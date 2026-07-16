import { describe, expect, it } from "vitest";
import { validateVerifierOutput } from "./verifier-contract.js";

const EV_A = "8b7d2f1e-4c3a-4b5d-9e8f-1a2b3c4d5e6f";
const EV_B = "0f9e8d7c-6b5a-4d3c-8b2a-9f8e7d6c5b4a";
const FACTS = [
  { path: "project.units", evidenceId: EV_A },
  { path: "roles.general_contractor", evidenceId: EV_B },
];

describe("verifier contract validation", () => {
  it("accepts one verdict per fact", () => {
    const r = validateVerifierOutput(
      JSON.stringify({
        verdicts: [
          { path: "project.units", evidenceId: EV_A, supported: true, reason: "stated explicitly" },
          { path: "roles.general_contractor", evidenceId: EV_B, supported: false, reason: "role not stated" },
        ],
      }),
      FACTS,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.verdicts.filter((v) => !v.supported)).toHaveLength(1);
  });

  it("rejects a verdict for a fact that was never extracted (fabrication)", () => {
    const r = validateVerifierOutput(
      JSON.stringify({
        verdicts: [
          { path: "project.units", evidenceId: EV_A, supported: true, reason: "ok" },
          { path: "roles.general_contractor", evidenceId: EV_B, supported: true, reason: "ok" },
          { path: "dates.bid_date", evidenceId: EV_A, supported: true, reason: "invented" },
        ],
      }),
      FACTS,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations.some((v) => v.kind === "unknown_fact")).toBe(true);
  });

  it("rejects incomplete verification (missing verdict)", () => {
    const r = validateVerifierOutput(
      JSON.stringify({
        verdicts: [
          { path: "project.units", evidenceId: EV_A, supported: true, reason: "ok" },
        ],
      }),
      FACTS,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations.some((v) => v.kind === "missing_verdict")).toBe(true);
  });

  it("rejects prose and schema violations", () => {
    expect(validateVerifierOutput("All facts check out.", FACTS).ok).toBe(false);
    const bad = validateVerifierOutput(
      JSON.stringify({ verdicts: [{ path: "project.units", evidenceId: EV_A, supported: "yes" }] }),
      FACTS,
    );
    expect(bad.ok).toBe(false);
  });
});
