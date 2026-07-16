/**
 * S0 (strengthening addendum §5) — versioned capacity snapshots: the effective
 * snapshot is selected by time window, and the SAME project is assessed
 * differently under different snapshots (exit gate), with a deterministic
 * explanation. Historical windows are never rewritten by a newer snapshot.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { type Db } from "@otn/db";
import { assessCapacity, effectiveCapacitySnapshot } from "@otn/intelligence";
import { testDb } from "./helpers.js";

const RUN = randomUUID().slice(0, 8).toLowerCase();

let db: Db;
let pool: pg.Pool;
let accountId: string;

beforeAll(async () => {
  ({ db, pool } = await testDb());
  const [acct] = await db.execute(sql`
    INSERT INTO account_profiles (key, name, active, capabilities_json, territory_json, delivery_config_json)
    VALUES (${`test_cap_${RUN}`}, ${`Cap ${RUN}`}, true, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb)
    RETURNING id`).then((r) => r.rows as { id: string }[]);
  accountId = acct!.id;

  // A closed historical window (small shop) and the current open window (grown).
  await db.execute(sql`
    INSERT INTO account_capacity_snapshots
      (account_profile_id, effective_from, effective_to, maximum_contract_value, minimum_contract_value, provisional, created_by)
    VALUES
      (${accountId}, timestamptz '2026-01-01', timestamptz '2026-06-01', 1000000, 50000, false, 'test'),
      (${accountId}, timestamptz '2026-06-01', NULL, 3000000, 50000, false, 'test')`);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM account_capacity_snapshots WHERE account_profile_id = ${accountId}`);
  await db.execute(sql`DELETE FROM account_profiles WHERE id = ${accountId}`);
  await pool.end();
});

describe("S0 capacity snapshots", () => {
  it("selects the snapshot effective at a given time (windowed, historical preserved)", async () => {
    const historical = await effectiveCapacitySnapshot(db, accountId, new Date("2026-03-01"));
    expect(historical?.maximumContractValue).toBe(1_000_000);

    const current = await effectiveCapacitySnapshot(db, accountId, new Date("2026-09-01"));
    expect(current?.maximumContractValue).toBe(3_000_000);
  });

  it("same $1.5M project → likely_too_large then likely_fit as capacity grows (exit gate)", async () => {
    const project = { valuationUsd: 1_500_000, isPublicWork: false };
    const before = assessCapacity(
      project,
      await effectiveCapacitySnapshot(db, accountId, new Date("2026-03-01")),
    );
    const after = assessCapacity(
      project,
      await effectiveCapacitySnapshot(db, accountId, new Date("2026-09-01")),
    );
    expect(before.assessment).toBe("likely_too_large");
    expect(before.priorityFactor).toBeLessThan(1);
    expect(after.assessment).toBe("likely_fit");
    expect(after.priorityFactor).toBe(1);
    // Every capacity outcome carries a stated reason (no silent penalty).
    expect(before.explanation).toMatch(/exceeds/i);
  });
});
