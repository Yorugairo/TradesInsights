/**
 * P3.1 — stage-lag statistics: computed from same-record applied→issued date
 * pairs, sample floor enforced, permit-class buckets deterministic.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type pg from "pg";
import { type Db } from "@otn/db";
import {
  STAGE_LAG_MIN_SAMPLES,
  computeStageLagStats,
  permitClassOf,
  stageLagEstimate,
} from "@otn/intelligence";
import { testDb } from "./helpers.js";

let db: Db;
let pool: pg.Pool;

beforeAll(async () => {
  ({ db, pool } = await testDb());
});
afterAll(async () => pool.end());

describe("P3 stage-lag statistics", () => {
  it("permitClassOf buckets deterministically", () => {
    expect(permitClassOf("Construction Commercial", null)).toBe("commercial");
    expect(permitClassOf("Construction Residential", null)).toBe("residential");
    expect(permitClassOf("Land Use Permit", null)).toBe("land_use");
    expect(permitClassOf(null, "Mechanical")).toBe("trade");
    expect(permitClassOf("Special Event", null)).toBe("other");
  });

  it("recomputes from live history and enforces the sample floor", async () => {
    const summary = await computeStageLagStats(db);
    // Pierce/Tacoma history carries thousands of applied→issued pairs.
    expect(summary.samples).toBeGreaterThan(500);
    expect(summary.groups).toBeGreaterThan(3);

    const pierce = await stageLagEstimate(db, "Pierce", "residential");
    expect(pierce).not.toBeNull();
    expect(pierce!.n).toBeGreaterThanOrEqual(STAGE_LAG_MIN_SAMPLES);
    expect(pierce!.medianDays).toBeGreaterThanOrEqual(0);
    expect(pierce!.p75Days).toBeGreaterThanOrEqual(pierce!.medianDays);

    // Below the floor (or absent) → null, never a guessed estimate.
    expect(await stageLagEstimate(db, "Lewis", "land_use")).toBeNull();

    // Deterministic: recompute yields identical stats for the same data.
    const again = await computeStageLagStats(db);
    expect(again.samples).toBe(summary.samples);
    const pierce2 = await stageLagEstimate(db, "Pierce", "residential");
    expect(pierce2).toEqual(pierce);
  });
});
