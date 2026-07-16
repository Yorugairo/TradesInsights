/**
 * D1 — a run that recorded parser invariant violations turns the source red,
 * so the publication gate suppresses deliveries built on a silent mis-parse.
 * This is the one health signal that catches a positional column drift: volume,
 * zero-record, and fingerprint checks all stay green through it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { sourceRuns, type Db } from "@otn/db";
import { evaluateSourceHealth } from "@otn/source-sdk";
import { resetSource, testDb } from "./helpers.js";

let db: Db;
let pool: pg.Pool;
let sourceId: string;

async function insertRun(over: Record<string, unknown>): Promise<void> {
  await db.insert(sourceRuns).values({
    sourceId,
    status: "succeeded",
    startedAt: new Date(),
    completedAt: new Date(),
    discoveredCount: 5,
    fetchedCount: 5,
    unchangedCount: 0,
    parsedCount: 5,
    rejectedCount: 0,
    duplicateCount: 0,
    errorCount: 0,
    ...over,
  });
}

beforeAll(async () => {
  ({ db, pool } = await testDb());
  sourceId = await resetSource(db, "fake_source");
});

afterAll(async () => {
  await db.delete(sourceRuns).where(sql`${sourceRuns.sourceId} = ${sourceId}`);
  await pool.end();
});

describe("D1 invariant → health", () => {
  it("a run with invariant violations is red", async () => {
    await insertRun({ metricsJson: { invariantViolations: 2, deadLetters: [] } });
    const health = await evaluateSourceHealth(db, "fake_source");
    expect(health.state).toBe("red");
    expect(health.reasons.some((r) => /invariant violation/i.test(r))).toBe(true);
  });

  it("a clean run (zero violations) is not red on that account", async () => {
    await db.delete(sourceRuns).where(sql`${sourceRuns.sourceId} = ${sourceId}`);
    await insertRun({ metricsJson: { invariantViolations: 0, deadLetters: [] } });
    const health = await evaluateSourceHealth(db, "fake_source");
    expect(health.state).toBe("green");
    expect(health.reasons.some((r) => /invariant/i.test(r))).toBe(false);
  });

  it("absent metrics (older runs) never fabricates a violation", async () => {
    await db.delete(sourceRuns).where(sql`${sourceRuns.sourceId} = ${sourceId}`);
    await insertRun({ metricsJson: { deadLetters: [] } }); // no invariantViolations key
    const health = await evaluateSourceHealth(db, "fake_source");
    expect(health.state).toBe("green");
  });
});
