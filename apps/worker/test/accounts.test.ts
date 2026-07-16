/**
 * M3.1 — account profiles + versioned rules (spec §12): three seeded
 * accounts, distinct territories, append-only rule versioning.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { type Db } from "@otn/db";
import {
  appendRuleVersion,
  getAccountByKey,
  getActiveAccounts,
  latestRule,
  latestRules,
} from "@otn/intelligence";
import { testDb } from "./helpers.js";

let db: Db;
let pool: pg.Pool;

beforeAll(async () => {
  ({ db, pool } = await testDb());
});

afterAll(async () => {
  await pool.end();
});

describe("M3.1 account profiles", () => {
  it("exposes the three seeded pilot accounts with spec §12 shapes", async () => {
    const accounts = await getActiveAccounts(db);
    const keys = accounts.map((a) => a.key).sort();
    expect(keys).toEqual(["lacey_glass_at_home", "lacey_glass_commercial", "solis_interiors"]);

    const atHome = accounts.find((a) => a.key === "lacey_glass_at_home")!;
    expect(atHome.territory.counties_excluded).toContain("King"); // until confirmed (§22)
    expect(atHome.capabilities).toContain("showers");
    expect(atHome.delivery.priority_review_min).toBe(80);

    const commercial = accounts.find((a) => a.key === "lacey_glass_commercial")!;
    expect(commercial.territory.counties_included).toContain("King"); // Seattle/King routes here
    expect(commercial.capabilities).toContain("curtain_wall");

    const solis = accounts.find((a) => a.key === "solis_interiors")!;
    expect(JSON.stringify(solis.exclusions)).toContain("604701295"); // closed UBI excluded
  });

  it("reads latest rules per type", async () => {
    const solis = await getAccountByKey(db, "solis_interiors");
    const rules = await latestRules(db, solis!.id);
    expect([...rules.keys()].sort()).toEqual(["exclusion", "routing", "scoring"]);
    expect(rules.get("scoring")!.version).toBeGreaterThanOrEqual(1);
  });

  it("appends rule versions without overwriting (spec §12 versioned + editable)", async () => {
    const solis = await getAccountByKey(db, "solis_interiors");
    const before = await latestRule(db, solis!.id, "routing");
    const newVersion = await appendRuleVersion(db, solis!.id, "routing", {
      ...before!.rule,
      test_marker: `edit-${Date.now()}`,
    });
    expect(newVersion).toBe(before!.version + 1);

    const after = await latestRule(db, solis!.id, "routing");
    expect(after!.version).toBe(newVersion);
    expect(after!.rule).toHaveProperty("test_marker");
    // The prior version is still there, untouched.
    const all = await db.execute(
      (await import("drizzle-orm")).sql`
        SELECT version FROM account_rules ar
        JOIN account_profiles ap ON ap.id = ar.account_profile_id
        WHERE ap.key = 'solis_interiors' AND ar.rule_type = 'routing'
        ORDER BY version`,
    );
    const versions = (all.rows as { version: number }[]).map((r) => r.version);
    expect(versions).toContain(before!.version);
    expect(versions).toContain(newVersion);
  });
});
