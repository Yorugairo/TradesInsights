import "../load-env.js";
import { sql } from "drizzle-orm";
import { createDb, createPool, type Db } from "@otn/db";
import { createLogger } from "@otn/source-sdk";
import {
  budgetFromEnv,
  providerFromEnv,
  verifyProject,
  type ModelProvider,
} from "@otn/intelligence";
import { modelAvailability } from "../env.js";

// pnpm verify:run [--project <id>] [--limit N]
// Independent verification (spec §15) of projects whose latest extraction
// succeeded but which have no succeeded verification yet. Key-gated exactly
// like extract:run: blocked is a visible state, not a crash.
async function candidates(db: Db, limit: number): Promise<string[]> {
  const res = await db.execute(sql`
    SELECT DISTINCT mr.project_id
    FROM model_runs mr
    WHERE mr.job_type = 'extraction' AND mr.status = 'succeeded'
      AND NOT EXISTS (
        SELECT 1 FROM model_runs v
        WHERE v.project_id = mr.project_id
          AND v.job_type = 'verification' AND v.status = 'succeeded'
          AND v.created_at > mr.created_at)
    LIMIT ${limit}`);
  return (res.rows as { project_id: string }[]).map((r) => r.project_id);
}

async function main() {
  const logger = createLogger({ app: "verify-run-cli" });
  const args = process.argv.slice(2);
  const projectArg = args.includes("--project") ? args[args.indexOf("--project") + 1] : null;
  const limitArg = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : 5;

  const availability = modelAvailability();
  const provider: ModelProvider | null = availability.available ? providerFromEnv() : null;
  const budget = budgetFromEnv();

  const pool = createPool();
  const db = createDb(pool);
  try {
    if (!provider && !projectArg) {
      logger.warn({ modelJobs: "blocked" }, availability.reason);
      return;
    }
    const targets = projectArg ? [projectArg] : await candidates(db, limitArg);
    if (targets.length === 0) {
      logger.info({}, "no verification candidates — every extraction already verified");
      return;
    }
    const counts: Record<string, number> = {};
    for (const projectId of targets) {
      const result = await verifyProject(db, provider, projectId, { budget, logger });
      counts[result.status] = (counts[result.status] ?? 0) + 1;
      if (result.status === "blocked" && result.reason?.includes("budget")) break;
    }
    logger.info({ counts, targets: targets.length }, "verification run finished");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
