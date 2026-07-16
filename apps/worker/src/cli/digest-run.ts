import "../load-env.js";
import { sql } from "drizzle-orm";
import { createDb, createPool } from "@otn/db";
import { createLogger } from "@otn/source-sdk";
import { buildDigest, deliverDigest } from "@otn/delivery";

// pnpm digest:run [--account <key>] [--end YYYY-MM-DD] [--send]
// Builds (and optionally sends via SMTP/Mailpit) the weekly digest for one or
// all active accounts. Idempotent per (account, week): re-running returns the
// stored delivery instead of duplicating or re-sending it.
async function main() {
  const logger = createLogger({ app: "digest-run-cli" });
  const args = process.argv.slice(2);
  const accountArg = args.includes("--account") ? args[args.indexOf("--account") + 1] : null;
  const endArg = args.includes("--end") ? args[args.indexOf("--end") + 1] : null;
  const send = args.includes("--send");

  const periodEnd = endArg ? new Date(`${endArg}T00:00:00Z`) : new Date();
  const periodStart = new Date(periodEnd.getTime() - 7 * 86_400_000);

  const pool = createPool();
  const db = createDb(pool);
  try {
    const accounts = await db.execute(sql`
      SELECT id, key FROM account_profiles WHERE active = true
      ${accountArg ? sql`AND key = ${accountArg}` : sql``} ORDER BY key`);
    if (accounts.rows.length === 0) {
      logger.warn({ accountArg }, "no matching active accounts");
      return;
    }
    for (const account of accounts.rows as { id: string; key: string }[]) {
      const model = await buildDigest(db, account.id, { start: periodStart, end: periodEnd });
      const result = await deliverDigest(db, model, { send });
      logger.info(
        {
          account: account.key,
          deliveryId: result.deliveryId,
          status: result.status,
          created: result.created,
          sent: result.sent,
          sections: {
            priorityNew: model.sections.priorityNew.length,
            stageChanges: model.sections.stageChanges.length,
            missingFacts: model.sections.missingFacts.length,
            monitoring: model.sections.monitoring.length,
            coverageCaveats: model.sections.coverage.length,
          },
          suppressed: model.suppressed,
        },
        "digest processed",
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
