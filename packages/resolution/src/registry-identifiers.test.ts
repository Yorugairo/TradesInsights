import { describe, expect, it } from "vitest";
import {
  buildRegistryIdentifierIndex,
  EMPTY_IDENTIFIER_INDEX,
  fetchRegistryIdentifierRows,
  gradeIdentifierComponent,
  IDENTIFIER_AGREES_STRONG,
  IDENTIFIER_AGREES_WEAK,
  IDENTIFIER_CONTRADICTS,
  IDENTIFIER_ENTITY_SHARED_ONLY,
  IDENTIFIER_ENTITY_TYPICAL,
  IDENTIFIER_ENTITY_UNKNOWN,
  IDENTIFIER_ENTITY_WELL_PINNED,
  lookupIdentifier,
  type RegistryIdentifierRow,
} from "./registry-identifiers.js";

const row = (
  entityId: string,
  identifierType: string,
  valueNormalized: string,
  isStrong: boolean,
  sharedEntityCount = isStrong ? 1 : 2,
): RegistryIdentifierRow => ({
  entityId,
  identifierType,
  valueNormalized,
  isStrong,
  sharedEntityCount,
});

describe("buildRegistryIdentifierIndex", () => {
  it("counts only the promoted channels in an entity's footprint", () => {
    // ubi and contractor_number are excluded: every active entity has them by
    // construction, so counting them would add the same constant to everyone.
    const index = buildRegistryIdentifierIndex([
      row("e1", "ubi", "601234567", true),
      row("e1", "contractor_number", "MARRSH*123AB", true),
      row("e1", "phone", "3607344455", true),
      row("e1", "address", "1677 MT BAKER HWY|98226", true),
    ]);
    expect(index.footprintByEntity.get("e1")).toEqual({ strong: 2, weak: 0, crossSourceValues: 0 });
  });

  it("splits an entity's identifiers into unique and shared", () => {
    const index = buildRegistryIdentifierIndex([
      row("e1", "phone", "3607344455", true),
      row("e1", "address", "522 W RIVERSIDE AVE|99201", false, 14),
      row("e1", "root_domain", "marrsheating.com", true),
    ]);
    expect(index.footprintByEntity.get("e1")).toEqual({ strong: 2, weak: 1, crossSourceValues: 0 });
  });

  it("groups every entity sharing a value under one key", () => {
    const index = buildRegistryIdentifierIndex([
      row("e1", "address", "522 W RIVERSIDE AVE|99201", false, 2),
      row("e2", "address", "522 W RIVERSIDE AVE|99201", false, 2),
    ]);
    const found = lookupIdentifier(index, "address", "522 W RIVERSIDE AVE|99201");
    expect(found?.entityIds.sort()).toEqual(["e1", "e2"]);
    expect(found?.isStrong).toBe(false);
    expect(found?.sharedEntityCount).toBe(2);
  });

  it("distinguishes an unknown value from a shared one", () => {
    const index = buildRegistryIdentifierIndex([row("e1", "phone", "3607344455", true)]);
    expect(lookupIdentifier(index, "phone", "2065550000")).toBeNull();
    expect(lookupIdentifier(index, "phone", "3607344455")?.isStrong).toBe(true);
  });

  it("keys by type as well as value, so a phone never matches a place id", () => {
    const index = buildRegistryIdentifierIndex([row("e1", "phone", "3607344455", true)]);
    expect(lookupIdentifier(index, "google_phone", "3607344455")).toBeNull();
  });
});

describe("gradeIdentifierComponent", () => {
  const fp = (strong: number, weak: number, crossSourceValues = 0) => ({
    strong,
    weak,
    crossSourceValues,
  });

  it("scores agreement with a unique identifier as proof", () => {
    expect(gradeIdentifierComponent({ agreement: "strong", footprint: fp(5, 0) })).toBe(
      IDENTIFIER_AGREES_STRONG,
    );
  });

  it("scores agreement with a SHARED identifier below proof but well above none", () => {
    // The other entities carrying the value remain live alternatives.
    const weak = gradeIdentifierComponent({ agreement: "weak", footprint: fp(1, 1) });
    expect(weak).toBe(IDENTIFIER_AGREES_WEAK);
    expect(weak).toBeLessThan(IDENTIFIER_AGREES_STRONG);
    expect(weak).toBeGreaterThan(IDENTIFIER_ENTITY_WELL_PINNED);
  });

  it("zeroes a contradiction regardless of how well-attested the entity is", () => {
    expect(gradeIdentifierComponent({ agreement: "contradicts", footprint: fp(6, 0) })).toBe(
      IDENTIFIER_CONTRADICTS,
    );
  });

  describe("with no org-side evidence, falls back to entity footprint", () => {
    it("rates a well-pinned entity above the old flat neutral", () => {
      const v = gradeIdentifierComponent({ agreement: "none", footprint: fp(5, 0) });
      expect(v).toBe(IDENTIFIER_ENTITY_WELL_PINNED);
      expect(v).toBeGreaterThan(IDENTIFIER_ENTITY_TYPICAL);
    });

    it("keeps a typical entity at the old neutral", () => {
      expect(gradeIdentifierComponent({ agreement: "none", footprint: fp(2, 0) })).toBe(
        IDENTIFIER_ENTITY_TYPICAL,
      );
      expect(gradeIdentifierComponent({ agreement: "none", footprint: fp(1, 0) })).toBe(
        IDENTIFIER_ENTITY_TYPICAL,
      );
    });

    it("rates an entity with only SHARED identifiers below neutral", () => {
      // It sits in a bucket with the very companies it could be confused for.
      const v = gradeIdentifierComponent({ agreement: "none", footprint: fp(0, 2) });
      expect(v).toBe(IDENTIFIER_ENTITY_SHARED_ONLY);
      expect(v).toBeLessThan(IDENTIFIER_ENTITY_TYPICAL);
    });

    it("rates an entity we know nothing about lowest", () => {
      expect(gradeIdentifierComponent({ agreement: "none", footprint: null })).toBe(
        IDENTIFIER_ENTITY_UNKNOWN,
      );
      expect(gradeIdentifierComponent({ agreement: "none", footprint: fp(0, 0) })).toBe(
        IDENTIFIER_ENTITY_UNKNOWN,
      );
    });

    it("orders the fallback bands strictly", () => {
      expect(IDENTIFIER_ENTITY_UNKNOWN).toBeLessThan(IDENTIFIER_ENTITY_SHARED_ONLY);
      expect(IDENTIFIER_ENTITY_SHARED_ONLY).toBeLessThan(IDENTIFIER_ENTITY_TYPICAL);
      expect(IDENTIFIER_ENTITY_TYPICAL).toBeLessThan(IDENTIFIER_ENTITY_WELL_PINNED);
    });
  });

  it("never leaves [0,1]", () => {
    for (const agreement of ["strong", "weak", "contradicts", "none"] as const) {
      const v = gradeIdentifierComponent({ agreement, footprint: fp(9, 9) });
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("fetchRegistryIdentifierRows", () => {
  it("degrades to empty when the view is not deployed yet (42P01)", async () => {
    const pool = {
      query: async () => {
        throw Object.assign(new Error("relation does not exist"), { code: "42P01" });
      },
    };
    await expect(fetchRegistryIdentifierRows(pool)).resolves.toEqual([]);
  });

  it("RETHROWS a permission error — it must never look like 'no identifiers'", async () => {
    // Swallowing 42501 would silently flatten every score back to the unknown
    // band while looking healthy, which is the failure mode this guards.
    const pool = {
      query: async () => {
        throw Object.assign(new Error("permission denied"), { code: "42501" });
      },
    };
    await expect(fetchRegistryIdentifierRows(pool)).rejects.toThrow(/permission denied/);
  });

  it("coerces the contract row shape", async () => {
    const pool = {
      query: async () => ({
        rows: [
          {
            entity_id: "e1",
            identifier_type: "phone",
            value_normalized: "3607344455",
            is_strong: true,
            shared_entity_count: 1,
          },
        ],
      }),
    };
    await expect(fetchRegistryIdentifierRows(pool)).resolves.toEqual([
      {
        entityId: "e1",
        identifierType: "phone",
        valueNormalized: "3607344455",
        isStrong: true,
        sharedEntityCount: 1,
      },
    ]);
  });
});

describe("EMPTY_IDENTIFIER_INDEX", () => {
  it("yields the unknown band rather than inventing agreement", () => {
    expect(EMPTY_IDENTIFIER_INDEX.size).toBe(0);
    expect(lookupIdentifier(EMPTY_IDENTIFIER_INDEX, "phone", "3607344455")).toBeNull();
    expect(
      gradeIdentifierComponent({
        agreement: "none",
        footprint: EMPTY_IDENTIFIER_INDEX.footprintByEntity.get("e1") ?? null,
      }),
    ).toBe(IDENTIFIER_ENTITY_UNKNOWN);
  });
});
