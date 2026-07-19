import { describe, expect, it } from "vitest";
import { normalizePhoneUS } from "./identifiers.js";

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
