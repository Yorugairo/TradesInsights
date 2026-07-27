import "../load-env.js";
import { createDb, createPool } from "@otn/db";
import { createLogger, evaluateSourceHealth } from "@otn/source-sdk";
import { loadSourcesConfig, type SourceConfig } from "@otn/config";
import { executeSourceRun } from "../jobs.js";
import { schedulableSources } from "../schedules.js";

/**
 * pnpm source:run:cadence --cadence=daily [--dry-run]
 *
 * Run every schedulable source of one cadence, SEQUENTIALLY, continuing past
 * failures. This is the entry point a scheduler outside the process calls —
 * GitHub Actions today (.github/workflows/source-fleet.yml).
 *
 * WHY SEQUENTIAL, and why this does not reproduce `cadenceCron`'s stagger.
 *
 * `registerSchedules` gives each source its own cron minute inside a 02:00–03:59
 * Pacific window, hashed from the key, so 29 sources never hit county
 * infrastructure at the same instant. That design assumes a long-running
 * pg-boss worker. Reproducing it in GitHub Actions would mean up to 60 schedule
 * entries in one workflow file to cover 60 possible stagger minutes, and GH
 * cron is best-effort with delays of 5–15 minutes anyway, so the precision
 * would be fictional.
 *
 * Running the set one at a time honours the stagger's PURPOSE more strictly
 * than the stagger did: at any moment exactly one county server is being
 * fetched, rather than one-per-minute with overlap. Cost is wall-clock inside a
 * single runner, and the measured numbers say that is affordable — across 80
 * production runs the mean was 0.7 min, p99 6.9 min, slowest ever 8.8 min
 * (pierce, 6,145 records). ~21 daily sources is well inside a runner's 6h cap.
 *
 * A source that throws does NOT stop the set. One county being down is not a
 * reason to skip the other twenty; the exit code carries the failure count so
 * the workflow still goes red.
 */
function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

const CADENCES = ["daily", "weekly", "monthly"] as const;
type Cadence = (typeof CADENCES)[number];

async function main() {
  const requested = arg("cadence");
  if (!requested || !CADENCES.includes(requested as Cadence)) {
    console.error(`usage: pnpm source:run:cadence --cadence=<${CADENCES.join("|")}> [--dry-run]`);
    process.exit(2);
  }
  const cadence = requested as Cadence;
  const dryRun = process.argv.includes("--dry-run");

  // Same predicate the pg-boss scheduler uses, so the two never disagree about
  // which sources are the datacenter's business. on_demand (capture-fed,
  // operator-local) and private_authorized are excluded there and here.
  const all: SourceConfig[] = loadSourcesConfig().sources;
  const targets = schedulableSources(all).filter((s) => s.cadence === cadence);

  const logger = createLogger({ app: "source-run-cadence" });
  logger.info({ cadence, count: targets.length, keys: targets.map((s) => s.key) }, "cadence set");

  if (dryRun) {
    for (const s of targets) console.log(s.key);
    return;
  }
  if (targets.length === 0) return;

  const pool = createPool();
  const db = createDb(pool);
  const failures: { sourceKey: string; error: string }[] = [];
  let succeeded = 0;

  try {
    for (const source of targets) {
      try {
        const result = await executeSourceRun(db, { sourceKey: source.key }, logger);
        const health = await evaluateSourceHealth(db, source.key);
        logger.info(
          { sourceKey: source.key, status: result.status, metrics: result.metrics, health: health.state },
          "source run finished",
        );
        if (result.status === "failed") {
          failures.push({ sourceKey: source.key, error: `run status ${result.status}` });
        } else {
          succeeded++;
        }
      } catch (err) {
        // Keep going. The whole point of a fleet run is that it is not
        // all-or-nothing.
        const error = err instanceof Error ? err.message : String(err);
        failures.push({ sourceKey: source.key, error });
        logger.error({ sourceKey: source.key, err: error }, "source run threw — continuing");
      }
    }
  } finally {
    await pool.end();
  }

  logger.info(
    { cadence, attempted: targets.length, succeeded, failed: failures.length, failures },
    "cadence run complete",
  );
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
