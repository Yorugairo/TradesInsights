#!/usr/bin/env node
/**
 * WS-2 Task 6 — local → hosted data-migration parity verifier.
 * Read-only on BOTH databases. Run AFTER the pg_dump/psql restore:
 *
 *   SOURCE_DATABASE_URL=postgres://otn:otn@localhost:5433/otn?options=... \
 *   TARGET_DATABASE_URL=<hosted session-pooler URL with the same search_path options> \
 *   node scripts/verify-migration-parity.mjs
 *
 * Checks, per table in the SOURCE `insights` schema (census self-derives, so a
 * later migration that adds a table is covered automatically):
 *   1. row counts equal
 *   2. spot checksums equal on the four highest-stakes tables
 *      (opportunities, model_runs, source_records, raw_artifacts):
 *      md5 over the ordered set of primary keys + a content column.
 * Exit 0 = parity; exit 1 = any mismatch (printed).
 */

import process from "node:process";
import pg from "pg";

const SPOT_CHECKSUMS = {
  opportunities: "md5(string_agg(id::text || ':' || coalesce(current_score::text,'') || ':' || state, ',' ORDER BY id))",
  model_runs: "md5(string_agg(id::text || ':' || coalesce(job_type,''), ',' ORDER BY id))",
  source_records: "md5(string_agg(id::text || ':' || coalesce(normalized_fingerprint,''), ',' ORDER BY id))",
  raw_artifacts: "md5(string_agg(id::text || ':' || sha256, ',' ORDER BY id))",
};

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`ERROR: ${name} is not set`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const source = new pg.Pool({ connectionString: requireEnv("SOURCE_DATABASE_URL"), max: 2 });
  const target = new pg.Pool({ connectionString: requireEnv("TARGET_DATABASE_URL"), max: 2 });
  let failures = 0;

  try {
    const tablesRes = await source.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'insights' AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
    );
    const tables = tablesRes.rows.map((r) => r.table_name);
    console.log(`Comparing ${tables.length} insights tables (source census)…`);

    for (const table of tables) {
      const [src, dst] = await Promise.all([
        source.query(`SELECT count(*)::bigint AS n FROM insights."${table}"`),
        target.query(`SELECT count(*)::bigint AS n FROM insights."${table}"`),
      ]);
      const a = src.rows[0].n;
      const b = dst.rows[0].n;
      const ok = a === b;
      if (!ok) failures++;
      console.log(`${ok ? "  ok " : "MISMATCH"} ${table.padEnd(36)} local=${a} hosted=${b}`);
    }

    for (const [table, expr] of Object.entries(SPOT_CHECKSUMS)) {
      if (!tables.includes(table)) continue;
      const sql = `SELECT ${expr} AS sum FROM insights."${table}"`;
      const [src, dst] = await Promise.all([source.query(sql), target.query(sql)]);
      const a = src.rows[0].sum;
      const b = dst.rows[0].sum;
      const ok = a === b;
      if (!ok) failures++;
      console.log(`${ok ? "  ok " : "MISMATCH"} checksum:${table.padEnd(27)} ${ok ? a ?? "(empty)" : `local=${a} hosted=${b}`}`);
    }
  } finally {
    await source.end();
    await target.end();
  }

  if (failures > 0) {
    console.error(`\nPARITY FAILED: ${failures} mismatch(es). Do NOT cut over.`);
    process.exit(1);
  }
  console.log("\nPARITY OK — every table count and spot checksum matches.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
