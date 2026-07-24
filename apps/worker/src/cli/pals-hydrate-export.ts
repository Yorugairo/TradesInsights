import "../load-env.js";
import { writeFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { createDb, createPool } from "@otn/db";
import { createLogger } from "@otn/source-sdk";

// pnpm pals:hydrate:export [--out=pals-hydrate-seed.json] [--limit=250] [--all]
//
// Phase A0 (queue-cockpit plan, owner-approved scale 2026-07-24): emit the
// permit ids the PALS capture script should hydrate. Pierce's open-data layer
// (`pierce_permits_arcgis`) publishes NO contacts and NO contractor licence —
// but its external_id IS the PALS applPermitId, and PALS' own permit-header
// endpoint returns `contrLicNum`, the authoritative contractor licence. A
// licence is a STRONG key: identifiers.ts stamps organizations
// .contractor_registration (NULL-only) and linkRegistry binds
// `contractor_number_exact` deterministically — no review row, no new rule.
//
// Selection: every Pierce ArcGIS record not already enriched (no
// pierce_pals_contractor record with the same external_id), most recent first
// (recent permits are the actionable ones). `--limit` caps the BATCH; the
// summary always reports the FULL remaining pool and its permit-type mix so
// each batch doubles as the A0 yield measurement.
//
// Lookup-class hard rule (spec §5): this list only ever contains permits we
// already hold — the capture script must never crawl or discover on its own.
async function main() {
  const logger = createLogger({ app: "pals-hydrate-export" });
  const args = process.argv.slice(2);
  const outArg = args.find((a) => a.startsWith("--out="));
  const limitArg = args.find((a) => a.startsWith("--limit="));
  const out = outArg ? outArg.slice("--out=".length) : "pals-hydrate-seed.json";
  const all = args.includes("--all");
  const limit = all ? null : Math.max(1, Number(limitArg?.slice("--limit=".length) ?? 250));

  const pool = createPool();
  const db = createDb(pool);
  try {
    // One scan, two outputs: the ordered id list and the full-pool type mix.
    const res = await db.execute(sql`
      SELECT sr.external_id,
             coalesce(sr.normalized_json->>'permitType', 'unknown') AS permit_type,
             coalesce(sr.normalized_json->>'issueDate', sr.normalized_json->>'applicationDate') AS d
      FROM source_records sr
      JOIN sources s ON s.id = sr.source_id
      WHERE s.key = 'pierce_permits_arcgis'
        AND sr.external_id ~ '^[0-9]+$'
        AND NOT EXISTS (
          SELECT 1 FROM source_records e
          JOIN sources es ON es.id = e.source_id
          WHERE es.key = 'pierce_pals_contractor' AND e.external_id = sr.external_id)
      ORDER BY d DESC NULLS LAST, sr.external_id DESC`);
    const rows = res.rows as { external_id: string; permit_type: string; d: string | null }[];

    const byPermitType: Record<string, number> = {};
    for (const r of rows) byPermitType[r.permit_type] = (byPermitType[r.permit_type] ?? 0) + 1;
    const batch = limit === null ? rows : rows.slice(0, limit);

    const payload = {
      generatedAt: new Date().toISOString(),
      source: "pierce_permits_arcgis",
      remainingPool: rows.length,
      batchSize: batch.length,
      byPermitType,
      // Numbers, not strings: the capture script and the adapter both treat
      // applPermitId as an integer id.
      permitIds: batch.map((r) => Number(r.external_id)),
    };
    await writeFile(out, JSON.stringify(payload, null, 2));
    logger.info(
      { out, remainingPool: rows.length, batchSize: batch.length },
      "PALS hydrate seed written — feed it to scripts/pals-header-capture.mjs",
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
