import "../load-env.js";
import { createDb, createPool } from "@otn/db";
import { createLogger } from "@otn/source-sdk";
import {
  budgetFromEnv,
  generateBrief,
  listBriefCandidates,
  providerFromEnv,
  type ModelProvider,
} from "@otn/intelligence";
import { modelAvailability } from "../env.js";

// pnpm brief:run [--opportunity <id>] [--limit N]
// Generates the verified decision brief (model prose over the deterministic
// memo) for the highest-scoring opportunities that lack one. Without a model
// key the job stays in a visible blocked state (spec §3): a targeted
// --opportunity run records a blocked brief_draft row; a batch run logs and
// exits cleanly. A draft that violates the brief contract is rejected and never
// surfaced — the UI falls back to the deterministic memo.
async function main() {
  const logger = createLogger({ app: "brief-run-cli" });
  const args = process.argv.slice(2);
  const oppArg = args.includes("--opportunity") ? args[args.indexOf("--opportunity") + 1] : null;
  const limitArg = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : 5;

  const availability = modelAvailability();
  const provider: ModelProvider | null = availability.available ? providerFromEnv() : null;
  const budget = budgetFromEnv();

  const pool = createPool();
  const db = createDb(pool);
  try {
    if (!provider && !oppArg) {
      logger.warn({ modelJobs: "blocked" }, availability.reason);
      return;
    }
    const targets = oppArg ? [oppArg] : await listBriefCandidates(db, limitArg);
    if (targets.length === 0) {
      logger.info({}, "no brief candidates — every eligible opportunity already has a brief");
      return;
    }
    const counts: Record<string, number> = {};
    for (const opportunityId of targets) {
      const result = await generateBrief(db, provider, opportunityId, { budget, logger });
      counts[result.status] = (counts[result.status] ?? 0) + 1;
      if (result.status === "blocked" && result.reason?.includes("budget")) break;
    }
    logger.info({ counts, targets: targets.length }, "brief run finished");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
