import "../load-env.js";
import { sql } from "drizzle-orm";
import { createDb, createPool } from "@otn/db";
import { createLogger } from "@otn/source-sdk";
import { evaluateGate } from "@otn/intelligence";

// pnpm gate:run [--opportunity <id>] [--limit N]
// Read-only §15 publication-gate evaluation over digest-band-or-better
// opportunities. Prints per-status counts and the failing checks; changes
// nothing (the gate is enforced again at delivery time).
async function main() {
  const logger = createLogger({ app: "gate-run-cli" });
  const args = process.argv.slice(2);
  const oppArg = args.includes("--opportunity") ? args[args.indexOf("--opportunity") + 1] : null;
  const limitArg = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : 50;

  const pool = createPool();
  const db = createDb(pool);
  try {
    let ids: string[];
    if (oppArg) {
      ids = [oppArg];
    } else {
      const res = await db.execute(sql`
        SELECT id FROM opportunities
        WHERE state IN ('priority_review', 'weekly_digest', 'promoted')
        ORDER BY current_score DESC NULLS LAST
        LIMIT ${limitArg}`);
      ids = (res.rows as { id: string }[]).map((r) => r.id);
    }
    const counts: Record<string, number> = {};
    const failedChecks: Record<string, number> = {};
    for (const id of ids) {
      const result = await evaluateGate(db, id);
      if (!result) continue;
      counts[result.status] = (counts[result.status] ?? 0) + 1;
      for (const c of result.checks) {
        if (c.pass === false) failedChecks[c.name] = (failedChecks[c.name] ?? 0) + 1;
      }
      if (oppArg) logger.info({ result }, "gate evaluation");
    }
    logger.info({ evaluated: ids.length, counts, failedChecks }, "gate run finished");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
