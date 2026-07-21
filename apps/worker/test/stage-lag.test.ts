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

  it("recomputes from live history, is deterministic, and enforces the sample floor", async () => {
    const summary = await computeStageLagStats(db);

    // These invariants hold on ANY corpus state (bare or fully-ingested):
    // recomputation is deterministic, and a below-floor/absent group yields null —
    // never a guessed estimate.
    const again = await computeStageLagStats(db);
    expect(again.samples).toBe(summary.samples);
    expect(again.groups).toBe(summary.groups);
    expect(await stageLagEstimate(db, "Lewis", "land_use")).toBeNull();

    // The volume + estimate assertions require an INGESTED corpus (applied→issued
    // history). On a bare/unseeded local DB there are no pairs, so gate them on
    // corpus presence rather than hard-failing — they run once the corpus is loaded
    // (`resolve:run`), which is exactly where Pierce/Tacoma carry thousands of pairs.
    if (summary.samples < STAGE_LAG_MIN_SAMPLES) {
      expect(summary.samples).toBe(0); // truly empty, not a partial/garbage state
      return;
    }
    expect(summary.samples).toBeGreaterThan(500);
    expect(summary.groups).toBeGreaterThan(3);

    const pierce = await stageLagEstimate(db, "Pierce", "residential");
    expect(pierce).not.toBeNull();
    expect(pierce!.n).toBeGreaterThanOrEqual(STAGE_LAG_MIN_SAMPLES);
    expect(pierce!.medianDays).toBeGreaterThanOrEqual(0);
    expect(pierce!.p75Days).toBeGreaterThanOrEqual(pierce!.medianDays);
    const pierce2 = await stageLagEstimate(db, "Pierce", "residential");
    expect(pierce2).toEqual(pierce);
  });
});
