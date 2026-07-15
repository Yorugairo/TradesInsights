/**
 * Runner checkpoint contract (spec §5 — checkpointed backfill): the checkpoint
 * set via ctx.setCheckpoint on one run is visible as ctx.checkpoint on the
 * next, and carries forward through a run that sets none.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { type Db } from "@otn/db";
import {
  MemoryObjectStore,
  createLogger,
  runSource,
  type DiscoveredArtifact,
  type ParsedSourceRecord,
  type RawArtifact,
  type RunContext,
  type SourceAdapter,
} from "@otn/source-sdk";
import { FIXTURES_DIR } from "../src/jobs.js";
import { resetSource, testDb } from "./helpers.js";

const logger = createLogger({ app: "checkpoint-test" });

class CheckpointProbeAdapter implements SourceAdapter {
  readonly key = "fake_source";
  readonly parserVersion = "1.0.0";
  seenCheckpoint: Record<string, unknown> | null = null;

  constructor(private readonly setTo: Record<string, unknown> | null) {}

  async discover(ctx: RunContext): Promise<DiscoveredArtifact[]> {
    this.seenCheckpoint = ctx.checkpoint;
    if (this.setTo) ctx.setCheckpoint(this.setTo);
    return [];
  }

  async fetch(): Promise<RawArtifact> {
    throw new Error("unreachable — discover returns no items");
  }

  async parse(): Promise<ParsedSourceRecord[]> {
    return [];
  }
}

let db: Db;
let pool: pg.Pool;

async function run(adapter: CheckpointProbeAdapter) {
  return runSource({
    db,
    adapter,
    objectStore: new MemoryObjectStore(),
    logger,
    fixturesDir: FIXTURES_DIR,
    userAgent: "OTNInsightsBot/0.1 (test)",
  });
}

beforeAll(async () => {
  ({ db, pool } = await testDb());
  await resetSource(db, "fake_source");
});

afterAll(async () => {
  await pool.end();
});

describe("runner checkpoints", () => {
  it("starts with no checkpoint", async () => {
    const a = new CheckpointProbeAdapter({ highWater: "2026-07-01" });
    await run(a);
    expect(a.seenCheckpoint).toBeNull();
  });

  it("passes the previous run's checkpoint to the next run", async () => {
    const b = new CheckpointProbeAdapter(null);
    await run(b);
    expect(b.seenCheckpoint).toEqual({ highWater: "2026-07-01" });
  });

  it("carries the checkpoint through a run that sets none", async () => {
    const c = new CheckpointProbeAdapter({ highWater: "2026-07-10" });
    await run(c);
    expect(c.seenCheckpoint).toEqual({ highWater: "2026-07-01" });

    const d = new CheckpointProbeAdapter(null);
    await run(d);
    expect(d.seenCheckpoint).toEqual({ highWater: "2026-07-10" });
  });
});
