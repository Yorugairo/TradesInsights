import { describe, expect, it } from "vitest";
import type { Db } from "@otn/db";
import { loadBoundOrgIdsByEntity } from "./family-anchors.js";

describe("loadBoundOrgIdsByEntity", () => {
  it("returns an empty map without querying when given no entities", async () => {
    let called = false;
    const db = {
      execute: async () => {
        called = true;
        return { rows: [] };
      },
    } as unknown as Db;
    const map = await loadBoundOrgIdsByEntity(db, []);
    expect(map.size).toBe(0);
    expect(called).toBe(false);
  });

  it("maps registry_ref → org id for bound entities, omitting unbound ones", async () => {
    const db = {
      execute: async () => ({
        rows: [
          { registry_ref: "ent-a", id: "org-1" },
          { registry_ref: "ent-b", id: "org-2" },
        ],
      }),
    } as unknown as Db;
    const map = await loadBoundOrgIdsByEntity(db, ["ent-a", "ent-b", "ent-c"]);
    expect(map.get("ent-a")).toBe("org-1");
    expect(map.get("ent-b")).toBe("org-2");
    expect(map.has("ent-c")).toBe(false);
  });
});
