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

  // ONE ROW PER (person, entity). Person-level rows put a plausible match and a
  // collision in the same cell under one verdict, which is what made the queue
  // unreadable.
  it("emits one pair per entity the person reaches", () => {
    const pairs = matchPrincipalsToPeople([candidate({})], index);
    expect(pairs).toHaveLength(2);
    expect(pairs.map((p) => p.entity.entityName).sort()).toEqual(["Black Lion", "Sturm Heating"]);
    expect(pairs.every((p) => p.coreKey === "ERDAHL|DARRIN")).toBe(true);
    expect(pairs.every((p) => p.alreadyBound === false)).toBe(true);
  });

  it("flags only the pair that confirms an existing binding", () => {
    const pairs = matchPrincipalsToPeople([candidate({ registryRef: "e1" })], index);
    expect(pairs.filter((p) => p.alreadyBound).map((p) => p.entity.entityId)).toEqual(["e1"]);
  });

  // The whole point of governance §1: a company name must not reach a person.
  it("never matches a business-shaped candidate", () => {
    expect(matchPrincipalsToPeople([candidate({ personName: "Erdahl Heating LLC" })], index)).toEqual([]);
  });

  // The denylist can never be finished; the allowlist is what makes it sound.
  // `CHEHALIS SHEET METAL` shipped past an earlier denylist in live data.
  it("rejects a business whose words are not on the denylist, via the surname allowlist", () => {
    const stray = buildPrincipalPersonIndex([
      row({ entityId: "e1", principals: [{ name: "Erdahl, Darrin P", key: "ERDAHL, DARRIN P" }] }),
    ]);
    // "PACIFIC" is not an L&I principal surname, so the name cannot be keyed.
    expect(personCoreKey("Esco Pacific", stray.surnames)).toBeNull();
    expect(matchPrincipalsToPeople([candidate({ personName: "Esco Pacific" })], stray)).toEqual([]);
  });

  it("returns nothing for a person the registry does not know", () => {
    expect(matchPrincipalsToPeople([candidate({ personName: "Jane Doe" })], index)).toEqual([]);
  });

  // The Moore Furniture / Gill Group case, from the Insights side.
  it("marks a middle-initial disagreement as contradicted", () => {
    const moore = buildPrincipalPersonIndex([
      row({ entityId: "e1", canonicalName: "Gill Group Inc", principals: [{ name: "Moore, Michael Lane", key: "MOORE, MICHAEL L" }] }),
    ]);
    const [pair] = matchPrincipalsToPeople(
      [candidate({ personName: "Michael F Moore" })],
      moore,
    );
    expect(pair?.verdict).toBe("contradicted");
    expect(pair?.explanation).toContain("different person of the same name");
    expect(pair?.signals.find((s) => s.key === "middle_initial")?.agrees).toBe(false);
  });

  it("counts namesakes and demotes a common name", () => {
    const common = buildPrincipalPersonIndex([
      row({ entityId: "e1", canonicalName: "A + Painting", principals: [{ name: "Stewart, James A", key: "STEWART, JAMES A" }] }),
      row({ entityId: "e2", canonicalName: "Security 101", principals: [{ name: "Stewart, James B", key: "STEWART, JAMES B" }] }),
      row({ entityId: "e3", canonicalName: "Stewart Fire", principals: [{ name: "Stewart, James C", key: "STEWART, JAMES C" }] }),
    ]);
    const [pair] = matchPrincipalsToPeople([candidate({ personName: "James Stewart" })], common);
    expect(pair?.namesakes).toBe(3);
    expect(pair?.signals.find((s) => s.key === "common_name")?.agrees).toBe(false);
  });

  it("credits a unique name, a surname echo, city agreement, and a contractor role", () => {
    const [pair] = matchPrincipalsToPeople(
      [candidate({
        personName: "Natalie Pompa",
        jurisdictions: ["City of Renton"],
        role: "primary_contractor",
      })],
      buildPrincipalPersonIndex([
        row({ entityId: "e1", canonicalName: "Pompa Electric", cityToken: "renton",
              principals: [{ name: "Pompa, Natalie", key: "POMPA, NATALIE" }] }),
      ]),
    );
    expect(pair?.verdict).toBe("strong");
    expect(pair?.points).toBe(4);
    expect(pair?.signals.map((s) => s.key)).toEqual(["unique_name", "surname_echo", "city", "role"]);
  });

  it("ranks well-corroborated pairs above contradicted ones", () => {
    const mixed = buildPrincipalPersonIndex([
      row({ entityId: "e1", canonicalName: "Pompa Electric", principals: [{ name: "Pompa, Natalie", key: "POMPA, NATALIE" }] }),
      row({ entityId: "e2", canonicalName: "Gill Group Inc", principals: [{ name: "Moore, Michael Lane", key: "MOORE, MICHAEL L" }] }),
    ]);
    const pairs = matchPrincipalsToPeople(
      [candidate({ personName: "Michael F Moore" }), candidate({ personName: "Natalie Pompa" })],
      mixed,
    );
    expect(pairs.map((p) => p.verdict)).toEqual(["corroborated", "contradicted"]);
  });
});
