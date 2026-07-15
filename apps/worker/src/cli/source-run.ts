import "../load-env.js";
import { createDb, createPool } from "@otn/db";
import { createLogger, evaluateSourceHealth } from "@otn/source-sdk";
import { executeSourceRun } from "../jobs.js";

// pnpm source:run <source-key> [--shadow]
async function main() {
  const args = process.argv.slice(2);
  const sourceKey = args.find((a) => !a.startsWith("--"));
  if (!sourceKey) {
    console.error("usage: pnpm source:run <source-key> [--shadow]");
    process.exit(2);
  }
  const allowDisabled = args.includes("--shadow");
  const logger = createLogger({ app: "source-run-cli" });
  const pool = createPool();
  const db = createDb(pool);
  try {
    const result = await executeSourceRun(db, { sourceKey, allowDisabled }, logger);
    const health = await evaluateSourceHealth(db, sourceKey);
    logger.info({ result: result.metrics, status: result.status, health }, "run finished");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
