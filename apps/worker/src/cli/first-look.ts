import "../load-env.js";
import { createDb, createPool } from "@otn/db";
import { createLogger } from "@otn/source-sdk";
import { firstLookByCoverage } from "@otn/delivery";

// pnpm first-look [--min N] [--include-test]
// The "we see it first" proof: per source × county, the median days our
// earliest sighting of a project predates its permit-issued (publicly biddable)
// milestone. Groups below the sample floor are dropped, not published thin.
async function main() {
  const logger = createLogger({ app: "first-look-cli" });
  const args = process.argv.slice(2);
  const minSamples = args.includes("--min") ? Number(args[args.indexOf("--min") + 1]) : undefined;
  const includeTestSources = args.includes("--include-test");

  const pool = createPool();
  const db = createDb(pool);
  try {
    const rows = await firstLookByCoverage(db, {
      ...(minSamples !== undefined ? { minSamples } : {}),
      includeTestSources,
    });
    if (rows.length === 0) {
      logger.info({}, "no source×county group meets the sample floor yet");
      return;
    }
    for (const r of rows) {
      logger.info(
        {
          source: r.sourceKey,
          county: r.county ?? "(statewide)",
          projects: r.projects,
          medianLeadDays: r.medianLeadDays,
          p25: r.p25Days,
          p75: r.p75Days,
          shareEarly: r.shareEarly,
        },
        `${r.sourceKey} / ${r.county ?? "statewide"}: median ${r.medianLeadDays}d before permit (n=${r.projects})`,
      );
    }
    logger.info({ groups: rows.length }, "first-look coverage computed");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
