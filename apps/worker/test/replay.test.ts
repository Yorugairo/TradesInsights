/**
 * D5 — parser replay. After a parser fix, reprocessing the stored immutable
 * artifacts heals already-stored records without re-fetching. Proven by
 * corrupting a record's normalized view and showing replay restores it from the
 * retained raw bytes; a second replay rewrites nothing (idempotent).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type pg from "pg";
import { FakeSourceAdapter } from "@otn/adapters";
import { sourceRecords, type Db } from "@otn/db";
import { MemoryObjectStore, createLogger, replaySource, runSource } from "@otn/source-sdk";
import { FIXTURES_DIR } from "../src/jobs.js";
import { resetSource, testDb } from "./helpers.js";

const logger = createLogger({ app: "replay-test" });

let db: Db;
let pool: pg.Pool;
let sourceId: string;
// One store shared across the ingest run and the replays so stored bytes persist.
const store = new MemoryObjectStore();

beforeAll(async () => {
  ({ db, pool } = await testDb());
  sourceId = await resetSource(db, "fake_source");
  await runSource({
    db,
    adapter: new FakeSourceAdapter(),
    objectStore: store,
    logger,
    fixturesDir: FIXTURES_DIR,
    userAgent: "OTNInsightsBot/0.1 (test)",
  });
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM source_runs WHERE source_id = ${sourceId} AND metrics_json->>'replay' = 'true'`);
  await pool.end();
});

describe("D5 parser replay", () => {
  it("restores a corrupted normalized view from the immutable artifact", async () => {
    const [rec] = await db
      .select({ id: sourceRecords.id, normalizedJson: sourceRecords.normalizedJson })
      .from(sourceRecords)
      .where(eq(sourceRecords.sourceId, sourceId))
      .limit(1);
    expect(rec).toBeTruthy();
    const original = rec!.normalizedJson as { title: string };
    const originalTitle = original.title;

    // Simulate a stale record left by an old buggy parser: wrong title + a
    // fingerprint that no longer matches the (corrupted) content.
    await db
      .update(sourceRecords)
      .set({
        normalizedJson: { ...original, title: "CORRUPTED BY OLD PARSER" },
        normalizedFingerprint: "stale-fingerprint",
      })
      .where(eq(sourceRecords.id, rec!.id));

    const result = await replaySource({
      db,
      adapter: new FakeSourceAdapter(),
      objectStore: store,
      logger,
    });
    expect(result.artifactsReplayed).toBeGreaterThan(0);
    expect(result.recordsChanged).toBeGreaterThanOrEqual(1);
    expect(result.errors).toBe(0);

    const [after] = await db
      .select({ normalizedJson: sourceRecords.normalizedJson })
      .from(sourceRecords)
      .where(eq(sourceRecords.id, rec!.id));
    expect((after!.normalizedJson as { title: string }).title).toBe(originalTitle);
  });

  it("is idempotent — a second replay with the same parser changes nothing", async () => {
    const result = await replaySource({
      db,
      adapter: new FakeSourceAdapter(),
      objectStore: store,
      logger,
    });
    expect(result.artifactsReplayed).toBeGreaterThan(0);
    expect(result.recordsChanged).toBe(0);
    expect(result.recordsInserted).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("records a replay source_run for audit", async () => {
    const runs = await db.execute(sql`
      SELECT metrics_json FROM source_runs
      WHERE source_id = ${sourceId} AND metrics_json->>'replay' = 'true'
      ORDER BY started_at DESC LIMIT 1`);
    const metrics = (runs.rows[0] as { metrics_json: { replay?: boolean; parserVersion?: string } }).metrics_json;
    expect(metrics.replay).toBe(true);
    expect(metrics.parserVersion).toBe("1.0.0");
  });
});
