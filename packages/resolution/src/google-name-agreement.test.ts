/**
 * Name agreement between an L&I registration and a Google Business listing
 * (owner directive 2026-07-26): truncated-suffix normalization, whole-token
 * containment, and the two-token guard.
 *
 * Every pair below is REAL, taken from the live audit of 95,382 scrape rows —
 * so a failure here means the rule stopped handling a case that actually exists,
 * not a case someone imagined.
 */
import { describe, expect, it } from "vitest";
import {
  GOOGLE_NAME_CONTAINMENT_MIN_TOKENS,
  classifyGoogleConfirmation,
  classifyNameAgreement,
  nameContainmentTokens,
} from "./registry-identifiers.js";
import { crossNameKey, crossNameKeyLoose } from "./normalize.js";

describe("truncated legal suffixes (L&I clips its name field)", () => {
  // The measured near-misses: all four scored 0.75-0.83 against the untruncated
  // Google name and were rejected as different companies.
  it.each([
    ["LIMITLESS HEATING COOLING LL", "LIMITLESS HEATING COOLING"], // LLC
    ["WEST COAST LIGHTING ENERGY I", "WEST COAST LIGHTING ENERGY"], // INC
    ["EJ S IDEAL HEATING COOLING CRP", "EJ S IDEAL HEATING COOLING"], // CORP
    ["KOALA T POOL SPA SERVS", "KOALA T POOL SPA"], // SERVICES
  ])("folds %s onto %s", (lni, google) => {
    expect(crossNameKeyLoose(lni)).toBe(crossNameKeyLoose(google));
    expect(classifyNameAgreement(lni, google)).toBe("exact");
  });

  it("strips repeated trailing fragments", () => {
    expect(crossNameKeyLoose("ACME PLUMBING SERVS I")).toBe("ACME PLUMBING");
  });

  it("never strips a fragment that is not trailing", () => {
    // "I 5 GLASS" is a real naming pattern (Interstate 5). A leading or medial
    // fragment is part of the name; only a trailing one is a clipped suffix.
    expect(crossNameKeyLoose("I 5 GLASS")).toBe(crossNameKey("I 5 GLASS"));
    expect(crossNameKeyLoose("I 5 GLASS")).toContain("5 GLASS");
  });

  it("never strips the last remaining token", () => {
    // Reducing a name to "" would make it match everything.
    expect(crossNameKeyLoose("SERVS")).toBe("SERVS");
    expect(crossNameKeyLoose("LL")).toBe("LL");
  });

  it("leaves crossNameKey itself untouched (the resolver still keys on it)", () => {
    // The loose key is additive. If this ever fails, the alias lane, org-activity
    // grouping and the binding_name_* rules have all silently been re-keyed.
    expect(crossNameKey("LIMITLESS HEATING COOLING LL")).toBe("LIMITLESS HEATING COOLING LL");
  });
});

describe("whole-token containment", () => {
  it("counts shared tokens when the shorter name is a subsequence", () => {
    expect(nameContainmentTokens("ENCORE ELECTRIC", "ENCORE ELECTRIC WA")).toBe(2);
    expect(nameContainmentTokens("SCHUFF STEEL", "SCHUFF STEEL FABRICATION FACILITY")).toBe(2);
  });

  it("reports 0 for equal names so exact and contained never double-count", () => {
    expect(nameContainmentTokens("ENCORE ELECTRIC", "ENCORE ELECTRIC")).toBe(0);
  });

  it("is token-wise, never substring", () => {
    // A substring test finds AIR inside FAIRWAY and invents a relationship out
    // of spelling.
    expect(nameContainmentTokens("AIR", "FAIRWAY HOMES")).toBe(0);
  });

  it("requires the tokens in order", () => {
    expect(nameContainmentTokens("ELECTRIC ENCORE", "ENCORE ELECTRIC WA")).toBe(0);
  });
});

describe("classifyNameAgreement", () => {
  it("accepts a two-token containment", () => {
    expect(classifyNameAgreement("Encore Electric WA", "Encore Electric")).toBe("contained");
    expect(classifyNameAgreement("Williams Carpet", "Williams Carpet Cleaning")).toBe("contained");
  });

  it("REFUSES a one-token containment", () => {
    // Real rows, and probably the same business — but a single shared token plus
    // a shared switchboard is exactly how a false bind is made, and the form is
    // indistinguishable from a generic first word two unrelated firms share.
    expect(classifyNameAgreement("AECON TECHNICAL SERVICES", "AECON")).toBe("none");
    expect(classifyNameAgreement("SEAFAB", "SEAFAB CUSTOM METAL FABRICATION")).toBe("none");
    expect(GOOGLE_NAME_CONTAINMENT_MIN_TOKENS).toBe(2);
  });

  it("still reports exact, and none for unrelated names", () => {
    expect(classifyNameAgreement("Smith Fire Systems Inc", "Smith Fire Systems, INC")).toBe("exact");
    expect(classifyNameAgreement("Acme Roofing", "Totally Different Co")).toBe("none");
  });

  it("catches the possessive-S split as containment", () => {
    // A real pair. `crossNameKey` folds the apostrophe to a space, so Google's
    // "Ecklund's" becomes the two tokens ECKLUND S and the names are no longer
    // key-equal. Containment is what recognises them as one business — this is
    // the case the rule is earning its keep on, so pin the basis, not just the
    // fact that it matched.
    expect(classifyNameAgreement("Ecklund Drywall Painting", "Ecklund's Drywall Painting")).toBe(
      "contained",
    );
  });

  it("returns none when either side has no name", () => {
    expect(classifyNameAgreement(null, "Encore Electric")).toBe("none");
    expect(classifyNameAgreement("Encore Electric", "")).toBe("none");
  });
});

describe("classifyGoogleConfirmation with containment", () => {
  const phone = "253-555-0100";

  it("promotes a containment pair to phone_and_name when the phone agrees", () => {
    expect(
      classifyGoogleConfirmation({
        lniPhone: phone,
        googlePhone: "(253) 555-0100",
        lniName: "Encore Electric WA",
        googleName: "Encore Electric",
      }),
    ).toBe("phone_and_name");
  });

  it("leaves a one-token containment at phone_only", () => {
    expect(
      classifyGoogleConfirmation({
        lniPhone: phone,
        googlePhone: phone,
        lniName: "AECON TECHNICAL SERVICES",
        googleName: "AECON",
      }),
    ).toBe("phone_only");
  });

  it("does not let containment alone confirm without the phone", () => {
    expect(
      classifyGoogleConfirmation({
        lniPhone: "253-555-9999",
        googlePhone: phone,
        lniName: "Encore Electric WA",
        googleName: "Encore Electric",
      }),
    ).toBe("name_only");
  });

  it("still refuses an agreeing phone with an unrelated name", () => {
    // The 384 shared-switchboard links this lane exists to keep out.
    expect(
      classifyGoogleConfirmation({
        lniPhone: phone,
        googlePhone: phone,
        lniName: "Acme Roofing",
        googleName: "Puget Sound Answering Service",
      }),
    ).toBe("phone_only");
  });
});
