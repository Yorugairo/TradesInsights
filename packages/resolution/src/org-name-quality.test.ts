import { describe, expect, it } from "vitest";
import { classifyOrgNameQuality, isOrgNameQuality } from "./org-name-quality.js";

describe("classifyOrgNameQuality", () => {
  it("classifies entity tokens as business", () => {
    expect(classifyOrgNameQuality("ACME CONSTRUCTION LLC")).toBe("business");
    expect(classifyOrgNameQuality("Puget Sound Roofing Services")).toBe("business");
    expect(classifyOrgNameQuality("HARBOR ELECTRIC INC")).toBe("business");
  });

  it("treats civic entities as business — they are real permit applicants", () => {
    expect(classifyOrgNameQuality("CITY OF TACOMA")).toBe("business");
    expect(classifyOrgNameQuality("PIERCE COUNTY")).toBe("business");
    expect(classifyOrgNameQuality("FIRST BAPTIST CHURCH")).toBe("business");
    expect(classifyOrgNameQuality("BETHEL SCHOOL DISTRICT")).toBe("business");
  });

  it("classifies a bare personal name as person_or_unknown, never junk", () => {
    // 3,528 production rows sit in this tier. Reading them as junk would
    // discard every sole proprietor in the graph.
    expect(classifyOrgNameQuality("JOHN SMITH")).toBe("person_or_unknown");
    expect(classifyOrgNameQuality("Maria Gutierrez")).toBe("person_or_unknown");
  });

  it("classifies placeholder text as junk", () => {
    expect(classifyOrgNameQuality("SAME AS OWNER")).toBe("junk");
    expect(classifyOrgNameQuality("TBD")).toBe("junk");
    expect(classifyOrgNameQuality("PER PLANS")).toBe("junk");
    expect(classifyOrgNameQuality("UNKNOWN")).toBe("junk");
    expect(classifyOrgNameQuality("N/A")).toBe("junk");
    expect(classifyOrgNameQuality("SEE APPLICATION")).toBe("junk");
  });

  it("junk beats business — the negative list wins on a collision", () => {
    // The ordering IS the spec: the old view ANDed all three predicates, so a
    // name failing the negative check was dropped no matter what it carried.
    expect(classifyOrgNameQuality("SAME AS OWNER LLC")).toBe("junk");
    expect(classifyOrgNameQuality("TBD CONSTRUCTION")).toBe("junk");
  });

  it("classifies a 3+ digit run as junk", () => {
    expect(classifyOrgNameQuality("PERMIT 20260190")).toBe("junk");
    expect(classifyOrgNameQuality("PARCEL 0320051042 OWNER")).toBe("junk");
    expect(classifyOrgNameQuality("555-1212")).toBe("junk");
  });

  it("leaves runs shorter than three digits alone", () => {
    expect(classifyOrgNameQuality("STUDIO 42 ARCHITECTS")).toBe("person_or_unknown");
    expect(classifyOrgNameQuality("24 HOUR PLUMBING LLC")).toBe("business");
  });

  it("honours the anchored alternatives — NA/OWNER/APPLICANT match only whole strings", () => {
    expect(classifyOrgNameQuality("NA")).toBe("junk");
    expect(classifyOrgNameQuality("OWNER")).toBe("junk");
    expect(classifyOrgNameQuality("APPLICANT")).toBe("junk");
    // …but a real company that merely starts with those letters is not junk.
    expect(classifyOrgNameQuality("NAVARRO CONSTRUCTION LLC")).toBe("business");
    expect(classifyOrgNameQuality("OWNERSHIP BUILDERS GROUP")).toBe("business");
  });

  it("only matches placeholders at the START of the name", () => {
    // `!~*` was anchored with `^`; a placeholder word buried mid-string never
    // disqualified a row and must not start doing so now.
    expect(classifyOrgNameQuality("SMITH HOMES TBD PHASE")).toBe("business");
  });

  it("treats an absent name as junk", () => {
    expect(classifyOrgNameQuality(null)).toBe("junk");
    expect(classifyOrgNameQuality(undefined)).toBe("junk");
    expect(classifyOrgNameQuality("")).toBe("junk");
    expect(classifyOrgNameQuality("   ")).toBe("junk");
  });
});

describe("isOrgNameQuality", () => {
  it("accepts the three tiers and nothing else", () => {
    expect(isOrgNameQuality("business")).toBe(true);
    expect(isOrgNameQuality("person_or_unknown")).toBe(true);
    expect(isOrgNameQuality("junk")).toBe(true);
    expect(isOrgNameQuality("BUSINESS")).toBe(false);
    expect(isOrgNameQuality("unknown")).toBe(false);
  });
});
