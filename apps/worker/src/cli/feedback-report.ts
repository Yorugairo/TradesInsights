import "../load-env.js";
import { sql } from "drizzle-orm";
import { createDb, createPool } from "@otn/db";
import { createLogger } from "@otn/source-sdk";
import { feedbackSummary } from "@otn/intelligence";

// pnpm feedback:report [--account <key>]
// Calibration rollup per account (spec §22 input). Read-only: the operator
// uses this to draft the next rule version (appendRuleVersion); feedback is
// never auto-applied to rules.
async function main() {
  const logger = createLogger({ app: "feedback-report-cli" });
  const args = process.argv.slice(2);
  const accountArg = args.includes("--account") ? args[args.indexOf("--account") + 1] : null;

  const pool = createPool();
  const db = createDb(pool);
  try {
    const accounts = await db.execute(sql`
      SELECT id, key FROM account_profiles WHERE active = true
      ${accountArg ? sql`AND key = ${accountArg}` : sql``} ORDER BY key`);
    for (const account of accounts.rows as { id: string; key: string }[]) {
      const summary = await feedbackSummary(db, account.id);
      logger.info({ account: account.key, summary }, "feedback summary");
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
