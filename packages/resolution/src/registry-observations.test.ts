import { describe, expect, it } from "vitest";
import {
  AUTO_ACCEPT_MIN_RATE,
  buildRegistryAddressIndex,
  computeTrust,
  crossNameKey,
  laplaceAcceptRate,
  matchOrgByAddress,
  PHONE_MATCH_MIN_NAME_SIMILARITY,
  registryCorroborationBonus,
  TRADE_KEYWORDS,
  TRUST_WEIGHTS,
  type TrustComponents,
} from "./registry-observations.js";
import { addressMatchKey } from "./identifiers.js";
import type { RegistryIdentityRow } from "./registry-link.js";

function regRow(over: Partial<RegistryIdentityRow>): RegistryIdentityRow {
  return {
    entityId: "e", ubi: null, contractorNumbers: null, canonicalName: null,
    canonicalNameNormalized: null, phone: null, cityToken: null, stateCode: "WA",
    registeredAddress: null, registeredPostalCode: null, ...over,
  };
}

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

describe("registryCorroborationBonus (A.4 — bounded registry corroboration)", () => {
  it("is 0 when the registry record count is absent (hand-built rows / unpopulated view)", () => {
    expect(registryCorroborationBonus(null)).toBe(0);
    expect(registryCorroborationBonus(undefined)).toBe(0);
    expect(registryCorroborationBonus(0)).toBe(0);
  });

  it("lifts by a bounded amount, monotonic but capped (large registry counts never dominate)", () => {
    expect(registryCorroborationBonus(1)).toBe(0.25);
    expect(registryCorroborationBonus(2)).toBe(0.25);
    expect(registryCorroborationBonus(3)).toBe(0.5);
    expect(registryCorroborationBonus(500)).toBe(0.5);
  });

  it("raises a thin-Insights-evidence candidate's corroboration when the registry substantiates it", () => {
    // Insights alone: 1 distinct source record ⇒ corroboration 1/3. The registry
    // independently substantiating the entity adds a bounded lift.
    const insightsOnly = Math.min(1, 1 / 3 + registryCorroborationBonus(null));
    const withRegistry = Math.min(1, 1 / 3 + registryCorroborationBonus(9));
    expect(withRegistry).toBeGreaterThan(insightsOnly);
    expect(withRegistry).toBeCloseTo(1 / 3 + 0.5);
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

describe("registry address match (binding_address_match, injected rows)", () => {
  // Lacey Glass live values: street-only registered address + separate zip.
  const LACEY = regRow({
    entityId: "lacey-glass",
    canonicalName: "Lacey Glass Inc",
    registeredAddress: "1210 HOMANN DR SE",
    registeredPostalCode: "98503",
  });
  // An org's address identifier is the FULL mailing string it published.
  const ORG_KEY = addressMatchKey("1210 HOMANN DR SE, LACEY WA 98503")!;

  it("matches a no-phone org to its L&I entity by street+zip when the name agrees", () => {
    const byAddress = buildRegistryAddressIndex([LACEY]);
    const hit = matchOrgByAddress("Lacey Glass Inc", new Set([ORG_KEY]), byAddress);
    expect(hit?.row.entityId).toBe("lacey-glass");
    expect(hit!.sim).toBeGreaterThanOrEqual(PHONE_MATCH_MIN_NAME_SIMILARITY);
  });

  it("drops a shared-building address (2+ entities) as a non-unique key", () => {
    const suiteMate = regRow({
      entityId: "other-tenant",
      canonicalName: "Other Tenant LLC",
      registeredAddress: "1210 HOMANN DR SE",
      registeredPostalCode: "98503",
    });
    const byAddress = buildRegistryAddressIndex([LACEY, suiteMate]);
    expect(byAddress.get(ORG_KEY)).toBeNull(); // collision → dropped
    expect(matchOrgByAddress("Lacey Glass Inc", new Set([ORG_KEY]), byAddress)).toBeNull();
  });

  it("does NOT match a foreign name at the same address (below the name gate)", () => {
    const byAddress = buildRegistryAddressIndex([LACEY]);
    expect(matchOrgByAddress("Zephyr Plumbing And Rooter", new Set([ORG_KEY]), byAddress)).toBeNull();
  });

  it("ignores a registry row whose address can't form a key (no zip → not indexed)", () => {
    const noZip = regRow({ entityId: "x", canonicalName: "X", registeredAddress: "1 A ST", registeredPostalCode: null });
    const byAddress = buildRegistryAddressIndex([noZip]);
    expect(byAddress.size).toBe(0);
  });
});
