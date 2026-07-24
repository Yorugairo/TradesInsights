// Phase 0 — the L&I ↔ Google confirmation, and the circularity guard around it.
//
// The whole point of these tests is that "the phones match" is NOT the signal.
// Measured 2026-07-24: 2,962 of the 2,980 accepted links whose phones agree were
// created by `match_method='hard_identifier'`, which matched ON that phone, and
// 384 of them carry a Google name unrelated to the L&I name. The name is the
// independent axis; these tests pin that distinction down.
import { describe, expect, it } from "vitest";
import {
  buildRegistryIdentifierIndex,
  classifyGoogleConfirmation,
  gradeIdentifierComponent,
  IDENTIFIER_AGREES_WEAK,
  IDENTIFIER_CROSS_SOURCE_CONFIRMED,
  IDENTIFIER_ENTITY_TYPICAL,
  IDENTIFIER_ENTITY_WELL_PINNED,
  type RegistryIdentifierRow,
} from "./registry-identifiers.js";

const row = (
  entityId: string,
  identifierType: string,
  valueNormalized: string,
  isStrong = true,
): RegistryIdentifierRow => ({
  entityId,
  identifierType,
  valueNormalized,
  isStrong,
  sharedEntityCount: isStrong ? 1 : 2,
});

describe("classifyGoogleConfirmation", () => {
  // Live values. The Google name is NOT byte-identical to the L&I name — comma
  // and case differ — which is exactly why this compares through crossNameKey.
  const SMITH = {
    lniPhone: "2539261880",
    googlePhone: "(253) 926-1880",
    lniName: "Smith Fire Systems Inc",
    googleName: "Smith Fire Systems, INC",
  };

  it("confirms when BOTH the phone and the name agree", () => {
    expect(classifyGoogleConfirmation(SMITH)).toBe("phone_and_name");
  });

  it("normalizes phone formatting on both sides", () => {
    expect(classifyGoogleConfirmation({ ...SMITH, googlePhone: "+1 253-926-1880" })).toBe(
      "phone_and_name",
    );
  });

  it("reports phone_only when the name is UNRELATED — the circular case", () => {
    // 384 live links look like this: a shared switchboard, an answering service,
    // a franchise line. Scoring them as identity is the bug this prevents.
    expect(
      classifyGoogleConfirmation({ ...SMITH, googleName: "Puget Sound Answering Service" }),
    ).toBe("phone_only");
  });

  it("reports name_only when the phones differ", () => {
    expect(classifyGoogleConfirmation({ ...SMITH, googlePhone: "2065550000" })).toBe("name_only");
  });

  it("is none when the entity has no Google profile at all", () => {
    // Patriot Fire Protection Inc — a real Google listing exists, but it was
    // never fetched, so the registry holds nothing to corroborate against.
    expect(
      classifyGoogleConfirmation({
        lniPhone: "2539262290",
        googlePhone: null,
        lniName: "Patriot Fire Protection Inc",
        googleName: null,
      }),
    ).toBe("none");
  });

  it("does not treat a junk phone as agreement", () => {
    expect(classifyGoogleConfirmation({ ...SMITH, lniPhone: "253926", googlePhone: "253926" })).toBe(
      "name_only",
    );
  });
});

describe("cross-source values in the identifier index", () => {
  it("counts one value carried by TWO source types", () => {
    const index = buildRegistryIdentifierIndex([
      row("e1", "phone", "2539261880"),
      row("e1", "google_phone", "2539261880"),
    ]);
    expect(index.footprintByEntity.get("e1")?.crossSourceValues).toBe(1);
  });

  it("does NOT count two DIFFERENT values under two types", () => {
    const index = buildRegistryIdentifierIndex([
      row("e1", "phone", "2539261880"),
      row("e1", "google_phone", "2065550000"),
    ]);
    expect(index.footprintByEntity.get("e1")?.crossSourceValues).toBe(0);
  });

  it("excludes address — the two systems key addresses differently", () => {
    // Comparing STREET|POSTAL5 against a USPS-folded key would silently never
    // match, so address must never enter this comparison.
    const index = buildRegistryIdentifierIndex([
      row("e1", "address", "1106 54TH AVE E|98424"),
      row("e1", "phone", "1106 54TH AVE E|98424"),
    ]);
    expect(index.footprintByEntity.get("e1")?.crossSourceValues).toBe(0);
  });
});

describe("gradeIdentifierComponent with Google confirmation", () => {
  it("grades a confirmed entity above every footprint band", () => {
    const v = gradeIdentifierComponent({
      agreement: "none",
      footprint: { strong: 2, weak: 0, crossSourceValues: 1 },
      googleConfirmation: "phone_and_name",
    });
    expect(v).toBe(IDENTIFIER_CROSS_SOURCE_CONFIRMED);
    expect(v).toBeGreaterThan(IDENTIFIER_ENTITY_WELL_PINNED);
  });

  it("stays BELOW a real org-side identifier agreement", () => {
    // It attests the ENTITY is correctly identified, not that THIS org is it.
    expect(IDENTIFIER_CROSS_SOURCE_CONFIRMED).toBeLessThan(IDENTIFIER_AGREES_WEAK);
  });

  it("refuses to confirm on phone_only, however many identifiers exist", () => {
    expect(
      gradeIdentifierComponent({
        agreement: "none",
        footprint: { strong: 5, weak: 0, crossSourceValues: 1 },
        googleConfirmation: "phone_only",
      }),
    ).toBe(IDENTIFIER_ENTITY_WELL_PINNED);
  });

  it("refuses to confirm when the name agrees but no value is cross-source", () => {
    // Belt AND braces: the name check and the value check must both hold.
    expect(
      gradeIdentifierComponent({
        agreement: "none",
        footprint: { strong: 2, weak: 0, crossSourceValues: 0 },
        googleConfirmation: "phone_and_name",
      }),
    ).toBe(IDENTIFIER_ENTITY_TYPICAL);
  });
});
