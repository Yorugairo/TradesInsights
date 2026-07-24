import { describe, expect, it } from "vitest";
import {
  claimTypeForFactPath,
  classifyClaim,
  GRADE_A_CONFIDENCE,
  GRADE_B_CONFIDENCE,
  GRADE_C_CONFIDENCE,
  isKnownFactPath,
} from "./opportunity-evidence.js";

/** Every distinct fact_path measured live on 2026-07-24, with its row count. */
const MEASURED_FACT_PATHS = [
  ["statusRaw", "stage"],
  ["title", "identity"],
  ["externalRef", "identity"],
  ["externalId", "identity"],
  ["parcelIds", "geography"],
  ["addressRaw", "geography"],
  ["geometry", "geography"],
  ["organizations", "organization_role"],
  ["valuationUsd", "value"],
  ["issueDate", "event_date"],
  ["applicationDate", "event_date"],
  ["documentType", "other"],
  ["description", "other"],
  ["sourceUpdatedAt", "other"],
  ["units", "other"],
  ["applicationType", "other"],
  ["lots", "other"],
] as const;

describe("claimTypeForFactPath", () => {
  it.each(MEASURED_FACT_PATHS)("types %s as %s", (factPath, expected) => {
    expect(claimTypeForFactPath(factPath)).toBe(expected);
  });

  it("maps the whole links.* namespace to other without enumerating it", () => {
    // New portals appear routinely; an unlisted one must not read as a claim.
    expect(claimTypeForFactPath("links.permits")).toBe("other");
    expect(claimTypeForFactPath("links.open_data_portal")).toBe("other");
    expect(claimTypeForFactPath("links.a_portal_that_does_not_exist_yet")).toBe("other");
  });

  it("falls back to other for an unrecognised path rather than guessing", () => {
    expect(claimTypeForFactPath("someFieldInventedNextQuarter")).toBe("other");
  });

  it("tolerates surrounding whitespace", () => {
    expect(claimTypeForFactPath("  issueDate  ")).toBe("event_date");
  });
});

describe("claim typing refuses to over-claim", () => {
  it("does NOT treat sourceUpdatedAt as an event date", () => {
    // It is when the SOURCE republished the row, not when anything happened on
    // the project. Typing it as an event date would let a digest present a
    // scrape timestamp as a permit date or a deadline.
    expect(claimTypeForFactPath("sourceUpdatedAt")).not.toBe("event_date");
    expect(claimTypeForFactPath("sourceUpdatedAt")).toBe("other");
  });

  it("does NOT treat unit or lot counts as value", () => {
    // `value` is money. A 78-unit count must never stand as support for a
    // dollar figure the source never stated.
    expect(claimTypeForFactPath("units")).not.toBe("value");
    expect(claimTypeForFactPath("lots")).not.toBe("value");
    expect(claimTypeForFactPath("valuationUsd")).toBe("value");
  });
});

describe("isKnownFactPath", () => {
  it("separates known-but-ungated evidence from an unseen schema", () => {
    // Both type as `other`; only the second signals a source schema change.
    expect(isKnownFactPath("documentType")).toBe(true);
    expect(isKnownFactPath("someFieldInventedNextQuarter")).toBe(false);
  });

  it("counts any links.* path as known", () => {
    expect(isKnownFactPath("links.whatever")).toBe(true);
  });
});

describe("classifyClaim — authority grades", () => {
  it("confirms grade A and carries its confidence", () => {
    const result = classifyClaim({ factPath: "issueDate", authorityGrade: "A" });
    expect(result).toEqual({
      linkable: true,
      claimType: "event_date",
      confirmed: true,
      confidence: GRADE_A_CONFIDENCE,
    });
  });

  it("links grade B but never marks it confirmed", () => {
    // An official company page is real evidence; the gate still requires an
    // A-grade source for the core event.
    const result = classifyClaim({ factPath: "valuationUsd", authorityGrade: "B" });
    expect(result).toEqual({
      linkable: true,
      claimType: "value",
      confirmed: false,
      confidence: GRADE_B_CONFIDENCE,
    });
  });

  it("links grade C but never confirms it alone", () => {
    const result = classifyClaim({ factPath: "statusRaw", authorityGrade: "C" });
    expect(result).toEqual({
      linkable: true,
      claimType: "stage",
      confirmed: false,
      confidence: GRADE_C_CONFIDENCE,
    });
  });

  it("refuses grade D outright — discovery only, never publishable", () => {
    expect(classifyClaim({ factPath: "title", authorityGrade: "D" })).toEqual({
      linkable: false,
      reason: "discovery_only_grade",
    });
  });

  it("fails closed on an unrecognised grade instead of defaulting", () => {
    // Defaulting means guessing how much authority an unknown source deserves.
    expect(classifyClaim({ factPath: "title", authorityGrade: "F" })).toEqual({
      linkable: false,
      reason: "unknown_grade",
    });
    expect(classifyClaim({ factPath: "title", authorityGrade: "" })).toEqual({
      linkable: false,
      reason: "unknown_grade",
    });
  });

  it("normalises grade case and whitespace", () => {
    const result = classifyClaim({ factPath: "title", authorityGrade: " a " });
    expect(result).toEqual({
      linkable: true,
      claimType: "identity",
      confirmed: true,
      confidence: GRADE_A_CONFIDENCE,
    });
  });

  it("keeps the grade branches independent of the claim type", () => {
    // A grade-D row is refused whatever it would have supported, so no
    // fact_path can smuggle discovery-only data into the payload.
    for (const [factPath] of MEASURED_FACT_PATHS) {
      expect(classifyClaim({ factPath, authorityGrade: "D" })).toEqual({
        linkable: false,
        reason: "discovery_only_grade",
      });
    }
  });
});
