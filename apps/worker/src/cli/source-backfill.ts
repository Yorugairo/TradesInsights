import "../load-env.js";
import { createDb, createPool } from "@otn/db";
import { createLogger, evaluateSourceHealth } from "@otn/source-sdk";
import { executeSourceRun } from "../jobs.js";

// pnpm source:backfill <source-key> --from YYYY-MM-DD --to YYYY-MM-DD [--shadow]
async function main() {
  const args = process.argv.slice(2);
  const sourceKey = args.find((a) => !a.startsWith("--"));
  const from = args[args.indexOf("--from") + 1];
  const to = args[args.indexOf("--to") + 1];
  if (!sourceKey || !args.includes("--from") || !args.includes("--to") || !from || !to) {
    console.error(
      "usage: pnpm source:backfill <source-key> --from YYYY-MM-DD --to YYYY-MM-DD [--shadow]",
    );
    process.exit(2);
  }
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(from) || !dateRe.test(to)) {
    console.error("--from and --to must be YYYY-MM-DD");
    process.exit(2);
  }
  const logger = createLogger({ app: "source-backfill-cli" });
  const pool = createPool();
  const db = createDb(pool);
  try {
    const result = await executeSourceRun(
      db,
      { sourceKey, allowDisabled: args.includes("--shadow"), backfill: { from, to } },
      logger,
    );
    const health = await evaluateSourceHealth(db, sourceKey);
    logger.info(
      { result: result.metrics, status: result.status, backfill: { from, to }, health },
      "backfill finished",
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
