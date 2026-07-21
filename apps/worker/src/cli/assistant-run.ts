import "../load-env.js";
import { createDb, createPool } from "@otn/db";
import { createLogger } from "@otn/source-sdk";
import {
  assistantQuery,
  budgetFromEnv,
  getAccountByKey,
  providerFromEnv,
  type ModelProvider,
} from "@otn/intelligence";
import { modelAvailability } from "../env.js";

// pnpm assistant:run --account <key> "<question>"
// A Charlie-style natural-language assistant over ONE account's own
// opportunities. The model only maps the question to a whitelisted, validated
// filter and narrates over rows the deterministic, account-scoped query already
// retrieved — it never authors SQL. Without a model key (or budget) the
// assistant still answers deterministically and records a visible blocked run
// (spec §3): it never fabricates a result.
async function main() {
  const logger = createLogger({ app: "assistant-run-cli" });
  const args = process.argv.slice(2);
  const accountKey = args.includes("--account") ? args[args.indexOf("--account") + 1] : "solis_interiors";
  // Everything not consumed by a flag is the question.
  const question = args
    .filter((a, i) => a !== "--account" && args[i - 1] !== "--account" && !a.startsWith("--"))
    .join(" ")
    .trim();

  if (!accountKey) {
    logger.warn({}, "no --account key provided");
    process.exitCode = 1;
    return;
  }
  if (!question) {
    logger.warn({}, 'no question provided — usage: assistant:run --account <key> "<question>"');
    process.exitCode = 1;
    return;
  }

  const availability = modelAvailability();
  const provider: ModelProvider | null = availability.available ? providerFromEnv() : null;
  const budget = budgetFromEnv();
  if (!provider) logger.warn({ narration: "blocked" }, availability.reason);

  const pool = createPool();
  const db = createDb(pool);
  try {
    const account = await getAccountByKey(db, accountKey);
    if (!account) {
      logger.warn({ accountKey }, "unknown account key");
      process.exitCode = 1;
      return;
    }
    const result = await assistantQuery(db, provider, account.id, question, { budget, logger });
    logger.info(
      { status: result.status, matches: result.opportunityIds.length, filter: result.filter, modelRunId: result.modelRunId },
      "assistant run finished",
    );
    // The answer is the deliverable — print it to stdout for the operator.
    console.log(`\n${result.answer}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
