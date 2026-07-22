import { describe, expect, it } from "vitest";
import {
  addressMatchKey,
  addressMatchKeyCandidates,
  normalizeAddressUS,
  normalizePhoneUS,
  normalizeSourceEntityId,
} from "./identifiers.js";

describe("normalizePhoneUS", () => {
  it("strips punctuation and a leading country code to bare 10 digits", () => {
    expect(normalizePhoneUS("(253) 555-0142")).toBe("2535550142");
    expect(normalizePhoneUS("1-253-555-0142")).toBe("2535550142");
    expect(normalizePhoneUS("253.555.0142")).toBe("2535550142");
    expect(normalizePhoneUS(" 253 555 0142 ")).toBe("2535550142");
  });

  it("rejects implausible numbers instead of guessing", () => {
    expect(normalizePhoneUS("555-0142")).toBeNull(); // 7 digits — no area code
    expect(normalizePhoneUS("011-44-20-7946-0958")).toBeNull(); // international
    expect(normalizePhoneUS("")).toBeNull();
    expect(normalizePhoneUS(null)).toBeNull();
  });
});

describe("normalizeAddressUS", () => {
  it("folds street/directional words and case to one stable key", () => {
    expect(normalizeAddressUS("14007 179th Street Court East")).toBe("14007 179TH ST CT E");
    expect(normalizeAddressUS("1302 Puyallup St, Sumner, WA 98390")).toBe(
      "1302 PUYALLUP ST SUMNER WA 98390",
    );
  });

  it("drops secondary-unit designators so two systems' forms of one business agree", () => {
    // PALS' dangling empty "UNIT " must not swallow the city that follows it.
    expect(normalizeAddressUS("33820 WEYERHAEUSER WAY S UNIT , AUBURN, WA 98001")).toBe(
      "33820 WEYERHAEUSER WAY S AUBURN WA 98001",
    );
    // A real suite value is dropped; the L&I form without it still matches.
    expect(normalizeAddressUS("1302 Puyallup St Ste A, Sumner WA 98390")).toBe(
      normalizeAddressUS("1302 Puyallup Street, Sumner WA 98390"),
    );
    expect(normalizeAddressUS("500 Main St Suite 210, Olympia WA 98501")).toBe(
      "500 MAIN ST OLYMPIA WA 98501",
    );
  });

  it("rejects fragments too generic to be a match key", () => {
    expect(normalizeAddressUS("Auburn, WA")).toBeNull(); // no street number
    expect(normalizeAddressUS("WA 98001")).toBeNull(); // 2 tokens
    expect(normalizeAddressUS("")).toBeNull();
    expect(normalizeAddressUS(null)).toBeNull();
  });
});

describe("normalizeSourceEntityId", () => {
  it("keeps a namespaced id, trimming whitespace", () => {
    expect(normalizeSourceEntityId("pierce_pals:462942")).toBe("pierce_pals:462942");
    expect(normalizeSourceEntityId("  pierce_pals:462942 ")).toBe("pierce_pals:462942");
  });

  it("rejects an unqualified id so it can't collide across sources", () => {
    expect(normalizeSourceEntityId("462942")).toBeNull(); // no namespace separator
    expect(normalizeSourceEntityId(":")).toBeNull(); // too short
    expect(normalizeSourceEntityId(null)).toBeNull();
  });
});

describe("addressMatchKey (registry street+zip5 match key)", () => {
  it("reduces a full org mailing string and a street-only registry address to ONE key", () => {
    // Insights org identifier: full mailing string (Lacey Glass live value).
    const orgKey = addressMatchKey("1210 HOMANN DR SE, LACEY WA 98503");
    // Registry contract view: street-only address + separate postal code.
    const registryKey = addressMatchKey("1210 HOMANN DR SE", "98503");
    expect(orgKey).toBe("1210 HOMANN DR SE 98503");
    expect(registryKey).toBe("1210 HOMANN DR SE 98503");
    expect(orgKey).toBe(registryKey);
  });

  it("folds street-word variants so DRIVE and DR collapse to the same key", () => {
    expect(addressMatchKey("1210 HOMANN DRIVE SE, LACEY WA 98503")).toBe(
      addressMatchKey("1210 HOMANN DR SE", "98503"),
    );
  });

  it("takes the zip from the END, not a 5-digit street number, and drops the unit", () => {
    // 33820 is the street NUMBER; 98001 is the zip. UNIT is dropped as a suite.
    expect(addressMatchKey("33820 WEYERHAEUSER WAY S UNIT, AUBURN, WA 98001")).toBe(
      "33820 WEYERHAEUSER WAY S 98001",
    );
  });

  it("returns null when there is no zip or no usable street (never guessed)", () => {
    expect(addressMatchKey("1210 HOMANN DR SE")).toBeNull(); // no zip on either side
    expect(addressMatchKey(null)).toBeNull();
    expect(addressMatchKey("", "98503")).toBeNull();
  });

  it("keeps a PO-BOX key distinct so it never collides with a street address", () => {
    // PO boxes are valid keys but structurally can't equal a site street key —
    // the plan's intended 'PO-BOX registered address → no site match'.
    const poBox = addressMatchKey("PO BOX 1234, OLYMPIA WA 98501");
    const street = addressMatchKey("500 MAIN ST, OLYMPIA WA 98501");
    expect(poBox).not.toBe(street);
  });
});

describe("addressMatchKeyCandidates (comma-less city peeling — flywheel Phase 2)", () => {
  it("peels the inline city off a comma-less mailing string down to the registry's street-only key", () => {
    // Live dormancy case: org identifier has no commas, registry is street-only.
    const candidates = addressMatchKeyCandidates("9680 153rd Ave NE REDMOND WA 98052");
    expect(candidates).toContain("9680 153RD AVE NE REDMOND 98052"); // primary preserved
    expect(candidates).toContain(addressMatchKey("9680 153RD AVE NE", "98052"));
  });

  it("stops peeling at a street suffix or directional (never eats the street tail)", () => {
    const candidates = addressMatchKeyCandidates("16110 Woodinville Redmond Rd NE Woodinville WA 98072");
    expect(candidates).toContain("16110 WOODINVILLE REDMOND RD NE 98072");
    // "RD NE" tail survives — REDMOND inside the street name is untouched.
    expect(candidates).not.toContain("16110 WOODINVILLE 98072");
  });

  it("comma'd strings return only the primary key (street line is already isolated)", () => {
    expect(addressMatchKeyCandidates("1210 HOMANN DR SE, LACEY WA 98503")).toEqual([
      "1210 HOMANN DR SE 98503",
    ]);
  });

  it("fails closed: a street ending in a bare word keeps its city rather than guessing", () => {
    // Peeling "SEATTLE" would leave "1234 BROADWAY" (2 tokens) — below the
    // validity floor, so no variant is produced past it.
    const candidates = addressMatchKeyCandidates("1234 BROADWAY SEATTLE WA 98122");
    expect(candidates).toEqual(["1234 BROADWAY SEATTLE 98122"]);
  });

  it("returns [] when no primary key exists (no zip — never guessed)", () => {
    expect(addressMatchKeyCandidates("1210 HOMANN DR SE")).toEqual([]);
    expect(addressMatchKeyCandidates(null)).toEqual([]);
  });
});
