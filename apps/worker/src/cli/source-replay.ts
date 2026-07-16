import "../load-env.js";
import { getAdapter } from "@otn/adapters";
import { createDb, createPool } from "@otn/db";
import { createLogger, replaySource, S3ObjectStore, s3ConfigFromEnv } from "@otn/source-sdk";

// pnpm source:replay <source-key>
// Reprocesses a source's stored immutable artifacts through the CURRENT adapter
// (no re-fetch), healing already-stored records after a parser fix. Idempotent:
// an unchanged parser rewrites nothing.
async function main() {
  const sourceKey = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!sourceKey) {
    console.error("usage: pnpm source:replay <source-key>");
    process.exit(2);
  }
  const logger = createLogger({ app: "source-replay-cli" });
  const adapter = getAdapter(sourceKey);
  const objectStore = new S3ObjectStore(s3ConfigFromEnv());
  await objectStore.ensureBucket();
  const pool = createPool();
  const db = createDb(pool);
  try {
    const result = await replaySource({ db, adapter, objectStore, logger });
    logger.info({ result }, "replay finished");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
