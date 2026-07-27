import "../load-env.js";
import { createDb, createPool } from "@otn/db";
import { createLogger } from "@otn/source-sdk";
import { scoreAll } from "@otn/intelligence";

// pnpm score:run [--project <uuid> ...]
//
// `--project` limits the run to the named projects. The de-route sweep is scoped
// to whatever the run actually re-scored, so a narrow run is a surgical fix — it
// re-scores and, if the pair no longer routes, archives just those rows without
// putting ~9,000 upserts through the pooler.
async function main() {
  const logger = createLogger({ app: "score-run-cli" });
  const args = process.argv.slice(2);
  const projectIds = args.reduce<string[]>((ids, arg, i) => {
    if (arg === "--project" && args[i + 1]) ids.push(args[i + 1]!);
    return ids;
  }, []);
  const pool = createPool();
  const db = createDb(pool);
  try {
    const summary = await scoreAll(db, {
      logger,
      ...(projectIds.length > 0 ? { projectIds } : {}),
    });
    logger.info(
      { summary, scope: projectIds.length > 0 ? projectIds : "full corpus" },
      "score run finished",
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
