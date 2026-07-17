import "../load-env.js";
import { createDb, createPool } from "@otn/db";
import { createLogger } from "@otn/source-sdk";
import { geocodeProjects, materializeProjectGeometry } from "@otn/resolution";

// pnpm geocode:run [--limit N] [--county King] [--delay-ms 150]
// Pass 1 heals project geometry from resolved records (no network); pass 2
// asks the US Census geocoder (official, free) for address-only projects,
// accepting only unique matches whose returned county equals the project's.
async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const limit = flag("--limit") ? Number(flag("--limit")) : undefined;
  const county = flag("--county");
  const delayMs = flag("--delay-ms") ? Number(flag("--delay-ms")) : undefined;

  const logger = createLogger({ app: "geocode-run-cli" });
  const pool = createPool();
  const db = createDb(pool);
  try {
    const materialized = await materializeProjectGeometry(db, { logger });
    const geocoded = await geocodeProjects(db, {
      ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
      ...(county ? { county } : {}),
      ...(delayMs !== undefined && Number.isFinite(delayMs) ? { delayMs } : {}),
      logger,
    });
    logger.info({ materialized, geocoded }, "geocode run finished");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
