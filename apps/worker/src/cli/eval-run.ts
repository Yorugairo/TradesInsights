import "../load-env.js";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, createPool } from "@otn/db";
import { createLogger } from "@otn/source-sdk";
import { getActiveAccounts, latestRules, parseEvalSet, runEval } from "@otn/intelligence";
import type { AccountScoringInput } from "@otn/intelligence";

// pnpm eval:run [--set fixtures/eval/eval-set.v1.jsonl] [--split dev|holdout|all]
// Deterministic replay of the labeled eval set through the CURRENT scoring
// rules. Exits non-zero when a gate fails so it can sit in CI.
async function main() {
  const logger = createLogger({ app: "eval-run-cli" });
  const args = process.argv.slice(2);
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  const setArg = args.includes("--set") ? args[args.indexOf("--set") + 1]! : null;
  const setPath = setArg
    ? isAbsolute(setArg)
      ? setArg
      : join(process.cwd(), setArg)
    : join(repoRoot, "fixtures", "eval", "eval-set.v1.jsonl");
  const split = (args.includes("--split") ? args[args.indexOf("--split") + 1] : "all") as
    | "dev"
    | "holdout"
    | "all";

  const examples = parseEvalSet(readFileSync(setPath, "utf8"));

  const pool = createPool();
  const db = createDb(pool);
  try {
    const accounts = await getActiveAccounts(db);
    const inputs: AccountScoringInput[] = [];
    for (const a of accounts) {
      const rules = await latestRules(db, a.id);
      const weightRows =
        (rules.get("scoring")?.rule["components"] as
          | { component: string; weight: number }[]
          | undefined) ?? [];
      const weights: Record<string, number> = {};
      for (const w of weightRows) weights[w.component] = w.weight;
      inputs.push({ key: a.key, territory: a.territory, weights, delivery: a.delivery });
    }

    const result = runEval(examples, inputs, { split });
    logger.info({ result }, "eval run complete");

    const { gates, overall } = result;
    const pass = gates.priorityPrecisionPass && gates.recallPass;
    logger.info(
      {
        split,
        examples: overall.examples,
        priorityPrecision: overall.priorityPrecision,
        recall: overall.recall,
        hardNegativesInPriority: overall.hardNegativesInPriority,
        positivesMissed: overall.positivesMissed.length,
        gates,
      },
      pass ? "GATES PASS" : "GATES FAIL",
    );
    if (!pass) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
