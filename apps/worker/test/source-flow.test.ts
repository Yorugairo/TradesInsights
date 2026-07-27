/**
 * Cadence-windowed flow assertion — the check that answers "is this source
 * actually producing?" without the two false-answer modes the 2026-07-27 fleet
 * audit found.
 *
 * Every case below is one of those modes, reconstructed from the real history:
 *
 *  - a source with `parsed_count = 0` on its latest run that is nonetheless
 *    perfectly healthy (13 of 29 enabled sources looked like this; 11 were
 *    fine). A single-run check gets this wrong.
 *  - a monthly source that is quiet today and correct (`lacey_permit_reports`).
 *  - a source whose only runs were ORPHANED, whose counters were therefore
 *    never written (`bellevue_permits_arcgis`, two such runs). Zero here is an
 *    unwritten column, not a measurement.
 *  - a source that has never executed at all (nine of them, including
 *    `seattle_design_review`, which has an adapter AND a test). This one is
 *    invisible to any check that starts from `source_runs`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type pg from "pg";
import { sourceRuns, type Db } from "@otn/db";
import { getSourceConfig, type SourceConfig } from "@otn/config";
import { ORPHAN_REASON, assertSourceFlow } from "@otn/source-sdk";
import { resetSource, testDb } from "./helpers.js";

const KEY = "fake_source";
const MONTHLY_KEY = "fake_source_required";
const NOW = new Date("2026-07-27T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

/**
 * A config entry for the flow check. Overridden rather than read verbatim so
 * the fixture sources can stand in for a `daily`/`monthly` html source —
 * `flowCheckedSources` excludes `fixture` and `on_demand` by design.
 */
function cfg(key: string, cadence: SourceConfig["cadence"]): SourceConfig {
  return {
    ...getSourceConfig(key),
    cadence,
    access_class: "html",
    enabled: true,
  } as SourceConfig;
}

let db: Db;
let pool: pg.Pool;
let sourceId: string;
let monthlySourceId: string;

interface RunSpec {
  hoursAgo: number;
  status?: "succeeded" | "failed" | "completed_with_errors";
  parsed?: number;
  duplicate?: number;
  unchanged?: number;
  orphaned?: boolean;
}

async function insertRun(id: string, spec: RunSpec) {
  const startedAt = hoursAgo(spec.hoursAgo);
  await db.insert(sourceRuns).values({
    sourceId: id,
    startedAt,
    completedAt: startedAt,
    status: spec.status ?? "succeeded",
    parsedCount: spec.parsed ?? 0,
    duplicateCount: spec.duplicate ?? 0,
    unchangedCount: spec.unchanged ?? 0,
    metricsJson: spec.orphaned ? { orphaned: true, reason: ORPHAN_REASON } : {},
  });
}

async function reportFor(key: string, cadence: SourceConfig["cadence"]) {
  const reports = await assertSourceFlow(db, { now: NOW, sources: [cfg(key, cadence)] });
  expect(reports).toHaveLength(1);
  return reports[0]!;
}

beforeAll(async () => {
  ({ db, pool } = await testDb());
  sourceId = await resetSource(db, KEY);
  monthlySourceId = await resetSource(db, MONTHLY_KEY);
});

afterAll(async () => {
  await db.delete(sourceRuns).where(eq(sourceRuns.sourceId, sourceId));
  await db.delete(sourceRuns).where(eq(sourceRuns.sourceId, monthlySourceId));
  await pool.end();
});

beforeEach(async () => {
  await db.delete(sourceRuns).where(eq(sourceRuns.sourceId, sourceId));
  await db.delete(sourceRuns).where(eq(sourceRuns.sourceId, monthlySourceId));
});

describe("assertSourceFlow", () => {
  it("does NOT flag a daily source whose latest run parsed nothing but saw unchanged artifacts", async () => {
    // The 11-false-alarms case. `unchanged` means every previously parsed
    // record is still current — that is a working source, not a stalled one.
    await insertRun(sourceId, { hoursAgo: 2, parsed: 0, unchanged: 5 });
    const r = await reportFor(KEY, "daily");
    expect(r.state).toBe("flowing");
    expect(r.flagged).toBe(false);
    expect(r.recordsInWindow).toBe(5);
  });

  it("does NOT flag a quiet monthly source that produced records earlier in its window", async () => {
    // `lacey_permit_reports`: monthly, 50 records, nothing today. A daily
    // threshold applied globally would flag this every day but two.
    await insertRun(monthlySourceId, { hoursAgo: 6 * 24, parsed: 50 });
    await insertRun(monthlySourceId, { hoursAgo: 2, parsed: 0 });
    const r = await reportFor(MONTHLY_KEY, "monthly");
    expect(r.state).toBe("flowing");
    expect(r.windowHours).toBe(960);
    expect(r.recordsInWindow).toBe(50);
  });

  it("flags a daily source that ran in the window and produced nothing at all", async () => {
    // `spokane_permits_arcgis`: one run, HTTP 403, zero records ever.
    await insertRun(sourceId, { hoursAgo: 3, status: "failed" });
    const r = await reportFor(KEY, "daily");
    expect(r.state).toBe("no_records_in_window");
    expect(r.flagged).toBe(true);
  });

  it("reports orphan-only runs as UNKNOWN, not as zero records", async () => {
    // `bellevue_permits_arcgis`: two runs, both reaped, counters never written.
    // Calling this "produced nothing" asserts something never observed.
    await insertRun(sourceId, { hoursAgo: 2, status: "completed_with_errors", orphaned: true });
    await insertRun(sourceId, { hoursAgo: 3, status: "completed_with_errors", orphaned: true });
    const r = await reportFor(KEY, "daily");
    expect(r.state).toBe("unknown");
    expect(r.flagged).toBe(true);
    expect(r.orphanRunsInWindow).toBe(2);
  });

  it("still judges the window when only SOME runs were orphaned", async () => {
    // One orphan plus one real, productive run: the real run is the evidence.
    await insertRun(sourceId, { hoursAgo: 2, status: "completed_with_errors", orphaned: true });
    await insertRun(sourceId, { hoursAgo: 4, parsed: 12 });
    const r = await reportFor(KEY, "daily");
    expect(r.state).toBe("flowing");
    expect(r.recordsInWindow).toBe(12);
    expect(r.orphanRunsInWindow).toBe(1);
  });

  it("does not credit an orphan's zeros as observed output", async () => {
    // An orphan alongside a genuinely empty real run must not soften the
    // verdict — the real run is what is judged.
    await insertRun(sourceId, { hoursAgo: 2, status: "completed_with_errors", orphaned: true });
    await insertRun(sourceId, { hoursAgo: 4, parsed: 0 });
    const r = await reportFor(KEY, "daily");
    expect(r.state).toBe("no_records_in_window");
  });

  it("flags a source that has not been invoked at all inside its window", async () => {
    // The fleet-wide condition: the code works, nothing is calling it. A run
    // five days ago is outside a daily source's 48h window.
    await insertRun(sourceId, { hoursAgo: 5 * 24, parsed: 300 });
    const r = await reportFor(KEY, "daily");
    expect(r.state).toBe("no_run_in_window");
    expect(r.flagged).toBe(true);
    expect(r.recordsInWindow).toBe(0);
  });

  it("flags a configured source that has NEVER run — the case a runs-table check cannot see", async () => {
    const r = await reportFor(KEY, "daily");
    expect(r.state).toBe("never_ran");
    expect(r.flagged).toBe(true);
    expect(r.lastRunAt).toBeNull();
  });

  it("reports a config source with no database row rather than dropping it", async () => {
    // Iterating config and LEFT JOINing is what makes this observable at all.
    const phantom = { ...cfg(KEY, "daily"), key: "source_that_was_never_seeded" } as SourceConfig;
    const [r] = await assertSourceFlow(db, { now: NOW, sources: [phantom] });
    expect(r!.state).toBe("never_ran");
    expect(r!.reason).toContain("not seeded");
  });

  it("excludes on_demand sources — they have no cadence to measure against", async () => {
    // The capture-fed operator-local sources (olympia, tumwater) run when an
    // operator stages a capture; a datacenter clock has nothing to say.
    const reports = await assertSourceFlow(db, {
      now: NOW,
      sources: [cfg(KEY, "on_demand")],
    });
    expect(reports).toHaveLength(0);
  });
});
