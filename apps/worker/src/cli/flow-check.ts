import "../load-env.js";
import { createDb, createPool } from "@otn/db";
import { assertSourceFlow, createLogger } from "@otn/source-sdk";

/**
 * pnpm flow:check [--all]
 *
 * "Is every source that config says is running, actually producing?" — read
 * only, safe to run any time.
 *
 * Distinct from `evaluateSourceHealth`, which starts from `source_runs` and so
 * cannot see a source that has never run. This starts from CONFIG, which is the
 * only way a missing source can be reported by something that knew to expect it.
 *
 * Prints flagged sources by default; `--all` includes the healthy ones.
 * Exit code 1 when anything is flagged, so a cron can treat it as a check.
 */
async function main() {
  const showAll = process.argv.includes("--all");
  const logger = createLogger({ app: "flow-check-cli" });
  const pool = createPool();
  const db = createDb(pool);
  try {
    const reports = await assertSourceFlow(db);
    const flagged = reports.filter((r) => r.flagged);

    for (const r of reports) {
      if (!r.flagged && !showAll) continue;
      const line = `${r.flagged ? "FLAG" : "ok  "}  ${r.sourceKey.padEnd(34)} ${r.state.padEnd(21)} ${r.reason}`;
      console.log(line);
    }

    const byState: Record<string, number> = {};
    for (const r of reports) byState[r.state] = (byState[r.state] ?? 0) + 1;
    logger.info(
      { checked: reports.length, flagged: flagged.length, byState },
      "source flow check complete",
    );
    if (flagged.length > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
