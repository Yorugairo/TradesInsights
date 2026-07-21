import "../load-env.js";
import { createDb, createPool } from "@otn/db";
import { createLogger } from "@otn/source-sdk";
import {
  budgetFromEnv,
  extractProject,
  listExtractionCandidates,
  providerFromEnv,
  type ModelProvider,
} from "@otn/intelligence";
import { modelAvailability } from "../env.js";

// pnpm extract:run [--project <id>] [--limit N]
// Without ANTHROPIC_API_KEY the pipeline stays in a visible blocked state
// (spec §3): a targeted --project run records a blocked model_runs row;
// a batch run logs the blocked state and exits cleanly.
async function main() {
  const logger = createLogger({ app: "extract-run-cli" });
  const args = process.argv.slice(2);
  const projectArg = args.includes("--project") ? args[args.indexOf("--project") + 1] : null;
  const limitArg = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : 10;

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
    const targets = projectArg ? [projectArg] : await listExtractionCandidates(db, limitArg);
    if (targets.length === 0) {
      logger.info({}, "no extraction candidates — every eligible project already extracted");
      return;
    }
    const counts: Record<string, number> = {};
    for (const projectId of targets) {
      const result = await extractProject(db, provider, projectId, { budget, logger });
      counts[result.status] = (counts[result.status] ?? 0) + 1;
      if (result.status === "blocked" && result.reason?.includes("budget")) break;
    }
    logger.info({ counts, targets: targets.length }, "extraction run finished");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
