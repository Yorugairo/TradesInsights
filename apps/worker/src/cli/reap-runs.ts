import "../load-env.js";
import { sql } from "drizzle-orm";
import { createDb, createPool } from "@otn/db";
import { createLogger, ORPHAN_RUN_THRESHOLD_MS, reapOrphanedRuns } from "@otn/source-sdk";

/**
 * pnpm runs:reap — close out source runs that never wrote a terminal row.
 *
 * The nightly chain does this automatically (`runMaintenance` runs it first).
 * This is the on-demand form, for the case that actually happens: you notice a
 * source has been "running" for an hour and want the ledger corrected NOW,
 * without paying for the whole resolve→score chain to find out.
 *
 * Usage:
 *   pnpm runs:reap                 # default threshold (60 min)
 *   pnpm runs:reap --dry-run       # list what WOULD be reaped, change nothing
 *   pnpm runs:reap --older-than=30 # minutes
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const minutes = argv.find((a) => a.startsWith("--older-than="))?.split("=")[1];
  const olderThanMs = minutes ? Number(minutes) * 60_000 : ORPHAN_RUN_THRESHOLD_MS;

  if (minutes !== undefined && (!Number.isFinite(olderThanMs) || olderThanMs <= 0)) {
    throw new Error(`--older-than must be a positive number of minutes, got "${minutes}"`);
  }

  const logger = createLogger({ app: "reap-runs-cli" });
  const pool = createPool();
  const db = createDb(pool);
  try {
    if (dryRun) {
      // Deliberately a SEPARATE read rather than a transaction-and-rollback:
      // the point of a dry run is to touch nothing, and a rolled-back UPDATE
      // still takes row locks on live rows a running worker may be writing.
      const rows = await db.execute<{ id: string; source_key: string; age_minutes: string }>(sql`
        select sr.id, s.key as source_key,
               round(extract(epoch from (now() - sr.started_at))::numeric / 60, 1) as age_minutes
        from source_runs sr
        join sources s on s.id = sr.source_id
        where sr.status = 'running'
          and sr.started_at < now() - make_interval(mins => ${Math.round(olderThanMs / 60_000)})
        order by sr.started_at
      `);
      logger.info(
        { dryRun: true, thresholdMinutes: Math.round(olderThanMs / 60_000), candidates: rows.rows },
        `${rows.rows.length} run(s) would be reaped`,
      );
      return;
    }

    const reaped = await reapOrphanedRuns(db, { olderThanMs, logger });
    logger.info(
      { reaped: reaped.length, thresholdMinutes: Math.round(olderThanMs / 60_000) },
      reaped.length === 0 ? "no orphaned runs" : "orphaned runs closed",
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
