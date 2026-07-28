/**
 * Unit tests for the shared domain formatters.
 *
 * The interesting cases are all the absent ones. Every formatter here sits
 * between a nullable database column and an operator's decision, and the whole
 * class of bug worth defending against is an absent value rendering as a
 * confident one — `null` score as `0`, absent valuation as `$0`.
 */

import { describe, expect, test } from "vitest";

import { UNKNOWN, bandLabel, bandTone, formatScore, formatValuation, routeLabel, stageLabel } from "./format.js";

describe("formatScore", () => {
  test("renders a score as a whole number", () => {
    expect(formatScore(81.4)).toBe("81");
    expect(formatScore(0)).toBe("0");
  });

  test("renders an absent score as unknown, never as zero", () => {
    // `0` would sort and read as "we scored this and it failed". `null` means
    // the scorer has not run.
    expect(formatScore(null)).toBe(UNKNOWN);
    expect(formatScore(undefined)).toBe(UNKNOWN);
  });
});

describe("formatValuation", () => {
  test("abbreviates at the millions and thousands boundaries", () => {
    expect(formatValuation(2_400_000)).toBe("$2.4M");
    expect(formatValuation(1_000_000)).toBe("$1.0M");
    expect(formatValuation(85_000)).toBe("$85k");
    expect(formatValuation(1_000)).toBe("$1k");
    expect(formatValuation(420)).toBe("$420");
  });

  test("renders an absent valuation as unknown, never as $0", () => {
    expect(formatValuation(null)).toBe(UNKNOWN);
    expect(formatValuation(undefined)).toBe(UNKNOWN);
  });

  test("a stated zero valuation is a real datum and renders as one", () => {
    expect(formatValuation(0)).toBe("$0");
  });
});

describe("bandLabel", () => {
  test("maps stored band codes to the operator's words", () => {
    expect(bandLabel("priority_review")).toBe("Priority review");
    expect(bandLabel("weekly_digest")).toBe("Weekly digest");
  });

  test("degrades an unmapped code to readable text rather than hiding it", () => {
    // A new band added by a migration must still render. Swallowing it would
    // make a row look bandless.
    expect(bandLabel("some_new_band")).toBe("some new band");
  });
});

describe("bandTone", () => {
  test("only the bands awaiting or carrying a decision are loud", () => {
    expect(bandTone("priority_review")).toBe("green");
    expect(bandTone("promoted")).toBe("green");
    expect(bandTone("weekly_digest")).toBe("amber");
    expect(bandTone("dismissed")).toBe("red");
    expect(bandTone("archive")).toBe("gray");
  });
});

describe("stageLabel / routeLabel", () => {
  test("unsnake stored codes", () => {
    expect(stageLabel("permit_issued")).toBe("permit issued");
    expect(routeLabel("gc_relationship_radar")).toBe("gc relationship radar");
  });

  test("absent route means the scorer never assigned a lane", () => {
    expect(routeLabel(null)).toBe(UNKNOWN);
    expect(stageLabel(null)).toBe(UNKNOWN);
  });
});
