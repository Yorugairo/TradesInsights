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

describe("D2 required-field fill drop → health", () => {
  // Runs are ordered by startedAt desc; insert previous first, then latest.
  async function twoRuns(prevFill: Record<string, number>, latestFill: Record<string, number>) {
    await db.delete(sourceRuns).where(sql`${sourceRuns.sourceId} = ${sourceId}`);
    await db.insert(sourceRuns).values({
      sourceId,
      status: "succeeded",
      startedAt: new Date(Date.now() - 3600_000),
      completedAt: new Date(Date.now() - 3600_000),
      discoveredCount: 10,
      fetchedCount: 10,
      parsedCount: 10,
      metricsJson: { fieldFill: prevFill, deadLetters: [] },
    });
    await db.insert(sourceRuns).values({
      sourceId,
      status: "succeeded",
      startedAt: new Date(),
      completedAt: new Date(),
      discoveredCount: 10,
      fetchedCount: 10,
      parsedCount: 10,
      metricsJson: { fieldFill: latestFill, deadLetters: [] },
    });
  }

  it("a required field that stops being emitted (100%→40%) is red", async () => {
    await twoRuns({ valuationUsd: 1.0, addressRaw: 1.0 }, { valuationUsd: 0.4, addressRaw: 1.0 });
    const health = await evaluateSourceHealth(db, "fake_source");
    expect(health.state).toBe("red");
    expect(health.reasons.some((r) => /valuationUsd.*drop/i.test(r))).toBe(true);
  });

  it("a stable fill rate is green (no false positive)", async () => {
    await twoRuns({ valuationUsd: 1.0, addressRaw: 0.9 }, { valuationUsd: 0.95, addressRaw: 0.9 });
    const health = await evaluateSourceHealth(db, "fake_source");
    expect(health.state).toBe("green");
  });

  it("a field structurally sparse in both runs never trips (self-referential)", async () => {
    // valuation absent in both (SEPA-like) — a 0→0 is not a drop.
    await twoRuns({ valuationUsd: 0.0, addressRaw: 1.0 }, { valuationUsd: 0.0, addressRaw: 1.0 });
    const health = await evaluateSourceHealth(db, "fake_source");
    expect(health.state).toBe("green");
  });
});

describe("D2 per-source required fields (absolute floor)", () => {
  let requiredSourceId: string;
  beforeAll(async () => {
    // A test-only source that declares required_fields — never a real source,
    // whose live run history these tests would otherwise wipe.
    requiredSourceId = await resetSource(db, "fake_source_required");
  });
  afterAll(async () => {
    await db.delete(sourceRuns).where(sql`${sourceRuns.sourceId} = ${requiredSourceId}`);
  });

  async function oneRun(fill: Record<string, number>) {
    await db.delete(sourceRuns).where(sql`${sourceRuns.sourceId} = ${requiredSourceId}`);
    await db.insert(sourceRuns).values({
      sourceId: requiredSourceId,
      status: "succeeded",
      startedAt: new Date(),
      completedAt: new Date(),
      discoveredCount: 10,
      fetchedCount: 10,
      parsedCount: 10,
      metricsJson: { fieldFill: fill, deadLetters: [] },
    });
  }

  it("a declared required field near-absent in the FIRST run is red (starts broken)", async () => {
    await oneRun({ addressRaw: 1.0, issueDate: 1.0, valuationUsd: 0.1 });
    const h = await evaluateSourceHealth(db, "fake_source_required");
    expect(h.state).toBe("red");
    expect(h.reasons.some((r) => /valuationUsd.*floor/i.test(r))).toBe(true);
  });

  it("all declared required fields present → no floor violation", async () => {
    await oneRun({ addressRaw: 1.0, issueDate: 1.0, valuationUsd: 0.9 });
    const h = await evaluateSourceHealth(db, "fake_source_required");
    expect(h.reasons.some((r) => /floor/i.test(r))).toBe(false);
  });

  it("a NON-required field being sparse does not trip the floor", async () => {
    // units is not declared required for this source → sparse units is fine.
    await oneRun({ addressRaw: 1.0, issueDate: 1.0, valuationUsd: 0.9, units: 0.05 });
    const h = await evaluateSourceHealth(db, "fake_source_required");
    expect(h.reasons.some((r) => /units.*floor/i.test(r))).toBe(false);
  });
});

describe("D3 schema-fingerprint drift → health", () => {
  async function twoRuns(prevFp: string, latestFp: string) {
    await db.delete(sourceRuns).where(sql`${sourceRuns.sourceId} = ${sourceId}`);
    await db.insert(sourceRuns).values({
      sourceId,
      status: "succeeded",
      startedAt: new Date(Date.now() - 3600_000),
      completedAt: new Date(Date.now() - 3600_000),
      discoveredCount: 5,
      fetchedCount: 5,
      parsedCount: 5,
      schemaFingerprint: prevFp,
      metricsJson: { deadLetters: [] },
    });
    await db.insert(sourceRuns).values({
      sourceId,
      status: "succeeded",
      startedAt: new Date(),
      completedAt: new Date(),
      discoveredCount: 5,
      fetchedCount: 5,
      parsedCount: 5,
      schemaFingerprint: latestFp,
      metricsJson: { deadLetters: [] },
    });
  }

  it("a changed fingerprint raises amber (review canary), not silent", async () => {
    await twoRuns("aaaa", "bbbb");
    const health = await evaluateSourceHealth(db, "fake_source");
    expect(health.state).toBe("amber");
    expect(health.reasons.some((r) => /fingerprint changed/i.test(r))).toBe(true);
  });

  it("a stable fingerprint stays green", async () => {
    await twoRuns("aaaa", "aaaa");
    const health = await evaluateSourceHealth(db, "fake_source");
    expect(health.state).toBe("green");
  });

  it("oscillating between known fingerprints stays green (sparse-JSON sources)", async () => {
    await twoRuns("bbbb", "aaaa");
    // Third run returns to a fingerprint already seen in the window: Socrata
    // omits null-valued keys, so day-to-day field sets legitimately alternate.
    await db.insert(sourceRuns).values({
      sourceId,
      status: "succeeded",
      startedAt: new Date(Date.now() + 1000),
      completedAt: new Date(Date.now() + 1000),
      discoveredCount: 5,
      fetchedCount: 5,
      parsedCount: 5,
      schemaFingerprint: "bbbb",
      metricsJson: { deadLetters: [] },
    });
    const health = await evaluateSourceHealth(db, "fake_source");
    expect(health.state).toBe("green");
  });
});
