import "../load-env.js";
import { createDb, createPool } from "@otn/db";
import { createLogger } from "@otn/source-sdk";
import { deliveryQualityMetrics } from "@otn/delivery";

// pnpm delivery:metrics — measured duplicate/expired rates over stored
// digests vs the M4 gates (<3% duplicates, <2% expired). Exit 1 on gate fail.
async function main() {
  const logger = createLogger({ app: "delivery-metrics-cli" });
  const pool = createPool();
  const db = createDb(pool);
  try {
    const metrics = await deliveryQualityMetrics(db);
    const pass = metrics.gates.duplicatePass && metrics.gates.expiredPass;
    logger.info({ metrics }, pass ? "DELIVERY GATES PASS" : "DELIVERY GATES FAIL");
    if (!pass) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
