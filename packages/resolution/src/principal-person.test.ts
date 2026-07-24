import { describe, expect, it } from "vitest";
import {
  buildPrincipalPersonIndex,
  corePrincipalKey,
  matchPrincipalsToPeople,
  personCoreKey,
  type PersonCandidate,
} from "./principal-person.js";
import type { RegistryIdentityRow } from "./registry-link.js";

const row = (over: Partial<RegistryIdentityRow>): RegistryIdentityRow => ({
  entityId: "e1",
  ubi: null,
  contractorNumbers: null,
  canonicalName: "Acme",
  canonicalNameNormalized: "ACME",
  phone: null,
  cityToken: null,
  stateCode: "WA",
  registeredAddress: null,
  registeredPostalCode: null,
  ...over,
});

describe("personCoreKey", () => {
  it("reads L&I's `Last, First Middle` convention", () => {
    expect(personCoreKey("Mcmahon, James Thomas")).toBe("MCMAHON|JAMES");
  });

  it("reads permit data's `First Last` convention to the same key", () => {
    expect(personCoreKey("James Mcmahon")).toBe("MCMAHON|JAMES");
    expect(personCoreKey("James T Mcmahon")).toBe("MCMAHON|JAMES");
  });

  it("collapses the middle name entirely — permit data rarely carries one", () => {
    expect(personCoreKey("Erdahl, Darrin Paul")).toBe(personCoreKey("Erdahl, Darrin P"));
    expect(personCoreKey("Erdahl, Darrin Paul")).toBe(personCoreKey("Darrin Erdahl"));
  });

  it("folds punctuation into a single token", () => {
    expect(personCoreKey("O'Brien, Mary-Ann")).toBe("OBRIEN|MARYANN");
    expect(personCoreKey("Mary-Ann O'Brien")).toBe("OBRIEN|MARYANN");
  });

  it("drops generational suffixes", () => {
    expect(personCoreKey("Smith, John Jr")).toBe("SMITH|JOHN");
    expect(personCoreKey("John Smith Jr")).toBe("SMITH|JOHN");
  });

  // The governance gate: a business name must never reach the principal index.
  it.each([
    "Blue Flame Htg Air & Electric",
    "Erdahl Heating LLC",
    "Smith Plumbing",
    "Hathaway Construction Inc",
    "Bates & Ely Pllc",
    "Ct Corporation System",
    "The Barton Boys",
  ])("rejects the business-shaped name %j", (name) => {
    expect(personCoreKey(name)).toBeNull();
  });

  it("rejects names that are too short or too long to key on", () => {
    expect(personCoreKey("Erdahl")).toBeNull();
    expect(personCoreKey("Mary Jo Anne Beth Smith")).toBeNull();
  });

  it("returns null for empty and nullish input", () => {
    expect(personCoreKey(null)).toBeNull();
    expect(personCoreKey(undefined)).toBeNull();
    expect(personCoreKey("   ")).toBeNull();
    expect(personCoreKey("12345")).toBeNull();
  });
});

describe("corePrincipalKey", () => {
  it("narrows the registry's `SURNAME, GIVEN M` key", () => {
    expect(corePrincipalKey("ERDAHL, DARRIN P")).toBe("ERDAHL|DARRIN");
    expect(corePrincipalKey("MCMAHON, JAMES T")).toBe("MCMAHON|JAMES");
  });

  it("refuses an agent/org-shaped key (no comma) — never grouped", () => {
    expect(corePrincipalKey("CT CORPORATION SYSTEM")).toBeNull();
    expect(corePrincipalKey(null)).toBeNull();
  });
});

describe("buildPrincipalPersonIndex", () => {
  it("collects every entity a principal controls", () => {
    const index = buildPrincipalPersonIndex([
      row({ entityId: "e1", canonicalName: "Black Lion", principals: [{ name: "Erdahl, Darrin Paul", key: "ERDAHL, DARRIN P" }] }),
      row({ entityId: "e2", canonicalName: "Sturm Heating", principals: [{ name: "Erdahl, Darrin P", key: "ERDAHL, DARRIN P" }] }),
    ]);
    expect(index.byCoreKey.get("ERDAHL|DARRIN")?.map((e) => e.entityId)).toEqual(["e1", "e2"]);
  });

  it("records an entity once even when it files two spellings", () => {
    const index = buildPrincipalPersonIndex([
      row({
        entityId: "e1",
        principals: [
          { name: "Erdahl, Darrin Paul", key: "ERDAHL, DARRIN P" },
          { name: "Erdahl, Darrin", key: "ERDAHL, DARRIN" },
        ],
      }),
    ]);
    expect(index.byCoreKey.get("ERDAHL|DARRIN")).toHaveLength(1);
  });

  it("skips non-active entities and rows without principals", () => {
    const index = buildPrincipalPersonIndex([
      row({ entityId: "e1", status: "merged", principals: [{ name: "Smith, John", key: "SMITH, JOHN" }] }),
      row({ entityId: "e2", principals: null }),
    ]);
    expect(index.byCoreKey.size).toBe(0);
  });
});

describe("matchPrincipalsToPeople", () => {
  const index = buildPrincipalPersonIndex([
    row({ entityId: "e1", canonicalName: "Black Lion", principals: [{ name: "Erdahl, Darrin Paul", key: "ERDAHL, DARRIN P" }] }),
    row({ entityId: "e2", canonicalName: "Sturm Heating", principals: [{ name: "Erdahl, Darrin P", key: "ERDAHL, DARRIN P" }] }),
  ]);
  const candidate = (over: Partial<PersonCandidate>): PersonCandidate => ({
    source: "organization",
    organizationId: "o1",
    organizationName: "Darrin Erdahl",
    personName: "Darrin Erdahl",
    registryRef: null,
    ...over,
  });

  it("reaches every entity the person controls, across both name conventions", () => {
    const [match] = matchPrincipalsToPeople([candidate({})], index);
    expect(match?.coreKey).toBe("ERDAHL|DARRIN");
    expect(match?.entities.map((e) => e.entityName)).toEqual(["Black Lion", "Sturm Heating"]);
    expect(match?.alreadyBound).toBe(false);
  });

  it("flags a match that merely confirms an existing binding", () => {
    const [match] = matchPrincipalsToPeople([candidate({ registryRef: "e1" })], index);
    expect(match?.alreadyBound).toBe(true);
  });

  // The whole point of governance §3: a company name must not reach a person.
  it("never matches a business-shaped candidate", () => {
    expect(matchPrincipalsToPeople([candidate({ personName: "Erdahl Heating LLC" })], index)).toEqual([]);
  });

  it("returns nothing for a person the registry does not know", () => {
    expect(matchPrincipalsToPeople([candidate({ personName: "Jane Doe" })], index)).toEqual([]);
  });

  it("orders the widest new grouping first", () => {
    const wide = buildPrincipalPersonIndex([
      row({ entityId: "e1", principals: [{ name: "A, B", key: "A, B" }] }),
      row({ entityId: "e2", principals: [{ name: "A, B", key: "A, B" }] }),
      row({ entityId: "e3", principals: [{ name: "C, D", key: "C, D" }] }),
    ]);
    const matches = matchPrincipalsToPeople(
      [candidate({ personName: "D C" }), candidate({ personName: "B A" })],
      wide,
    );
    expect(matches.map((m) => m.coreKey)).toEqual(["A|B", "C|D"]);
  });
});
