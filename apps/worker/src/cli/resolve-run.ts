import "../load-env.js";
import { createDb, createPool } from "@otn/db";
import { createLogger } from "@otn/source-sdk";
import {
  buildDevelopments,
  computeCampusVelocity,
  computeClusterVelocity,
  materializeProjectGeometry,
  resolveUnresolved,
} from "@otn/resolution";

// pnpm resolve:run [--limit N]
async function main() {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : undefined;
  const logger = createLogger({ app: "resolve-run-cli" });
  const pool = createPool();
  const db = createDb(pool);
  try {
    const summary = await resolveUnresolved(db, {
      ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
      logger,
    });
    const developments = await buildDevelopments(db, { logger });
    const velocity = await computeClusterVelocity(db, { logger });
    const campus = await computeCampusVelocity(db, { logger });
    // Derived healing: projects resolved before the resolver wrote record
    // geometry get it materialized here (no network — record data only).
    const geometry = await materializeProjectGeometry(db, { logger });
    logger.info({ summary, developments, velocity, campus, geometry }, "resolve run finished");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
