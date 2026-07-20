import "../load-env.js";
import { loadSourcesConfig } from "@otn/config";
import { createDb, createPool } from "@otn/db";
import { createLogger, evaluateSourceHealth } from "@otn/source-sdk";
import { executeSourceRun } from "../jobs.js";
import { operatorLocalSources } from "../schedules.js";

// pnpm source:run:operator-local [--shadow]
//
// The OPERATOR-LOCAL daily batch: runs every enabled `on_demand` source (Olympia
// / Tumwater — genuine-visitor capture-fed sources the datacenter scheduler never
// touches). Run it from the operator's in-region machine. Block types differ:
// Olympia's is egress-IP based (a live in-region fetch can succeed) and also
// session-eid capture-fed; Tumwater's Akamai policy fingerprints the automated
// CLIENT, so fetch() 403s even in-region and the adapter parses a genuine-browser
// capture staged into fixtures/<key>/. Either way: stage the day's captures with a
// real browser first, then cron this. Never a bot/WAF bypass. Each source runs
// independently — one failure/dead-letter never aborts the rest.
async function main() {
  const shadow = process.argv.slice(2).includes("--shadow");
  const logger = createLogger({ app: "source-run-operator-local" });
  const keys = operatorLocalSources(loadSourcesConfig().sources).map((s) => s.key);
  if (keys.length === 0) {
    logger.info({}, "no enabled operator-local (on_demand) sources — nothing to run");
    return;
  }
  logger.info({ keys }, `operator-local batch: ${keys.length} source(s)`);

  const pool = createPool();
  const db = createDb(pool);
  let failures = 0;
  try {
    for (const sourceKey of keys) {
      try {
        const result = await executeSourceRun(db, { sourceKey, allowDisabled: shadow }, logger);
        const health = await evaluateSourceHealth(db, sourceKey);
        logger.info({ sourceKey, result: result.metrics, status: result.status, health }, "source finished");
      } catch (err) {
        failures += 1;
        logger.error({ sourceKey, err }, "source failed — continuing with the rest");
      }
    }
  } finally {
    await pool.end();
  }
  if (failures > 0) process.exitCode = 1; // visible non-zero for the operator's cron
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
