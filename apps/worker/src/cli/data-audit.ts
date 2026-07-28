import "../load-env.js";
import { createDb, createPool } from "@otn/db";
import { createLogger } from "@otn/source-sdk";
import { collect, failedInvariants, render } from "../data-audit.js";

/**
 * pnpm audit:data — the graph's health, as a command instead of a chat session.
 *
 * Thin on purpose: every query and every judgement lives in ../data-audit.ts so
 * a test can import it without this file's `main()` firing on import. See that
 * module's header for what counts as an invariant and what counts as a fact.
 *
 * Usage:
 *   pnpm audit:data            # human-readable report
 *   pnpm audit:data --json     # one JSON object, for diffing runs
 */
async function main(): Promise<void> {
  const asJson = process.argv.slice(2).includes("--json");
  const logger = createLogger({ app: "data-audit-cli" });
  const pool = createPool();
  const db = createDb(pool);
  try {
    const audit = await collect(db);
    const failures = failedInvariants(audit);

    if (asJson) {
      console.log(JSON.stringify({ audit, failures }, null, 2));
    } else {
      console.log(render(audit));
      console.log("");
      if (failures.length === 0) {
        console.log("INVARIANTS OK — everything above is a measurement, not a verdict.");
      } else {
        for (const f of failures) console.log(`INVARIANT FAILED: ${f}`);
      }
    }

    if (failures.length > 0) {
      logger.error({ failures }, "data audit invariants failed");
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
