import { describe, expect, it } from "vitest";
import {
  buildRegistryIndex,
  matchOrganizationToRegistry,
  normalizeIdentifier,
  type RegistryIdentityRow,
} from "./registry-link.js";

// A real registry row (Solis Interiors LLC as it appears in the live contract
// view: ubi 604837560, contractor SOLISIL785NT, entity 8a12a7cb…).
const SOLIS: RegistryIdentityRow = {
  entityId: "8a12a7cb-fb4b-4418-8378-def585ef88ff",
  ubi: "604837560",
  contractorNumbers: ["SOLISIL785NT"],
  canonicalName: "Solis Interiors LLC",
  phone: "3603508616",
};
const OTHER: RegistryIdentityRow = {
  entityId: "11111111-1111-1111-1111-111111111111",
  ubi: "601234567",
  contractorNumbers: ["OTHERCO123AB"],
  canonicalName: "Other Co LLC",
  phone: null,
};

describe("normalizeIdentifier", () => {
  it("uppercases and strips non-alphanumerics (matches registry normalization)", () => {
    expect(normalizeIdentifier(" 604-837-560 ")).toBe("604837560");
    expect(normalizeIdentifier("solisil785nt")).toBe("SOLISIL785NT");
    expect(normalizeIdentifier("")).toBeNull();
    expect(normalizeIdentifier(null)).toBeNull();
  });
});

describe("matchOrganizationToRegistry", () => {
  const index = buildRegistryIndex([SOLIS, OTHER]);

  it("binds by exact UBI (primary key, confidence 1.0)", () => {
    const out = matchOrganizationToRegistry({ ubi: "604837560", contractorRegistration: null }, index);
    expect(out).toEqual({
      kind: "matched",
      match: { entityId: SOLIS.entityId, method: "ubi_exact", confidence: 1, registryName: "Solis Interiors LLC" },
    });
  });

  it("normalizes before matching (formatted UBI still binds)", () => {
    const out = matchOrganizationToRegistry({ ubi: "604-837-560", contractorRegistration: null }, index);
    expect(out.kind).toBe("matched");
  });

  it("falls back to contractor number when UBI is absent", () => {
    const out = matchOrganizationToRegistry({ ubi: null, contractorRegistration: "solisil785nt" }, index);
    expect(out).toMatchObject({ kind: "matched", match: { entityId: SOLIS.entityId, method: "contractor_number_exact" } });
  });

  it("returns none when no strong identifier matches", () => {
    expect(matchOrganizationToRegistry({ ubi: "999999999", contractorRegistration: "NOPE" }, index)).toEqual({ kind: "none" });
    expect(matchOrganizationToRegistry({ ubi: null, contractorRegistration: null }, index)).toEqual({ kind: "none" });
  });

  it("never auto-binds when UBI and contractor number point at DIFFERENT entities", () => {
    const out = matchOrganizationToRegistry({ ubi: "604837560", contractorRegistration: "OTHERCO123AB" }, index);
    expect(out).toEqual({ kind: "conflict", ubiEntityId: SOLIS.entityId, contractorEntityId: OTHER.entityId });
  });

  it("UBI + agreeing contractor number binds to the shared entity", () => {
    const out = matchOrganizationToRegistry({ ubi: "604837560", contractorRegistration: "SOLISIL785NT" }, index);
    expect(out).toMatchObject({ kind: "matched", match: { entityId: SOLIS.entityId, method: "ubi_exact" } });
  });
});
