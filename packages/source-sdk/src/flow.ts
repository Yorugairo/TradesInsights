import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";
import { loadSourcesConfig, type SourceConfig } from "@otn/config";
import { ORPHAN_REASON } from "./reap.js";

/**
 * CADENCE-AWARE FLOW ASSERTION — "is this source actually producing?", asked
 * over a whole cadence window instead of one run.
 *
 * This exists because `evaluateSourceHealth` cannot answer the question, for two
 * structural reasons found in the 2026-07-27 fleet audit:
 *
 *  1. It reads `source_runs`. A source that has NEVER RUN has no rows, so it is
 *     not evaluated — it is absent from the result set entirely. Nine sources
 *     were in that state, including `seattle_design_review`, which has a
 *     committed adapter AND a passing test. The fix is the shape of this
 *     module: iterate CONFIG first, then LEFT JOIN runs. A source can only be
 *     reported missing by something that knew to expect it.
 *
 *  2. It judges the LATEST run. 13 of 29 enabled sources showed
 *     `parsed_count = 0` on their most recent run; aggregating across all runs
 *     showed only two were genuinely empty. A single-run check would have
 *     flagged 13 sources and been wrong about 11 — precisely the false-alarm
 *     flood that makes an alert channel worth ignoring.
 *
 * Three deliberate choices follow from that:
 *
 *  - **Usable output is parsed + duplicate + unchanged**, not `parsed` alone. A
 *    weekly source whose artifacts are hash-identical today is working
 *    perfectly; `unchanged` is the proof, not the absence of it.
 *  - **Orphans are excluded from the judgement.** A run that never wrote its
 *    terminal row has UNKNOWN counters, not zero. Reading its zeros as an
 *    observation invents a diagnosis — the same trap `health.ts` documents.
 *  - **on_demand sources are out of scope.** They have no cadence to measure
 *    against; the capture-fed operator-local sources run when an operator
 *    stages a capture, so a datacenter clock has nothing useful to say.
 */

/**
 * How long a source may produce nothing before that is a finding.
 *
 * Deliberately wider than the cadence itself: a daily source that misses one
 * night has not stopped working, and this check is meant to be quiet enough
 * that firing means something. 2× cadence plus slack, which is also the ratio
 * `evaluateSourceHealth` already uses for staleness.
 */
export const FLOW_WINDOW_HOURS: Record<string, number> = {
  daily: 48,
  weekly: 240, // 10 days
  monthly: 960, // 40 days — a monthly report posts after month end
};

export type SourceFlowState =
  /** Producing usable records inside its window. */
  | "flowing"
  /** In config, never executed once. Invisible to any run-table-only check. */
  | "never_ran"
  /** Has run before, but not at all inside the window — nothing is invoking it. */
  | "no_run_in_window"
  /** Ran inside the window and produced no usable records at all. */
  | "no_records_in_window"
  /** Every run in the window was orphaned: the counters were never written, so
   *  this is the absence of an answer rather than a bad one. */
  | "unknown";

export interface SourceFlowReport {
  sourceKey: string;
  cadence: string;
  state: SourceFlowState;
  /** True for every state except `flowing` — what an alert should act on. */
  flagged: boolean;
  reason: string;
  windowHours: number;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  runsInWindow: number;
  orphanRunsInWindow: number;
  /** parsed + duplicate + unchanged, over non-orphaned runs in the window. */
  recordsInWindow: number;
}

/**
 * Sources this check is responsible for: enabled, on a real cadence, and
 * fetchable by the scheduler. Mirrors `schedulableSources` in the worker, plus
 * `fixture` — `fake_source` is a test harness and alerting on it is noise.
 */
export function flowCheckedSources(sources: SourceConfig[]): SourceConfig[] {
  return sources.filter(
    (s) =>
      s.enabled &&
      s.cadence !== "on_demand" &&
      s.access_class !== "private_authorized" &&
      s.access_class !== "fixture",
  );
}

interface FlowRow {
  key: string;
  cadence: string;
  window_hours: number;
  seeded: boolean;
  last_run_at: string | null;
  last_success_at: string | null;
  runs_in_window: string | number;
  orphans_in_window: string | number;
  records_in_window: string | number;
}

export interface AssertSourceFlowOptions {
  now?: Date;
  /** Override the config set (tests, and a scoped re-check). */
  sources?: SourceConfig[];
}

/**
 * One report per config-declared, cadence-scheduled source — including the ones
 * with no rows in `source_runs` at all.
 */
export async function assertSourceFlow(
  db: Db,
  opts: AssertSourceFlowOptions = {},
): Promise<SourceFlowReport[]> {
  const now = opts.now ?? new Date();
  const checked = flowCheckedSources(opts.sources ?? loadSourcesConfig().sources);
  if (checked.length === 0) return [];

  // Handed over as ONE json parameter rather than three arrays: drizzle's `sql`
  // template spreads a JS array into separate placeholders, which turns
  // `${keys}::text[]` into a scalar and fails with "malformed array literal".
  const wanted = JSON.stringify(
    checked.map((s) => ({
      key: s.key,
      cadence: s.cadence,
      window_hours: FLOW_WINDOW_HOURS[s.cadence] ?? FLOW_WINDOW_HOURS.daily!,
    })),
  );

  // The LEFT JOIN from `wanted` is the entire point: a config key with no
  // `sources` row and no `source_runs` rows still comes back, with zeros.
  const res = await db.execute(sql`
    WITH wanted AS (
      SELECT * FROM json_to_recordset(${wanted}::json)
        AS t(key text, cadence text, window_hours int)
    )
    SELECT
      w.key,
      w.cadence,
      w.window_hours,
      (s.id IS NOT NULL) AS seeded,
      r.last_run_at,
      r.last_success_at,
      COALESCE(r.runs_in_window, 0)    AS runs_in_window,
      COALESCE(r.orphans_in_window, 0) AS orphans_in_window,
      COALESCE(r.records_in_window, 0) AS records_in_window
    FROM wanted w
    LEFT JOIN sources s ON s.key = w.key
    LEFT JOIN LATERAL (
      SELECT
        max(x.started_at) AS last_run_at,
        max(x.completed_at) FILTER (
          WHERE x.status IN ('succeeded', 'completed_with_errors') AND NOT x.is_orphan
        ) AS last_success_at,
        count(*) FILTER (WHERE x.in_window) AS runs_in_window,
        count(*) FILTER (WHERE x.in_window AND x.is_orphan) AS orphans_in_window,
        COALESCE(sum(
          COALESCE(x.parsed_count, 0)
          + COALESCE(x.duplicate_count, 0)
          + COALESCE(x.unchanged_count, 0)
        ) FILTER (WHERE x.in_window AND NOT x.is_orphan), 0) AS records_in_window
      FROM (
        SELECT
          sr.*,
          sr.started_at >= ${now.toISOString()}::timestamptz
            - make_interval(hours => w.window_hours) AS in_window,
          (
            sr.metrics_json ->> 'orphaned' = 'true'
            OR sr.metrics_json ->> 'reason' = ${ORPHAN_REASON}
          ) IS TRUE AS is_orphan
        FROM source_runs sr
        WHERE sr.source_id = s.id
      ) x
    ) r ON true
    ORDER BY w.key`);

  return (res.rows as unknown as FlowRow[]).map((row) => {
    const runsInWindow = Number(row.runs_in_window);
    const orphanRunsInWindow = Number(row.orphans_in_window);
    const recordsInWindow = Number(row.records_in_window);
    const windowHours = Number(row.window_hours);
    const lastRunAt = row.last_run_at ? new Date(row.last_run_at) : null;
    const lastSuccessAt = row.last_success_at ? new Date(row.last_success_at) : null;

    const base = {
      sourceKey: row.key,
      cadence: row.cadence,
      windowHours,
      lastRunAt,
      lastSuccessAt,
      runsInWindow,
      orphanRunsInWindow,
      recordsInWindow,
    };

    // Ordered most-diagnostic first: "never ran" and "not invoked" are different
    // failures from "ran and came back empty", and collapsing them would hide
    // the one this fleet actually has.
    if (!lastRunAt) {
      return {
        ...base,
        state: "never_ran" as const,
        flagged: true,
        reason: row.seeded
          ? "enabled in config and seeded, but has never executed once"
          : "enabled in config but not seeded in the database, and has never executed",
      };
    }
    if (runsInWindow === 0) {
      const ageHours = (now.getTime() - lastRunAt.getTime()) / 3_600_000;
      return {
        ...base,
        state: "no_run_in_window" as const,
        flagged: true,
        reason: `no run at all in the last ${windowHours}h (${row.cadence}); last run ${Math.round(ageHours)}h ago — nothing is invoking this source`,
      };
    }
    if (orphanRunsInWindow === runsInWindow) {
      return {
        ...base,
        state: "unknown" as const,
        flagged: true,
        reason: `all ${runsInWindow} run(s) in the last ${windowHours}h died without writing a terminal row — output is unknown, not zero`,
      };
    }
    if (recordsInWindow === 0) {
      return {
        ...base,
        state: "no_records_in_window" as const,
        flagged: true,
        reason: `${runsInWindow} run(s) in the last ${windowHours}h produced no usable records (parsed + duplicate + unchanged all zero)`,
      };
    }
    return {
      ...base,
      state: "flowing" as const,
      flagged: false,
      reason: `${recordsInWindow} usable record(s) across ${runsInWindow} run(s) in the last ${windowHours}h`,
    };
  });
}
