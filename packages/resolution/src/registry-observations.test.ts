import { describe, expect, it } from "vitest";
import {
  AUTO_ACCEPT_MIN_RATE,
  computeTrust,
  crossNameKey,
  laplaceAcceptRate,
  TRADE_KEYWORDS,
  TRUST_WEIGHTS,
  type TrustComponents,
} from "./registry-observations.js";

describe("computeTrust", () => {
  const base: TrustComponents = { name: 1, identifier: 1, locality: 1, role: 1, corroboration: 1, ruleHistory: 1 };

  it("is 1.0 when every component is 1.0 (weights sum to 1)", () => {
    expect(Object.values(TRUST_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(computeTrust(base)).toBe(1);
  });

  it("is deterministic and weighted (name dominates)", () => {
    expect(computeTrust({ ...base, name: 0 })).toBeCloseTo(0.7);
    expect(computeTrust({ ...base, ruleHistory: 0.5 })).toBeCloseTo(0.9);
    expect(computeTrust({ ...base, name: 0 })).toBeLessThan(computeTrust({ ...base, locality: 0 }));
  });

  it("scores identifier evidence: agree > neutral > contradiction", () => {
    const agree = computeTrust(base); // identifier 1
    const neutral = computeTrust({ ...base, identifier: 0.5 }); // no phone evidence
    const contradict = computeTrust({ ...base, identifier: 0 }); // phone disagrees with L&I
    expect(agree).toBeGreaterThan(neutral);
    expect(neutral).toBeGreaterThan(contradict);
    expect(agree - contradict).toBeCloseTo(0.15); // the identifier weight
  });

  it("clamps out-of-range components", () => {
    expect(computeTrust({ ...base, name: 2 })).toBe(1);
    expect(computeTrust({ ...base, name: -1 })).toBeCloseTo(0.7);
  });
});

describe("laplaceAcceptRate (the deterministic learning signal)", () => {
  it("starts at the 0.5 prior with no reviewed decisions", () => {
    expect(laplaceAcceptRate(0, 0)).toBe(0.5);
  });
  it("rises with accepts and falls with rejects", () => {
    expect(laplaceAcceptRate(9, 10)).toBeCloseTo(10 / 12);
    expect(laplaceAcceptRate(1, 10)).toBeCloseTo(2 / 12);
    expect(laplaceAcceptRate(10, 10)).toBeGreaterThan(AUTO_ACCEPT_MIN_RATE - 0.1);
  });
});

describe("crossNameKey (cross-system name equality)", () => {
  it("makes the Insights org name and registry canonical name agree", () => {
    // Insights side (permit applicant)         Registry side (L&I canonical)
    expect(crossNameKey("SOLIS INTERIORS LLC")).toBe(crossNameKey("Solis Interiors LLC"));
    expect(crossNameKey("A & B DRYWALL, INC.")).toBe(crossNameKey("A and B Drywall Inc"));
    expect(crossNameKey("1-2-3 PLUMBING LLC")).toBe(crossNameKey("1 2 3 Plumbing"));
  });
  it("strips embedded address tails (Insights fused-name quirk)", () => {
    expect(crossNameKey("ACME BUILDERS 500 UNION STREET SUITE 410 SEATTLE WA")).toBe(
      crossNameKey("Acme Builders LLC"),
    );
  });
});

describe("TRADE_KEYWORDS", () => {
  it("maps only explicit trade signals, never generic building permits", () => {
    const generic = "BUILDING/RESIDENTIAL BUILDING/DWELLING-SINGLE/NA";
    expect(Object.keys(TRADE_KEYWORDS).some((k) => generic.includes(k))).toBe(false);
    expect(TRADE_KEYWORDS["SPRINKLER"]).toBe("fire_sprinkler");
    expect(TRADE_KEYWORDS["MECHANICAL"]).toBe("mechanical");
  });
});
