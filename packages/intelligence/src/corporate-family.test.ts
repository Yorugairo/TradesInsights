import { describe, expect, it } from "vitest";
import type { Db } from "@otn/db";
import type { PersonCandidate, RegistryIdentityRow } from "@otn/resolution";
import {
  MAX_FAMILY_ENTITIES,
  buildCorporateFamilySnapshot,
  buildFamilies,
  corporateFamilyCounts,
  deriveCorporateFamilies,
} from "./corporate-family.js";

const row = (
  entityId: string,
  canonicalName: string,
  principals: { name: string; key: string }[] | null,
  over: Partial<RegistryIdentityRow> = {},
): RegistryIdentityRow => ({
  entityId,
  ubi: null,
  contractorNumbers: null,
  canonicalName,
  canonicalNameNormalized: canonicalName.toUpperCase(),
  phone: null,
  cityToken: null,
  stateCode: "WA",
  registeredAddress: null,
  registeredPostalCode: null,
  principals,
  ...over,
});

const ERDAHL_PAUL = { name: "Erdahl, Darrin Paul", key: "ERDAHL, DARRIN P" };
const ERDAHL_P = { name: "Erdahl, Darrin P", key: "ERDAHL, DARRIN P" };

describe("buildFamilies", () => {
  it("groups entities sharing a principal, across spelling variants", () => {
    const { families } = buildFamilies([
      row("e1", "Black Lion Heating", [ERDAHL_PAUL]),
      row("e2", "Sturm Heating", [ERDAHL_P]),
    ]);
    expect(families).toHaveLength(1);
    expect(families[0]?.entityIds).toEqual(["e1", "e2"]);
    // The FULL registry key — registry-side normalization already folded
    // `Darrin Paul` to `Darrin P`, so both spellings land on one family.
    expect(families[0]?.familyId).toBe("ERDAHL, DARRIN P");
    // Both raw spellings are kept for review; neither is treated as canonical.
    expect(families[0]?.principalNames).toEqual(["Erdahl, Darrin P", "Erdahl, Darrin Paul"]);
  });

  // The regression this fix exists for. Grouping on the coarse `SURNAME|GIVEN`
  // key merged Michael Lane Moore (Crofton MD) with Michael F Moore (Ephrata WA)
  // — 463 of 912 live entity pairs carried exactly this conflict.
  it("does NOT merge two people who differ only by middle initial", () => {
    const { families } = buildFamilies([
      row("mf", "Moore Furniture Inc", [{ name: "Moore, Michael F", key: "MOORE, MICHAEL F" }]),
      row("gg", "Gill Group Inc", [{ name: "Moore, Michael Lane", key: "MOORE, MICHAEL L" }]),
    ]);
    expect(families).toEqual([]);
  });

  it("carries per-pair corroboration so a reviewer sees what else agrees", () => {
    const { families } = buildFamilies([
      row("e1", "Pompa Electric", [{ name: "Pompa, Natalie", key: "POMPA, NATALIE" }], {
        phone: "2535550100", cityToken: "renton", tradeCodes: ["electrical"],
      }),
      row("e2", "Pompa Heating", [{ name: "Pompa, Natalie", key: "POMPA, NATALIE" }], {
        phone: "(253) 555-0100", cityToken: "renton", tradeCodes: ["electrical", "hvac"],
      }),
    ]);
    const [pair] = families[0]!.pairs;
    expect(families[0]?.pairs).toHaveLength(1);
    expect(pair?.corroboration.points).toBe(3);
    expect(pair?.corroboration.verdict).toBe("strong");
    expect(families[0]?.minPoints).toBe(3);
  });

  it("reports the WEAKEST pair, so one unproven link is not hidden by a strong one", () => {
    const p = { name: "Big, Family", key: "BIG, FAMILY" };
    const { families } = buildFamilies([
      row("e1", "One", [p], { phone: "2535550100", cityToken: "renton" }),
      row("e2", "Two", [p], { phone: "2535550100", cityToken: "renton" }),
      row("e3", "Three", [p], { phone: null, cityToken: "spokane" }),
    ]);
    expect(families[0]?.pairs).toHaveLength(3);
    expect(families[0]?.minPoints).toBe(0);
  });

  it("does not treat a lone entity as a family", () => {
    // Every entity has a principal, so one-member groups would return the whole
    // registry as ~25,000 "families".
    expect(buildFamilies([row("e1", "Solo Plumbing", [ERDAHL_PAUL])]).families).toEqual([]);
  });

  it("forms no family from an entity whose only principal is an agent", () => {
    // Agents are filtered registry-side, but a comma-less key that slipped
    // through must still be refused here — corePrincipalKey rejects it.
    const { families } = buildFamilies([
      row("e1", "Blue Flame", [{ name: "Ct Corporation System", key: "CT CORPORATION SYSTEM" }]),
      row("e2", "Rescue Rooter", [{ name: "Ct Corporation System", key: "CT CORPORATION SYSTEM" }]),
    ]);
    expect(families).toEqual([]);
  });

  it("keeps the officer when an entity files both an officer and an agent", () => {
    const { families } = buildFamilies([
      row("e1", "Blue Flame", [
        { name: "Ct Corporation System", key: "CT CORPORATION SYSTEM" },
        { name: "Mcmahon, James Thomas", key: "MCMAHON, JAMES T" },
      ]),
      row("e2", "Rescue Rooter", [{ name: "Mcmahon, James T", key: "MCMAHON, JAMES T" }]),
    ]);
    expect(families).toHaveLength(1);
    expect(families[0]?.familyId).toBe("MCMAHON, JAMES T");
    expect(families[0]?.entityIds).toEqual(["e1", "e2"]);
  });

  it("transitively joins two officers who share a company", () => {
    // A controls e1+e2, B controls e2+e3 → one family of three, not two of two.
    const { families } = buildFamilies([
      row("e1", "One", [{ name: "A, Ann", key: "A, ANN" }]),
      row("e2", "Two", [{ name: "A, Ann", key: "A, ANN" }, { name: "B, Bob", key: "B, BOB" }]),
      row("e3", "Three", [{ name: "B, Bob", key: "B, BOB" }]),
    ]);
    expect(families).toHaveLength(1);
    expect(families[0]?.entityIds).toEqual(["e1", "e2", "e3"]);
    expect(families[0]?.principalKeys).toEqual(["A, ANN", "B, BOB"]);
  });

  it("DROPS an over-cap group rather than truncating it", () => {
    // A truncated family reads as a small true one; a dropped one is visible.
    const many = Array.from({ length: MAX_FAMILY_ENTITIES + 1 }, (_, i) =>
      row(`e${i}`, `Co ${i}`, [{ name: "Agentish, Sneaky", key: "AGENTISH, SNEAKY" }]),
    );
    const { families, dropped } = buildFamilies(many);
    expect(families).toEqual([]);
    expect(dropped).toEqual([{ principalKey: "AGENTISH, SNEAKY", entityCount: MAX_FAMILY_ENTITIES + 1 }]);
  });

  it("keeps a group exactly at the cap", () => {
    const many = Array.from({ length: MAX_FAMILY_ENTITIES }, (_, i) =>
      row(`e${i}`, `Co ${i}`, [{ name: "Big, Family", key: "BIG, FAMILY" }]),
    );
    const { families, dropped } = buildFamilies(many);
    expect(families).toHaveLength(1);
    expect(dropped).toEqual([]);
  });

  it("ignores non-active entities and rows carrying no principals", () => {
    const { families } = buildFamilies([
      row("e1", "Merged Co", [ERDAHL_PAUL], { status: "merged" }),
      row("e2", "Live Co", [ERDAHL_P]),
      row("e3", "No Principals", null),
    ]);
    expect(families).toEqual([]);
  });

  it("returns empty for an older contract with no principals column at all", () => {
    expect(buildFamilies([row("e1", "A", null), row("e2", "B", null)])).toEqual({
      families: [],
      dropped: [],
    });
  });

  it("orders the largest family first", () => {
    const { families } = buildFamilies([
      row("e1", "One", [{ name: "S, Small", key: "S, SMALL" }]),
      row("e2", "Two", [{ name: "S, Small", key: "S, SMALL" }]),
      row("e3", "Three", [ERDAHL_PAUL]),
      row("e4", "Four", [ERDAHL_PAUL]),
      row("e5", "Five", [ERDAHL_P]),
    ]);
    expect(families.map((f) => f.entityIds.length)).toEqual([3, 2]);
  });
});

// ── Materialised snapshot (0037) ─────────────────────────────────────────────

const candidate = (personName: string, over: Partial<PersonCandidate> = {}): PersonCandidate => ({
  source: "organization",
  organizationId: "org-1",
  organizationName: personName,
  personName,
  registryRef: null,
  jurisdictions: [],
  projectCount: 0,
  role: null,
  sourceUrl: null,
  ...over,
});

/** e1+e2 form a family; e3 matches the candidate; e4 is referenced by nothing. */
const SNAPSHOT_ROWS = [
  row("e1", "Black Lion Heating", [ERDAHL_PAUL]),
  row("e2", "Sturm Heating", [ERDAHL_P]),
  row("e3", "Solo Ventures LLC", [{ name: "Solo, Pat", key: "SOLO, PAT" }]),
  row("e4", "Unreferenced Co", [{ name: "Nobody, New", key: "NOBODY, NEW" }]),
];

describe("buildCorporateFamilySnapshot", () => {
  it("trims identity rows to the entities families and pairs actually reference", () => {
    const snapshot = buildCorporateFamilySnapshot(
      SNAPSHOT_ROWS,
      [candidate("Pat Solo")],
      "2026-07-28T00:00:00.000Z",
    );
    expect(snapshot.families).toHaveLength(1);
    expect(snapshot.pairs).toHaveLength(1);
    expect(snapshot.pairs[0]?.entity.entityId).toBe("e3");
    // e1/e2 via the family, e3 via the pair — e4 is displayable by nothing.
    expect(snapshot.rows.map((r) => r.entityId).sort()).toEqual(["e1", "e2", "e3"]);
    expect(snapshot.derivedAt).toBe("2026-07-28T00:00:00.000Z");
  });

  it("counts pairsNew from unbound pairs only", () => {
    const snapshot = buildCorporateFamilySnapshot(
      SNAPSHOT_ROWS,
      // Second candidate is ALREADY BOUND to the entity it matches — it merely
      // confirms an existing binding, so it must not count as new.
      [candidate("Pat Solo"), candidate("New Nobody", { organizationId: "org-2", registryRef: "e4" })],
      "2026-07-28T00:00:00.000Z",
    );
    const counts = corporateFamilyCounts(snapshot);
    expect(counts.familyCount).toBe(1);
    expect(snapshot.pairs).toHaveLength(2);
    expect(counts.pairsNew).toBe(1);
    expect(counts.pairsStrong).toBeLessThanOrEqual(counts.pairsNew);
  });

  it("survives the jsonb round trip unchanged — the shape the tables store", () => {
    // What 0037 persists is JSON.stringify(snapshot parts); what the web reads
    // back is the parsed jsonb. If a Date, class instance, or other non-JSON
    // value ever creeps into these types, the persisted snapshot silently stops
    // matching the derived one — this is the tripwire.
    const snapshot = buildCorporateFamilySnapshot(
      SNAPSHOT_ROWS,
      [candidate("Pat Solo")],
      "2026-07-28T00:00:00.000Z",
    );
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });
});

describe("deriveCorporateFamilies — never write a zero on failure", () => {
  /** A Db whose every use throws: proves the skip paths write NOTHING. */
  const untouchableDb = new Proxy(
    {},
    {
      get(_t, prop) {
        throw new Error(`db.${String(prop)} must not be touched on a skip`);
      },
    },
  ) as unknown as Db;

  it("seam offline (null rows) ⇒ skips without touching the database", async () => {
    const result = await deriveCorporateFamilies(untouchableDb, null);
    expect(result.skipped).toBe("seam_offline");
  });

  it("EMPTY identity view ⇒ skips — zero rows is a seam fault, not a registry state", async () => {
    const result = await deriveCorporateFamilies(untouchableDb, []);
    expect(result.skipped).toBe("empty_view");
  });
});
