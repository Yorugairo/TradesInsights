import { describe, expect, it } from "vitest";
import { normalizeAddressUS, normalizePhoneUS, normalizeSourceEntityId } from "./identifiers.js";

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
