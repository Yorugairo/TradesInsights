/**
 * M0 exit gate (spec §21): a fake adapter discovers, stores, hashes, parses,
 * reruns idempotently, and reports health. Runs against the real Postgres and
 * MinIO from docker compose (pnpm infra:up).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type pg from "pg";
import {
  evidenceItems,
  rawArtifacts,
  sourceRecords,
  type Db,
} from "@otn/db";
import { FakeSourceAdapter } from "@otn/adapters";
import {
  S3ObjectStore,
  createLogger,
  evaluateSourceHealth,
  runSource,
  s3ConfigFromEnv,
  sha256Hex,
  type RunResult,
} from "@otn/source-sdk";
import { FIXTURES_DIR } from "../src/jobs.js";
import { resetSource, testDb } from "./helpers.js";

const logger = createLogger({ app: "m0-exit-gate-test" });

let db: Db;
let pool: pg.Pool;
let sourceId: string;
let objectStore: S3ObjectStore;

async function run(): Promise<RunResult> {
  return runSource({
    db,
    adapter: new FakeSourceAdapter(),
    objectStore,
    logger,
    fixturesDir: FIXTURES_DIR,
    userAgent: "OTNInsightsBot/0.1 (test)",
  });
}

beforeAll(async () => {
  ({ db, pool } = await testDb());
  sourceId = await resetSource(db, "fake_source");
  objectStore = new S3ObjectStore(s3ConfigFromEnv());
  await objectStore.ensureBucket();
});

afterAll(async () => {
  await pool.end();
});

describe("M0 exit gate", () => {
  let first: RunResult;
  let second: RunResult;

  it("discovers, fetches, stores, hashes, and parses fixture artifacts", async () => {
    first = await run();
    expect(first.status).toBe("succeeded");
    expect(first.metrics.discovered).toBe(2);
    expect(first.metrics.fetched).toBe(2);
    expect(first.metrics.parsed).toBe(3);
    // The deliberately-malformed fixture row is rejected, never guessed.
    expect(first.metrics.rejected).toBe(1);
    expect(first.metrics.errors).toBe(0);

    const artifacts = await db
      .select()
      .from(rawArtifacts)
      .where(eq(rawArtifacts.sourceId, sourceId));
    expect(artifacts).toHaveLength(2);
    for (const a of artifacts) {
      const body = await objectStore.get(a.storageKey);
      expect(sha256Hex(body)).toBe(a.sha256);
      expect(a.byteSize).toBe(body.byteLength);
      expect(a.parserVersion).toBe("1.0.0");
    }

    const records = await db
      .select()
      .from(sourceRecords)
      .where(eq(sourceRecords.sourceId, sourceId));
    expect(records.map((r) => r.externalId).sort()).toEqual([
      "FAKE-2026-0001",
      "FAKE-2026-0002",
      "FAKE-2026-0003",
    ]);
    // Unknown values stay null — never coerced (spec §8).
    const ti = records.find((r) => r.externalId === "FAKE-2026-0002")!;
    expect((ti.normalizedJson as { valuationUsd: unknown }).valuationUsd).toBeNull();
  });

  it("writes A-grade evidence rows for every record", async () => {
    const records = await db
      .select({ id: sourceRecords.id })
      .from(sourceRecords)
      .where(eq(sourceRecords.sourceId, sourceId));
    for (const r of records) {
      const rows = await db
        .select()
        .from(evidenceItems)
        .where(eq(evidenceItems.sourceRecordId, r.id));
      expect(rows.length).toBeGreaterThan(0);
      for (const e of rows) {
        expect(e.authorityGrade).toBe("A");
        expect(e.sourceUrl).toMatch(/^https:\/\//);
        expect(e.parserVersion).toBe("1.0.0");
      }
    }
  });

  it("reruns idempotently: unchanged content adds no artifacts and no records", async () => {
    const before = {
      artifacts: (
        await db.select().from(rawArtifacts).where(eq(rawArtifacts.sourceId, sourceId))
      ).length,
      records: (
        await db.select().from(sourceRecords).where(eq(sourceRecords.sourceId, sourceId))
      ).length,
    };

    second = await run();
    expect(second.status).toBe("succeeded");
    expect(second.metrics.unchanged).toBe(2);
    expect(second.metrics.parsed).toBe(0);
    expect(second.metrics.errors).toBe(0);

    const after = {
      artifacts: (
        await db.select().from(rawArtifacts).where(eq(rawArtifacts.sourceId, sourceId))
      ).length,
      records: (
        await db.select().from(sourceRecords).where(eq(sourceRecords.sourceId, sourceId))
      ).length,
    };
    expect(after).toEqual(before);
  });

  it("bumps last_seen_at on rerun without touching first_seen_at", async () => {
    const records = await db
      .select()
      .from(sourceRecords)
      .where(eq(sourceRecords.sourceId, sourceId));
    for (const r of records) {
      expect(r.lastSeenAt.getTime()).toBeGreaterThan(r.firstSeenAt.getTime());
    }
  });

  it("reports green health after successful runs", async () => {
    const health = await evaluateSourceHealth(db, "fake_source");
    expect(health.state).toBe("green");
    expect(health.lastSuccessAt).not.toBeNull();
  });
});
