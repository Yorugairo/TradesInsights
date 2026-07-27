/**
 * Reap source runs that never reached a terminal state.
 *
 * `executeSourceRun` inserts a `source_runs` row at `status='running'` and
 * updates it to a terminal status on the way out — down BOTH exits, the success
 * path and the catch. If the process dies between those two points (pooler drop,
 * OOM, SIGKILL, a watchdog relaunch), the row stays `running` with null metrics
 * FOREVER. `evaluateSourceHealth` filters `status !== 'running'` before it looks
 * at anything, so an orphan is not merely unreported — it is invisible, and the
 * source's last genuinely-successful run keeps the dashboard green while the
 * feed silently stops.
 *
 * That is not hypothetical: `bellevue_permits_arcgis` left TWO such rows on
 * 2026-07-27 (77 and 52 minutes old, `discovered_count = 0`, `metrics_json`
 * null) and the source read healthy throughout.
 */
import { and, eq, lt, sql } from "drizzle-orm";
import type { Db } from "@otn/db";
import { sourceRuns, withConnectionRetry } from "@otn/db";
import type { Logger } from "pino";

/**
 * How long a run may sit in `running` before it is presumed dead.
 *
 * MEASURED, not guessed — across all 80 completed runs in production on
 * 2026-07-27:
 *
 *   slowest legitimate run   8.8 min   pierce_permits_arcgis, 6,145 parsed
 *   p99                      6.9 min
 *   p95                      4.4 min
 *   mean                     0.7 min
 *
 * (The plan cited `king_permit_reports` at 3,082 records as the high-water mark;
 * measuring found pierce at double that, which is exactly why this is measured.)
 *
 * One hour is ~7x the slowest run ever observed, leaving room for a source to
 * grow several-fold or a first-time backfill to run long before it trips.
 *
 * The asymmetry also favours a decisive threshold: reaping a run that is
 * actually still alive is SELF-HEALING, because both terminal writes in
 * `runner.ts` are unconditional `UPDATE ... WHERE id = $1` — a live process
 * overwrites the reaped row with the truth when it finishes. Reaping too late
 * leaves a health blind spot that nothing else closes. Wrong-early costs a
 * transient amber; wrong-late costs a silently dead feed.
 */
export const ORPHAN_RUN_THRESHOLD_MS = 60 * 60 * 1000;

/** Stamped into `metrics_json.reason` so an orphan is distinguishable from a run
 * that genuinely errored and said so. */
export const ORPHAN_REASON = "orphaned_no_terminal_write";

/**
 * True when a run was reaped rather than having reported its own outcome.
 *
 * Load-bearing beyond reporting: an orphan's counters were never written, so
 * they are UNKNOWN, not measured. Health checks that read `parsedCount` /
 * `discoveredCount` as observations must skip these rows or they invent
 * conclusions from zeros the pipeline never counted.
 */
export function isOrphanedRun(run: { metricsJson: unknown }): boolean {
  const m = run.metricsJson as { orphaned?: unknown; reason?: unknown } | null;
  return !!m && (m.orphaned === true || m.reason === ORPHAN_REASON);
}

export interface ReapedRun {
  sourceRunId: string;
  sourceId: string;
  startedAt: Date;
  ageMinutes: number;
}

export interface ReapOptions {
  /** Override the threshold (tests, and a deliberately wider sweep). */
  olderThanMs?: number;
  /** Injectable clock so a test need not wait an hour. */
  now?: Date;
  logger?: Logger;
}

/**
 * Mark every `running` row older than the threshold as `completed_with_errors`
 * with an explicit `orphaned_no_terminal_write` reason.
 *
 * `completed_with_errors` rather than `failed`: we do not know that the FETCH
 * failed — thurston's near-miss on the same day proves a run can parse cleanly
 * and lose only its bookkeeping write. Claiming "failed" would assert something
 * unobserved. What is certain is that the run did not finish reporting, and
 * `evaluateSourceHealth` treats that as amber (red on a second consecutive one)
 * while explicitly NOT counting it as a success.
 */
export async function reapOrphanedRuns(db: Db, options: ReapOptions = {}): Promise<ReapedRun[]> {
  const now = options.now ?? new Date();
  const thresholdMs = options.olderThanMs ?? ORPHAN_RUN_THRESHOLD_MS;
  const cutoff = new Date(now.getTime() - thresholdMs);

  // A single statement, so there is no select-then-update window in which a
  // finishing run could be clobbered. `status = 'running'` in the WHERE is the
  // guard: a run that reaches its terminal write first is simply not matched.
  const reaped = await withConnectionRetry(
    () =>
      db
        .update(sourceRuns)
        .set({
          completedAt: now,
          status: "completed_with_errors",
          errorCount: sql`${sourceRuns.errorCount} + 1`,
          // Merge rather than replace. Today an orphan's metrics are always null
          // (only the terminal writes populate them), but clobbering a column we
          // did not author is the kind of assumption that rots.
          metricsJson: sql`coalesce(${sourceRuns.metricsJson}, '{}'::jsonb) || ${JSON.stringify(
            {
              orphaned: true,
              reason: ORPHAN_REASON,
              reapedAt: now.toISOString(),
              thresholdMinutes: Math.round(thresholdMs / 60_000),
            },
          )}::jsonb`,
        })
        .where(and(eq(sourceRuns.status, "running"), lt(sourceRuns.startedAt, cutoff)))
        .returning({
          sourceRunId: sourceRuns.id,
          sourceId: sourceRuns.sourceId,
          startedAt: sourceRuns.startedAt,
        }),
    {
      onRetry: (attempt, err) =>
        options.logger?.warn(
          { attempt, err: String(err) },
          "transient fault reaping orphaned source runs — retrying",
        ),
    },
  );

  const rows: ReapedRun[] = reaped.map((r) => ({
    ...r,
    ageMinutes: Math.round((now.getTime() - r.startedAt.getTime()) / 60_000),
  }));

  if (rows.length > 0) {
    // warn, not info: a reaped run means a process died without saying so. The
    // reap makes it visible; it does not make it fine.
    options.logger?.warn(
      { reaped: rows.length, thresholdMinutes: Math.round(thresholdMs / 60_000), rows },
      "reaped source runs that never wrote a terminal row",
    );
  }

  return rows;
}
