import { describe, expect, it } from "vitest";
import {
  ADDRESS_SHARED_MIN_NAME_SIMILARITY,
  AUTO_ACCEPT_MIN_RATE,
  buildRegistryAddressIndex,
  buildRegistryDomainIndex,
  buildRegistryGooglePhoneIndex,
  computeTrust,
  crossNameKey,
  evaluateStrictBind,
  GOOGLE_PHONE_IDENTIFIER_COMPONENT,
  laplaceAcceptRate,
  matchOrgByAddress,
  PHONE_MATCH_MIN_NAME_SIMILARITY,
  registryCorroborationBonus,
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

describe("evaluateStrictBind (the ONE binding tier that auto-accepts — governance-critical)", () => {
  const base = {
    ruleKey: "binding_name_exact",
    nameComponent: 1,
    orgNameKey: "SOUND ELECTRONICS",
    registryNormalizedKey: "SOUND ELECTRONICS",
    locality: 1,
    orgTradeCodes: new Set(["electrical"]),
    registryTradeCodes: new Set(["electrical"]),
  };

  it("qualifies on exact name + same city + shared authoritative trade", () => {
    const r = evaluateStrictBind(base);
    expect(r.strict).toBe(true);
    expect(r.sharedTradeCodes).toEqual(["electrical"]);
  });

  it("refuses without a shared trade (registry codes GC, permits say roofing → stays in review)", () => {
    const r = evaluateStrictBind({
      ...base,
      orgTradeCodes: new Set(["roofing"]),
      registryTradeCodes: new Set(["general_contractor"]),
    });
    expect(r.strict).toBe(false);
    expect(r.sharedTradeCodes).toEqual([]);
  });

  it("refuses when the city differs (locality below 1)", () => {
    expect(evaluateStrictBind({ ...base, locality: 0.3 }).strict).toBe(false);
  });

  it("refuses a non-exact-name rule — phone/address/domain matches stay human-reviewed", () => {
    expect(evaluateStrictBind({ ...base, ruleKey: "binding_phone_match", nameComponent: 0.6 }).strict).toBe(false);
    expect(evaluateStrictBind({ ...base, ruleKey: "binding_address_match" }).strict).toBe(false);
    expect(evaluateStrictBind({ ...base, ruleKey: "binding_domain_match" }).strict).toBe(false);
  });

  it("accepts the exact-name-with-agreeing-phone rule too", () => {
    expect(evaluateStrictBind({ ...base, ruleKey: "binding_name_phone" }).strict).toBe(true);
  });

  it("refuses when the name component is not a full 1.0", () => {
    expect(evaluateStrictBind({ ...base, nameComponent: 0.9 }).strict).toBe(false);
  });

  it("refuses when the registry's OWN normalized name disagrees with the org key", () => {
    expect(evaluateStrictBind({ ...base, registryNormalizedKey: "SOUND ELECTRONIC" }).strict).toBe(false);
  });

  it("skips the normalized-name check when the contract did not surface it (older rows)", () => {
    expect(evaluateStrictBind({ ...base, registryNormalizedKey: null }).strict).toBe(true);
  });

  it("shares only the intersection of trade codes", () => {
    const r = evaluateStrictBind({
      ...base,
      orgTradeCodes: new Set(["electrical", "mechanical"]),
      registryTradeCodes: new Set(["mechanical", "plumbing"]),
    });
    expect(r.strict).toBe(true);
    expect(r.sharedTradeCodes).toEqual(["mechanical"]);
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

  it("disambiguates a shared-building address by clear name dominance (4B.3)", () => {
    const suiteMate = regRow({
      entityId: "other-tenant",
      canonicalName: "Other Tenant LLC",
      registeredAddress: "1210 HOMANN DR SE",
      registeredPostalCode: "98503",
    });
    const byAddress = buildRegistryAddressIndex([LACEY, suiteMate]);
    expect(byAddress.get(ORG_KEY)).toHaveLength(2); // bucket kept, not dropped
    const hit = matchOrgByAddress("Lacey Glass Inc", new Set([ORG_KEY]), byAddress);
    expect(hit?.row.entityId).toBe("lacey-glass");
    expect(hit?.bucketSize).toBe(2);
    expect(hit!.sim).toBeGreaterThanOrEqual(ADDRESS_SHARED_MIN_NAME_SIMILARITY);
  });

  it("refuses a shared address when no name clearly dominates (floor or margin)", () => {
    // Two glass companies in one suite block: near-tie sims — WHICH one is the
    // org? Unanswerable, so the bucket yields nothing.
    const glassTwin = regRow({
      entityId: "glass-twin",
      canonicalName: "Lacey Glass Co",
      registeredAddress: "1210 HOMANN DR SE",
      registeredPostalCode: "98503",
    });
    const byAddress = buildRegistryAddressIndex([LACEY, glassTwin]);
    expect(matchOrgByAddress("Lacey Glass", new Set([ORG_KEY]), byAddress)).toBeNull();
    // And a weak best (below the 0.5 shared floor) fails even when dominant.
    const stranger = regRow({
      entityId: "stranger",
      canonicalName: "Zephyr Plumbing And Rooter",
      registeredAddress: "1210 HOMANN DR SE",
      registeredPostalCode: "98503",
    });
    const byAddress2 = buildRegistryAddressIndex([LACEY, stranger]);
    expect(matchOrgByAddress("Cascade Roofing Northwest", new Set([ORG_KEY]), byAddress2)).toBeNull();
  });

  it("indexes suite-noise candidate variants on the registry side too (round 2)", () => {
    const withUnit = regRow({
      entityId: "unit-entity",
      canonicalName: "Unit Entity LLC",
      registeredAddress: "1210 HOMANN DR SE 210",
      registeredPostalCode: "98503",
    });
    const byAddress = buildRegistryAddressIndex([withUnit]);
    // The unit-peeled variant meets the org's street-only key form.
    expect(byAddress.get("1210 HOMANN DR SE 98503")?.[0]?.entityId).toBe("unit-entity");
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

describe("google-phone index (binding_google_phone_match, 4B.2)", () => {
  const byPhone = (rows: RegistryIdentityRow[]) => {
    const m = new Map<string, RegistryIdentityRow | null>();
    for (const r of rows) {
      if (!r.phone) continue;
      m.set(r.phone, m.has(r.phone) ? null : r);
    }
    return m;
  };

  it("indexes a unique google phone (normalized) for its entity", () => {
    const row = regRow({ entityId: "g1", canonicalName: "G One", googlePhone: "(360) 555-0100" });
    const idx = buildRegistryGooglePhoneIndex([row], byPhone([row]));
    expect(idx.get("3605550100")?.entityId).toBe("g1");
  });

  it("poisons a google phone that collides with a DIFFERENT entity's L&I phone", () => {
    const lniOwner = regRow({ entityId: "owner", canonicalName: "Owner", phone: "3605550100" });
    const pretender = regRow({ entityId: "pretender", canonicalName: "P", googlePhone: "360-555-0100" });
    const rows = [lniOwner, pretender];
    const idx = buildRegistryGooglePhoneIndex(rows, byPhone(rows));
    expect(idx.get("3605550100")).toBeNull();
  });

  it("keeps a google phone equal to the SAME entity's own L&I phone, drops shared ones", () => {
    const self = regRow({ entityId: "self", canonicalName: "Self", phone: "3605550100", googlePhone: "3605550100" });
    const idx = buildRegistryGooglePhoneIndex([self], byPhone([self]));
    expect(idx.get("3605550100")?.entityId).toBe("self");
    const twinA = regRow({ entityId: "a", googlePhone: "3605550101" });
    const twinB = regRow({ entityId: "b", googlePhone: "3605550101" });
    const idx2 = buildRegistryGooglePhoneIndex([twinA, twinB], byPhone([twinA, twinB]));
    expect(idx2.get("3605550101")).toBeNull();
  });

  it("de-rates the identifier component versus the L&I channel", () => {
    expect(GOOGLE_PHONE_IDENTIFIER_COMPONENT).toBeLessThan(1);
    expect(GOOGLE_PHONE_IDENTIFIER_COMPONENT).toBeGreaterThan(0.5);
  });
});

describe("root-domain index (binding_domain_match, Phase 4 enablement)", () => {
  it("indexes a unique normalized root domain; both sides fold identically", () => {
    const row = regRow({ entityId: "d1", canonicalName: "NW Mechanical", rootDomain: "https://www.nwmechanical.com/" });
    const idx = buildRegistryDomainIndex([row]);
    expect(idx.get("nwmechanical.com")?.entityId).toBe("d1");
  });

  it("drops shared domains and denylisted platform hosts — fails closed", () => {
    const a = regRow({ entityId: "a", rootDomain: "shared-brand.com" });
    const b = regRow({ entityId: "b", rootDomain: "www.shared-brand.com" });
    const idx = buildRegistryDomainIndex([a, b]);
    expect(idx.get("shared-brand.com")).toBeNull();
    const fb = regRow({ entityId: "fb", rootDomain: "facebook.com/somebiz" });
    expect(buildRegistryDomainIndex([fb]).size).toBe(0);
  });
});
