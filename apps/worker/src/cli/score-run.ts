import "../load-env.js";
import { createDb, createPool } from "@otn/db";
import { createLogger } from "@otn/source-sdk";
import { scoreAll } from "@otn/intelligence";

// pnpm score:run
async function main() {
  const logger = createLogger({ app: "score-run-cli" });
  const pool = createPool();
  const db = createDb(pool);
  try {
    const summary = await scoreAll(db, { logger });
    logger.info({ summary }, "score run finished");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
