import "../load-env.js";
import { sql } from "drizzle-orm";
import { createDb, createPool } from "@otn/db";
import { createLogger } from "@otn/source-sdk";
import { laplaceAcceptRate, MIN_QUEUE_TRUST } from "@otn/resolution";

// pnpm match:audit
// 4B.5 — per-rule matching telemetry for the §12.3 calibration session.
// Read-only: for every observation rule this prints queued/pending/accepted/
// rejected/auto-accepted counts, the HUMAN-reviewed Laplace accept rate (the
// exact value the next generation pass uses as its ruleHistory component),
// the trust distribution, and how many queued rows sit in the near-floor band
// [MIN_QUEUE_TRUST, MIN_QUEUE_TRUST + 0.1) — the population a floor change
// would move. Nothing is decided or tuned here; humans do that with evidence.
async function main() {
  const logger = createLogger({ app: "match-audit-cli" });
  const pool = createPool();
  const db = createDb(pool);
  try {
    const res = await db.execute(sql`
      SELECT rule_key,
        count(*)::int AS queued,
        count(*) FILTER (WHERE status = 'pending')::int AS pending,
        count(*) FILTER (WHERE status = 'accepted')::int AS accepted,
        count(*) FILTER (WHERE status = 'rejected')::int AS rejected,
        count(*) FILTER (WHERE decided_by = 'auto:rule-history')::int AS auto_accepted,
        count(*) FILTER (WHERE decided_at IS NOT NULL AND decided_by NOT LIKE 'auto:%')::int AS human_decisions,
        count(*) FILTER (WHERE status = 'accepted' AND decided_at IS NOT NULL AND decided_by NOT LIKE 'auto:%')::int AS human_accepts,
        round(min(trust_score)::numeric, 3) AS trust_min,
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY trust_score))::numeric, 3) AS trust_median,
        round(max(trust_score)::numeric, 3) AS trust_max,
        count(*) FILTER (WHERE trust_score >= ${MIN_QUEUE_TRUST}
                           AND trust_score < ${MIN_QUEUE_TRUST + 0.1})::int AS near_floor
      FROM registry_observations
      GROUP BY rule_key
      ORDER BY rule_key`);
    for (const r of res.rows as Record<string, unknown>[]) {
      logger.info(
        {
          rule: r["rule_key"],
          queued: Number(r["queued"]),
          pending: Number(r["pending"]),
          accepted: Number(r["accepted"]),
          rejected: Number(r["rejected"]),
          autoAccepted: Number(r["auto_accepted"]),
          humanAcceptRateLaplace: Number(
            laplaceAcceptRate(Number(r["human_accepts"]), Number(r["human_decisions"])).toFixed(3),
          ),
          trust: { min: Number(r["trust_min"]), median: Number(r["trust_median"]), max: Number(r["trust_max"]) },
          nearFloor: Number(r["near_floor"]),
        },
        "match rule audit",
      );
    }
    if (res.rows.length === 0) logger.info({}, "no observations recorded yet");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
