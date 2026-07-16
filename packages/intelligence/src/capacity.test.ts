import { describe, expect, it } from "vitest";
import { assessCapacity, type CapacitySnapshot } from "./capacity.js";

function snap(over: Partial<CapacitySnapshot> = {}): CapacitySnapshot {
  return {
    id: "s1",
    accountProfileId: "a1",
    effectiveFrom: new Date("2026-01-01"),
    effectiveTo: null,
    availableCrews: 3,
    backlogState: "normal",
    preferredStartWindow: null,
    minimumContractValue: 50_000,
    idealContractValue: 400_000,
    maximumContractValue: 2_000_000,
    maximumTravelMinutes: 60,
    acceptsPublicWork: false,
    bondingLimit: null,
    tradeCapacityJson: null,
    provisional: false,
    notes: null,
    ...over,
  };
}

describe("S0 assessCapacity (deterministic, explained)", () => {
  it("no snapshot → unknown, no penalty, stated reason", () => {
    const a = assessCapacity({ valuationUsd: 100_000, isPublicWork: false }, null);
    expect(a.assessment).toBe("unknown");
    expect(a.priorityFactor).toBe(1);
    expect(a.explanation).toMatch(/no capacity snapshot/i);
  });

  it("hard exclusion: public work the account won't take → excluded, factor 0", () => {
    const a = assessCapacity({ valuationUsd: 300_000, isPublicWork: true }, snap({ acceptsPublicWork: false }));
    expect(a.assessment).toBe("excluded");
    expect(a.priorityFactor).toBe(0);
    expect(a.explanation).toMatch(/does not accept public work/i);
  });

  it("unknown valuation → unknown (never a fabricated fit)", () => {
    const a = assessCapacity({ valuationUsd: null, isPublicWork: false }, snap());
    expect(a.assessment).toBe("unknown");
    expect(a.explanation).toMatch(/valuation unknown/i);
  });

  it("over the max → likely_too_large, demoted to radar (not deleted)", () => {
    const a = assessCapacity({ valuationUsd: 5_000_000, isPublicWork: false }, snap());
    expect(a.assessment).toBe("likely_too_large");
    expect(a.priorityFactor).toBeGreaterThan(0);
    expect(a.priorityFactor).toBeLessThan(1);
    expect(a.explanation).toMatch(/exceeds.*maximum contract value/i);
  });

  it("below the minimum job size → possible_stretch with explanation", () => {
    const a = assessCapacity({ valuationUsd: 10_000, isPublicWork: false }, snap());
    expect(a.assessment).toBe("possible_stretch");
    expect(a.explanation).toMatch(/below.*minimum useful job size/i);
  });

  it("within range → likely_fit, no penalty", () => {
    const a = assessCapacity({ valuationUsd: 350_000, isPublicWork: false }, snap());
    expect(a.assessment).toBe("likely_fit");
    expect(a.priorityFactor).toBe(1);
  });

  it("provisional snapshots label their explanation (never present a guess as calibrated)", () => {
    const a = assessCapacity({ valuationUsd: 10_000, isPublicWork: false }, snap({ provisional: true }));
    expect(a.provisional).toBe(true);
    expect(a.explanation).toMatch(/provisional/i);
  });

  it("same project, different snapshots → different assessment (exit gate)", () => {
    const project = { valuationUsd: 1_500_000, isPublicWork: false };
    const small = assessCapacity(project, snap({ maximumContractValue: 1_000_000 }));
    const large = assessCapacity(project, snap({ maximumContractValue: 3_000_000 }));
    expect(small.assessment).toBe("likely_too_large");
    expect(large.assessment).toBe("likely_fit");
  });
});
