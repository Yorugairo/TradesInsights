/**
 * D4 — a run whose process died without writing a terminal row.
 *
 * Before the reaper, such a row sat at `status='running'` forever, and
 * `evaluateSourceHealth` filters those out before it looks at anything — so the
 * source did not merely fail to report, it reported GREEN off the back of its
 * last genuinely-successful run. `bellevue_permits_arcgis` did exactly that for
 * 77 minutes on 2026-07-27 while fetching nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { sourceRuns, type Db } from "@otn/db";
import {
  evaluateSourceHealth,
  isOrphanedRun,
  ORPHAN_REASON,
  ORPHAN_RUN_THRESHOLD_MS,
  reapOrphanedRuns,
} from "@otn/source-sdk";
import { resetSource, testDb } from "./helpers.js";

let db: Db;
let pool: pg.Pool;
let sourceId: string;

const MINUTE = 60_000;

async function insertRun(over: Record<string, unknown>): Promise<string> {
  const [row] = await db
    .insert(sourceRuns)
    .values({
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
    })
    .returning({ id: sourceRuns.id });
  return row!.id;
}

/** A run still marked `running`, started `agoMs` in the past — an orphan. */
async function insertStuckRun(agoMs: number): Promise<string> {
  return insertRun({
    status: "running",
    startedAt: new Date(Date.now() - agoMs),
    completedAt: null,
    discoveredCount: 0,
    fetchedCount: 0,
    parsedCount: 0,
    metricsJson: null,
  });
}

async function runById(id: string) {
  const [row] = await db.select().from(sourceRuns).where(sql`${sourceRuns.id} = ${id}`);
  return row!;
}

beforeAll(async () => {
  ({ db, pool } = await testDb());
  sourceId = await resetSource(db, "fake_source");
});

beforeEach(async () => {
  await db.delete(sourceRuns).where(sql`${sourceRuns.sourceId} = ${sourceId}`);
});

afterAll(async () => {
  await db.delete(sourceRuns).where(sql`${sourceRuns.sourceId} = ${sourceId}`);
  await pool.end();
});

describe("reapOrphanedRuns", () => {
  it("closes a run stuck past the threshold, with an explicit reason", async () => {
    const id = await insertStuckRun(90 * MINUTE);

    const reaped = await reapOrphanedRuns(db);

    expect(reaped.map((r) => r.sourceRunId)).toContain(id);
    const row = await runById(id);
    expect(row.status).toBe("completed_with_errors");
    expect(row.completedAt).not.toBeNull();
    expect((row.metricsJson as { reason?: string }).reason).toBe(ORPHAN_REASON);
    expect(isOrphanedRun(row)).toBe(true);
    // A reaped run is not a clean run.
    expect(row.errorCount).toBe(1);
  });

  it("leaves a run that is merely SLOW alone", async () => {
    // The slowest legitimate run ever measured is 8.8 minutes (pierce, 6,145
    // records). A 30-minute run is well beyond that and still must not be
    // reaped — the threshold is a death test, not a performance budget.
    const id = await insertStuckRun(30 * MINUTE);

    const reaped = await reapOrphanedRuns(db);

    expect(reaped.map((r) => r.sourceRunId)).not.toContain(id);
    expect((await runById(id)).status).toBe("running");
  });

  it("never touches a run that already reached a terminal state", async () => {
    // Guards the WHERE clause: without `status = 'running'` this would rewrite
    // finished history every night.
    const id = await insertRun({
      status: "succeeded",
      startedAt: new Date(Date.now() - 90 * MINUTE),
      metricsJson: { parsed: 5 },
    });

    await reapOrphanedRuns(db);

    const row = await runById(id);
    expect(row.status).toBe("succeeded");
    expect(isOrphanedRun(row)).toBe(false);
  });

  it("is idempotent — a second sweep reaps nothing and does not re-increment", async () => {
    const id = await insertStuckRun(90 * MINUTE);
    await reapOrphanedRuns(db);
    const afterFirst = await runById(id);

    const second = await reapOrphanedRuns(db);

    expect(second).toEqual([]);
    expect((await runById(id)).errorCount).toBe(afterFirst.errorCount);
  });

  it("preserves metrics it did not author rather than clobbering them", async () => {
    const id = await insertRun({
      status: "running",
      startedAt: new Date(Date.now() - 90 * MINUTE),
      completedAt: null,
      metricsJson: { partial: "in-flight", parsed: 12 },
    });

    await reapOrphanedRuns(db);

    const m = (await runById(id)).metricsJson as Record<string, unknown>;
    expect(m.partial).toBe("in-flight");
    expect(m.parsed).toBe(12);
    expect(m.reason).toBe(ORPHAN_REASON);
  });

  it("honours an injected clock and threshold", async () => {
    const id = await insertStuckRun(20 * MINUTE);

    const reaped = await reapOrphanedRuns(db, { olderThanMs: 10 * MINUTE });

    expect(reaped.map((r) => r.sourceRunId)).toContain(id);
  });

  it("uses a threshold comfortably above the slowest observed real run", async () => {
    // Documents the measurement the constant is derived from: 8.8 min slowest
    // across 80 production runs. If someone lowers this below ~30 min they are
    // inside the range where a big backfill could be reaped mid-flight.
    expect(ORPHAN_RUN_THRESHOLD_MS).toBeGreaterThanOrEqual(30 * MINUTE);
  });
});

describe("D4 orphaned run → health", () => {
  it("turns amber, and says why", async () => {
    await insertStuckRun(90 * MINUTE);
    await reapOrphanedRuns(db);

    const health = await evaluateSourceHealth(db, "fake_source");

    expect(health.state).toBe("amber");
    expect(health.reasons.some((r) => r.includes(ORPHAN_REASON))).toBe(true);
  });

  it("does NOT count an orphan as a success — lastSuccessAt stays honest", async () => {
    // The trap this closes: an orphan is stamped `completed_with_errors`, which
    // the success filter accepted. A source dying every night would then refresh
    // `lastSuccessAt` on every reap and never trip the staleness check.
    await insertStuckRun(90 * MINUTE);
    await reapOrphanedRuns(db);

    const health = await evaluateSourceHealth(db, "fake_source");

    expect(health.lastSuccessAt).toBeNull();
  });

  it("two consecutive orphans are red — the source cannot complete", async () => {
    await insertStuckRun(200 * MINUTE);
    await insertStuckRun(90 * MINUTE);
    await reapOrphanedRuns(db);

    const health = await evaluateSourceHealth(db, "fake_source");

    expect(health.state).toBe("red");
    expect(health.reasons.some((r) => /two consecutive runs died/i.test(r))).toBe(true);
  });

  it("does not fabricate 'zero usable records' from an orphan's unwritten counters", async () => {
    // An orphan's counts were never written. Reading them as measurements both
    // invents a diagnosis and outranks (red) the accurate one (amber).
    await insertRun({
      status: "running",
      startedAt: new Date(Date.now() - 90 * MINUTE),
      completedAt: null,
      discoveredCount: 40, // discovered, then died before recording what it parsed
      parsedCount: 0,
      unchangedCount: 0,
      duplicateCount: 0,
      metricsJson: null,
    });
    await reapOrphanedRuns(db);

    const health = await evaluateSourceHealth(db, "fake_source");

    expect(health.state).toBe("amber");
    expect(health.reasons.some((r) => /zero usable records/i.test(r))).toBe(false);
  });

  it("does not report a volume collapse from an orphan's unwritten counters", async () => {
    await insertRun({ startedAt: new Date(Date.now() - 300 * MINUTE), parsedCount: 500 });
    await insertStuckRun(90 * MINUTE);
    await reapOrphanedRuns(db);

    const health = await evaluateSourceHealth(db, "fake_source");

    expect(health.reasons.some((r) => /volume dropped/i.test(r))).toBe(false);
  });

  it("a healthy run after an orphan clears the amber", async () => {
    await insertStuckRun(200 * MINUTE);
    await reapOrphanedRuns(db);
    await insertRun({ metricsJson: { parsed: 5 } });

    const health = await evaluateSourceHealth(db, "fake_source");

    expect(health.state).toBe("green");
    expect(health.lastSuccessAt).not.toBeNull();
  });
});
