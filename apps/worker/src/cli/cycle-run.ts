import "../load-env.js";
import { createDb, createPool } from "@otn/db";
import { loadSourcesConfig } from "@otn/config";
import { createLogger, evaluateSourceHealth } from "@otn/source-sdk";
import { executeSourceRun } from "../jobs.js";
import { runMaintenance, schedulableSources } from "../schedules.js";

/**
 * pnpm cycle:run — ONE command for a full ingest-to-scores cycle.
 *
 * The pieces all existed; nothing joined them. `source:run` takes a SINGLE
 * source key, so running "everything" by hand meant 29 invocations followed by
 * `maintenance:run` — and the predictable outcome was that it did not happen:
 * on 2026-07-27 every large permit feed was six days stale while the scores on
 * top of them were being refreshed by hand.
 *
 * This is deliberately the same two halves the scheduler runs, in the same
 * order, over the SAME source set:
 *
 *   1. fetch every schedulable source   (what the per-source crons do at 02–03:xx)
 *   2. runMaintenance()                 (what `pipeline-maintenance` does at 04:45)
 *
 * `schedulableSources` is imported rather than re-filtered so the on-demand path
 * can never drift from the scheduled one — if a source is skipped by cron it is
 * skipped here, for the same reason.
 *
 * This does NOT replace `pnpm worker`. The worker is the recurring, self-driving
 * form and remains the right answer for steady state; this is the "I just
 * finished working the review queue and want everything current NOW" entry
 * point, and the honest fallback whenever the worker is not running.
 *
 * Usage:
 *   pnpm cycle:run                     # fetch all schedulable sources, then the chain
 *   pnpm cycle:run --skip-sources      # chain only (sources already fresh)
 *   pnpm cycle:run --only=wa_sepa,king_permit_reports
 *   pnpm cycle:run --sources-only      # fetch only, skip the chain
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (n: string) => argv.includes(`--${n}`);
  const arg = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");

  const skipSources = flag("skip-sources");
  const skipChain = flag("sources-only");
  const only = (arg("only") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const logger = createLogger({ app: "cycle-run-cli" });
  const started = Date.now();

  const sourceSummary: {
    attempted: number;
    succeeded: number;
    failed: string[];
    /** Ran without throwing, but health says the feed is degraded. */
    red: string[];
    parsed: number;
  } = { attempted: 0, succeeded: 0, failed: [], red: [], parsed: 0 };

  if (!skipSources) {
    const all = schedulableSources(loadSourcesConfig().sources);
    const wanted = only.length > 0 ? all.filter((s) => only.includes(s.key)) : all;
    if (only.length > 0) {
      const missing = only.filter((k) => !all.some((s) => s.key === k));
      // Loud, because a typo'd key would otherwise look like a clean run that
      // simply fetched nothing.
      if (missing.length > 0) logger.warn({ missing }, "requested sources are not schedulable — skipped");
    }

    const pool = createPool();
    const db = createDb(pool);
    try {
      for (const s of wanted) {
        sourceSummary.attempted++;
        try {
          // Sequential on purpose: these are other people's county servers, and
          // the scheduler staggers for the same reason. Throughput is not the
          // goal here — being able to run the whole thing unattended is.
          const result = await executeSourceRun(db, { sourceKey: s.key }, logger);
          const health = await evaluateSourceHealth(db, s.key);
          sourceSummary.succeeded++;
          sourceSummary.parsed += result.metrics?.parsed ?? 0;
          logger.info(
            {
              source: s.key,
              status: result.status,
              parsed: result.metrics?.parsed ?? 0,
              health: health.state,
              // A source can "succeed" and still be red (stale beyond cadence,
              // required-field collapse, zero usable records). Carry the reasons
              // so a degraded feed is visible in the cycle log rather than only
              // on a health page nobody opens.
              ...(health.state === "green" ? {} : { healthReasons: health.reasons }),
            },
            "source run finished",
          );
          if (health.state === "red") sourceSummary.red.push(s.key);
        } catch (err) {
          // One county returning a 500 must not cost us the other 28 sources AND
          // the maintenance chain. Record and carry on; the summary reports it.
          sourceSummary.failed.push(s.key);
          logger.error({ source: s.key, err: String(err) }, "source run failed — continuing");
        }
      }
    } finally {
      await pool.end();
    }
  }

  if (!skipChain) {
    // resolution -> record updates -> developments -> velocity/campus -> geometry
    // -> geocode -> stage-lag -> corroboration -> registry seam -> scoring -> alerts
    await runMaintenance(logger);
  }

  logger.info(
    {
      sources: skipSources ? "skipped" : sourceSummary,
      chain: skipChain ? "skipped" : "complete",
      minutes: Math.round((Date.now() - started) / 60_000),
    },
    "cycle complete",
  );

  // A cycle where sources failed is not a success, even though the chain ran on
  // whatever did land. Exit non-zero so a wrapper or scheduled task notices.
  if (sourceSummary.failed.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
