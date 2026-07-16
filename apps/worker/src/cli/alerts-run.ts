import "../load-env.js";
import { createDb, createPool } from "@otn/db";
import { createLogger } from "@otn/source-sdk";
import { runAlerts } from "@otn/delivery";
import { loadSourcesConfig } from "@otn/config";

// pnpm alerts:run [--send]
// Evaluates spend/health/stale/delivery conditions, persists idempotent
// alert rows (rerunning never duplicates), and optionally emails new ones.
async function main() {
  const logger = createLogger({ app: "alerts-run-cli" });
  const send = process.argv.includes("--send");
  const monthlyBudgetUsd = process.env.LLM_MONTHLY_BUDGET_USD
    ? Number(process.env.LLM_MONTHLY_BUDGET_USD)
    : null;

  // D4 — build the substitute-coverage map from config so a red substitute
  // source escalates for its now-uncovered dependents.
  const substitutes: Record<string, string[]> = {};
  for (const s of loadSourcesConfig().sources) {
    if (s.mitigates.length > 0) substitutes[s.key] = s.mitigates;
  }

  const pool = createPool();
  const db = createDb(pool);
  try {
    const summary = await runAlerts(db, { monthlyBudgetUsd, send, substitutes });
    logger.info(
      {
        evaluated: summary.evaluated,
        fired: summary.fired.map((f) => `${f.severity}:${f.alertType}:${f.subjectKey}`),
        deduped: summary.deduped,
        emailed: summary.emailed,
      },
      summary.fired.length > 0 ? "alerts fired" : "no new alerts",
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
