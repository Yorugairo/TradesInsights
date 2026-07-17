/**
 * Calibration prep (pre-Sunday session) — deterministic sensitivity numbers
 * over stored opportunities/projects. Read-only; prints JSON.
 *
 * Run: cd apps/worker && set -a && . ../../.env && set +a && pnpm exec tsx calibration-sensitivity.mts
 */
import { createPool, createDb } from "@otn/db";
import { sql } from "drizzle-orm";

const pool = createPool();
const db = createDb(pool);

async function accountId(key: string): Promise<string> {
  const r = await db.execute(sql`SELECT id FROM account_profiles WHERE key = ${key}`);
  if (r.rows.length !== 1) throw new Error(`account ${key} not found`);
  return (r.rows[0] as { id: string }).id;
}

const solis = await accountId("solis_interiors");
const atHome = await accountId("lacey_glass_at_home");

// ---- 1. Priority-threshold sensitivity (Solis) --------------------------------
const thresholds = [65, 70, 75, 80, 85, 90, 95];
const thresholdRows: Record<string, number> = {};
for (const t of thresholds) {
  const r = await db.execute(sql`
    SELECT count(*)::int AS n FROM opportunities
    WHERE account_profile_id = ${solis} AND current_score >= ${t}
      AND state != 'archive'`);
  thresholdRows[String(t)] = (r.rows[0] as { n: number }).n;
}

// Score distribution by decile band for context.
const dist = await db.execute(sql`
  SELECT width_bucket(current_score, 0, 100, 10) AS bucket, count(*)::int AS n
  FROM opportunities
  WHERE account_profile_id = ${solis} AND current_score IS NOT NULL AND state != 'archive'
  GROUP BY 1 ORDER BY 1`);

// ---- 2. Easy-win sensitivity grid (Solis) -------------------------------------
// Mirrors packages/delivery/src/digest.ts isEasyWin() exactly, in SQL.
const HOME = { lon: -122.823, lat: 47.046 }; // provisional home point (Lacey)

async function easyWinCount(opts: {
  radiusKm: number | null;
  maxAgeDays: number;
  minVal: number | null;
  maxVal: number | null;
}): Promise<number> {
  const distCond =
    opts.radiusKm === null
      ? sql`true`
      : sql`p.geometry IS NOT NULL AND ST_DistanceSphere(ST_Centroid(p.geometry),
          ST_SetSRID(ST_MakePoint(${HOME.lon}, ${HOME.lat}), 4326)) <= ${opts.radiusKm * 1000}`;
  const minCond =
    opts.minVal === null ? sql`true` : sql`rec.max_valuation IS NOT NULL AND rec.max_valuation >= ${opts.minVal}`;
  const maxCond =
    opts.maxVal === null ? sql`true` : sql`(rec.max_valuation IS NULL OR rec.max_valuation <= ${opts.maxVal})`;
  const r = await db.execute(sql`
    SELECT count(*)::int AS n
    FROM opportunities o JOIN projects p ON p.id = o.project_id
    LEFT JOIN LATERAL (
      SELECT max((sr.normalized_json->>'valuationUsd')::numeric)::float AS max_valuation
      FROM record_resolutions rr JOIN source_records sr ON sr.id = rr.source_record_id
      WHERE rr.project_id = p.id AND rr.status = 'active'
    ) rec ON true
    WHERE o.account_profile_id = ${solis}
      AND o.state IN ('priority_review', 'weekly_digest', 'promoted')
      AND p.current_stage IN ('permit_issued', 'approved')
      AND o.last_material_change_at IS NOT NULL
      AND o.last_material_change_at > now() - make_interval(days => ${opts.maxAgeDays})
      AND EXISTS (SELECT 1 FROM project_roles pr WHERE pr.project_id = p.id
        AND pr.role IN ('applicant', 'owner', 'primary_contractor', 'contractor'))
      AND ${minCond} AND ${maxCond} AND ${distCond}`);
  return (r.rows[0] as { n: number }).n;
}

const radiusAgeGrid: Record<string, number> = {};
for (const radiusKm of [40, 60, 80]) {
  for (const maxAgeDays of [30, 60, 90]) {
    radiusAgeGrid[`r${radiusKm}km_a${maxAgeDays}d`] = await easyWinCount({
      radiusKm, maxAgeDays, minVal: 50_000, maxVal: 2_000_000,
    });
  }
}
const valuationBands: Record<string, number> = {};
for (const [label, minVal, maxVal] of [
  ["25k-2M", 25_000, 2_000_000],
  ["50k-2M", 50_000, 2_000_000],
  ["100k-2M", 100_000, 2_000_000],
  ["50k-5M", 50_000, 5_000_000],
  ["no_band", null, null],
] as const) {
  valuationBands[label] = await easyWinCount({ radiusKm: 60, maxAgeDays: 60, minVal, maxVal });
}

// ---- 3. Solis priority mix by county / stage ----------------------------------
const solisByCounty = await db.execute(sql`
  SELECT p.county, count(*)::int AS n
  FROM opportunities o JOIN projects p ON p.id = o.project_id
  WHERE o.account_profile_id = ${solis} AND o.current_score >= 80 AND o.state != 'archive'
  GROUP BY 1 ORDER BY 2 DESC`);
const solisByStage = await db.execute(sql`
  SELECT p.current_stage, count(*)::int AS n
  FROM opportunities o JOIN projects p ON p.id = o.project_id
  WHERE o.account_profile_id = ${solis} AND o.current_score >= 80 AND o.state != 'archive'
  GROUP BY 1 ORDER BY 2 DESC`);

// ---- 4. At Home Pierce/Tacoma volume decision numbers -------------------------
const atHomeByCounty = await db.execute(sql`
  SELECT p.county, p.permitting_jurisdiction, count(*)::int AS n
  FROM opportunities o JOIN projects p ON p.id = o.project_id
  WHERE o.account_profile_id = ${atHome} AND o.current_score >= 80 AND o.state != 'archive'
  GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 12`);
const atHomeTotals = await db.execute(sql`
  SELECT count(*) FILTER (WHERE current_score >= 80)::int AS priority,
         count(*) FILTER (WHERE current_score >= 65 AND current_score < 80)::int AS digest,
         count(*)::int AS total
  FROM opportunities WHERE account_profile_id = ${atHome} AND state != 'archive'`);

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  solis: {
    thresholds: thresholdRows,
    scoreDeciles: dist.rows,
    easyWin: { radiusAgeGrid, valuationBands, fixedFor: "band 50k-2M (grid) / r60km a60d (bands)" },
    priorityByCounty: solisByCounty.rows,
    priorityByStage: solisByStage.rows,
  },
  atHome: { totals: atHomeTotals.rows[0], priorityByCountyJurisdiction: atHomeByCounty.rows },
}, null, 2));

await pool.end();
