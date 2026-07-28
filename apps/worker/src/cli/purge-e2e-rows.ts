import "../load-env.js";
import { createDb, createPool } from "@otn/db";
import { sql } from "drizzle-orm";

/**
 * pnpm purge:e2e-rows [--apply]
 *
 * Removes rows the E2E SUITE WROTE INTO PRODUCTION.
 *
 * `apps/web/e2e/app.spec.ts` runs against the hosted database and POSTs real
 * records that it never cleans up:
 *
 *   :219  POST /api/app/outcomes      → opportunity_outcomes  (never deleted)
 *   :225  POST /api/admin/corrections → claim_corrections     (immutable by design)
 *   :86   POST …/feedback             → feedback              (3 per run)
 *
 * Measured 2026-07-27: 30 of 30 `claim_corrections` and 30 of 30
 * `opportunity_outcomes` rows were e2e output — 100% of both tables. Those
 * tables are read by `delivery/src/roi.ts` (the customer's ROI scorecard),
 * `delivery/src/pipeline.ts` (the "Won" figure on /app/pipeline) and
 * `intelligence/src/trust.ts`.
 *
 * DRY RUN BY DEFAULT. Deleting production rows on import is how a cleanup
 * becomes an incident, so nothing is removed without `--apply`.
 *
 * WHY THIS PRINTS EVERY ROW RATHER THAN JUST DELETING. `opportunity_outcomes`
 * has NO `reason` column, and `created_by` is stamped from the session
 * (`solis_interiors`), not from the test — so a genuine customer win is
 * indistinguishable from the e2e row by any single field. What identifies the
 * e2e row is that it is BARE: `won`, not influenced, and carrying no pursuit,
 * no attributable value, no reason code and no notes. A real recorded win
 * almost certainly has at least one of those, because those are the reason
 * anyone records it. "Almost certainly" is not good enough to delete on, so
 * this prints the candidates and waits for a human.
 */

const APPLY = process.argv.includes("--apply");

/** The bare shape the e2e outcome POST produces — see app.spec.ts:219. */
const E2E_OUTCOME_PREDICATE = sql`
  outcome_type = 'won'
  AND influenced_by_otn = false
  AND pursuit_id IS NULL
  AND attributable_value IS NULL
  AND reason_code IS NULL
  AND notes IS NULL`;

async function main(): Promise<void> {
  const pool = createPool();
  const db = createDb(pool);

  const banner = APPLY ? "APPLY — rows WILL be deleted" : "DRY RUN — nothing will be deleted";
  console.log(`\n=== purge-e2e-rows (${banner}) ===\n`);

  // ── 1. claim_corrections ───────────────────────────────────────────────────
  // The only table with an unambiguous marker: the test passes reason:"e2e".
  const corr = await db.execute(sql`
    SELECT count(*) FILTER (WHERE reason = 'e2e')::int AS e2e,
           count(*)::int AS total
    FROM claim_corrections`);
  const c = corr.rows[0] as { e2e: number; total: number };
  console.log(`claim_corrections      ${c.e2e} of ${c.total} rows carry reason='e2e'`);
  if (c.e2e > 0 && c.e2e === c.total) {
    console.log("                       (every row in the table is test output)");
  }

  // ── 2. opportunity_outcomes ────────────────────────────────────────────────
  // No marker. Profile the whole table so the shape of the ambiguity is visible
  // rather than asserted.
  const outcomeProfile = await db.execute(sql`
    SELECT outcome_type, influenced_by_otn,
           (pursuit_id IS NULL) AS no_pursuit,
           (attributable_value IS NULL) AS no_value,
           (notes IS NULL AND reason_code IS NULL) AS no_prose,
           count(*)::int AS n,
           min(created_at)::date AS first_seen,
           max(created_at)::date AS last_seen,
           count(DISTINCT opportunity_id)::int AS distinct_opps
    FROM opportunity_outcomes
    GROUP BY 1, 2, 3, 4, 5
    ORDER BY n DESC`);
  console.log(`\nopportunity_outcomes   distinct shapes:`);
  for (const r of outcomeProfile.rows as Record<string, unknown>[]) {
    const bare = r["no_pursuit"] && r["no_value"] && r["no_prose"];
    console.log(
      `  ${String(r["n"]).padStart(4)}  ${r["outcome_type"]}` +
        `  influenced=${r["influenced_by_otn"]}` +
        `  bare=${bare ? "YES (e2e shape)" : "no  (has detail — KEEP)"}` +
        `  opps=${r["distinct_opps"]}  ${r["first_seen"]}..${r["last_seen"]}`,
    );
  }

  const outcomeCandidates = await db.execute(sql`
    SELECT id, opportunity_id, created_by, created_at
    FROM opportunity_outcomes
    WHERE ${E2E_OUTCOME_PREDICATE}
    ORDER BY created_at`);
  console.log(`\n  ${outcomeCandidates.rows.length} candidate row(s) match the bare e2e shape:`);
  for (const r of outcomeCandidates.rows as Record<string, unknown>[]) {
    console.log(`    ${r["id"]}  opp=${r["opportunity_id"]}  by=${r["created_by"]}  ${r["created_at"]}`);
  }

  // ── 3. feedback ────────────────────────────────────────────────────────────
  // The e2e feedback POSTs carry no distinguishing field at all, and real
  // account feedback is the training signal for scoring calibration. Reported,
  // never deleted — a wrong delete here silently degrades the scorer.
  const fb = await db.execute(sql`SELECT count(*)::int AS n FROM feedback`);
  console.log(
    `\nfeedback               ${(fb.rows[0] as { n: number }).n} rows total` +
      ` — NOT purged (no marker, and real feedback trains the scorer)`,
  );

  if (!APPLY) {
    console.log(
      [
        "",
        "Nothing was deleted.",
        "",
        "Review the candidate rows above. When they are confirmed as test output,",
        "re-run with --apply. `claim_corrections` is documented as immutable, so",
        "deleting from it needs an explicit owner decision even though every row",
        "here is synthetic.",
        "",
      ].join("\n"),
    );
    await pool.end();
    return;
  }

  const delCorr = await db.execute(sql`DELETE FROM claim_corrections WHERE reason = 'e2e'`);
  const delOut = await db.execute(sql`
    DELETE FROM opportunity_outcomes WHERE ${E2E_OUTCOME_PREDICATE}`);
  console.log(
    `\nDeleted: claim_corrections ${delCorr.rowCount ?? 0}, ` +
      `opportunity_outcomes ${delOut.rowCount ?? 0}.\n`,
  );

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
