import { describe, expect, it } from "vitest";
import type { Db } from "@otn/db";
import type { EntityCorroboration } from "./entity-corroboration.js";
import { recordRelationshipAcceptance, relationshipDedupeKey } from "./registry-observations.js";

const CORROB: EntityCorroboration = {
  points: 3,
  verdict: "strong",
  signals: [{ key: "ubi", label: "same UBI 601234567", agrees: true }],
  explanation: "same UBI",
};

describe("relationshipDedupeKey", () => {
  it("is independent of argument order", () => {
    expect(relationshipDedupeKey("b-entity", "a-entity")).toBe(relationshipDedupeKey("a-entity", "b-entity"));
    expect(relationshipDedupeKey("a-entity", "b-entity")).toBe("relationship:a-entity:b-entity");
  });
});

describe("recordRelationshipAcceptance", () => {
  it("inserts an accepted row, then dedupes a swapped-order replay with no duplicate", async () => {
    const calls: unknown[] = [];
    // 1st call = INSERT … RETURNING (new row); 2nd = replay INSERT hits ON
    // CONFLICT DO NOTHING (0 rows); 3rd = the follow-up SELECT for the existing id.
    const responses = [{ rows: [{ id: "obs-1" }] }, { rows: [] }, { rows: [{ id: "obs-1" }] }];
    let i = 0;
    const db = {
      execute: async (q: unknown) => {
        calls.push(q);
        return responses[i++] ?? { rows: [] };
      },
    } as unknown as Db;

    const first = await recordRelationshipAcceptance(db, {
      organizationId: "org-1",
      entityIdA: "a-entity",
      entityIdB: "b-entity",
      principalKey: "SMITH, JOHN",
      corroboration: CORROB,
      decidedBy: "web:test",
    });
    expect(first).toEqual({ id: "obs-1", alreadyExisted: false });

    // Same pair, opposite order, different anchor org — one canonical claim.
    const replay = await recordRelationshipAcceptance(db, {
      organizationId: "org-9",
      entityIdA: "b-entity",
      entityIdB: "a-entity",
      corroboration: CORROB,
      decidedBy: "web:test",
    });
    expect(replay).toEqual({ id: "obs-1", alreadyExisted: true });
    // 1 successful insert + (1 conflicting insert + 1 select) = 3 — never two inserts that both write.
    expect(calls).toHaveLength(3);
  });

  it("rejects a self-relationship", async () => {
    const db = { execute: async () => ({ rows: [] }) } as unknown as Db;
    await expect(
      recordRelationshipAcceptance(db, {
        organizationId: "org-1",
        entityIdA: "x",
        entityIdB: "x",
        corroboration: CORROB,
        decidedBy: "web:test",
      }),
    ).rejects.toThrow(/distinct/);
  });
});
