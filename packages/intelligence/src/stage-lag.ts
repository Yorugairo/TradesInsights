import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";

/**
 * P3.1 — stage-lag statistics: "permits like this typically issue in ~N
 * weeks", computed from OUR OWN stored history. Samples are records that
 * state BOTH applicationDate and issueDate on the same row (never inferred
 * across records). Recomputed nightly (DELETE+INSERT — a pure function of
 * stored records); surfaced only when n ≥ MIN_SAMPLES and always labeled an
 * inference from historical lags, never a promise.
 */

export const STAGE_LAG_MIN_SAMPLES = 20;

/** Coarse deterministic permit classes (regex buckets over stated types). */
export function permitClassOf(applicationType: string | null, permitType: string | null): string {
  const t = `${applicationType ?? ""} ${permitType ?? ""}`.toLowerCase();
  if (/land use|land div|pre-application|sepa|shoreline|plat|zoning|variance/.test(t)) return "land_use";
  if (/commercial/.test(t)) return "commercial";
  if (/residential|single family|dwelling|town ?ho/.test(t)) return "residential";
  if (/mechanical|plumbing|electrical|sewer|water|hvac|utility/.test(t)) return "trade";
  return "other";
}

export interface StageLagSummary {
  groups: number;
  samples: number;
}

export async function computeStageLagStats(
  db: Db,
  opts: { logger?: { info(o: unknown, m?: string): void } } = {},
): Promise<StageLagSummary> {
  const res = await db.execute(sql`
    WITH samples AS (
      SELECT p.county,
        CASE
          WHEN lower(concat_ws(' ', sr.normalized_json->>'applicationType', sr.normalized_json->>'permitType'))
            ~ 'land use|land div|pre-application|sepa|shoreline|plat|zoning|variance' THEN 'land_use'
          WHEN lower(concat_ws(' ', sr.normalized_json->>'applicationType', sr.normalized_json->>'permitType'))
            ~ 'commercial' THEN 'commercial'
          WHEN lower(concat_ws(' ', sr.normalized_json->>'applicationType', sr.normalized_json->>'permitType'))
            ~ 'residential|single family|dwelling|town ?ho' THEN 'residential'
          WHEN lower(concat_ws(' ', sr.normalized_json->>'applicationType', sr.normalized_json->>'permitType'))
            ~ 'mechanical|plumbing|electrical|sewer|water|hvac|utility' THEN 'trade'
          ELSE 'other'
        END AS permit_class,
        ((sr.normalized_json->>'issueDate')::date - (sr.normalized_json->>'applicationDate')::date) AS lag_days
      FROM source_records sr
      JOIN sources s ON s.id = sr.source_id
      JOIN record_resolutions rr ON rr.source_record_id = sr.id AND rr.status = 'active'
      JOIN projects p ON p.id = rr.project_id
      WHERE s.priority != 'test'
        AND sr.normalized_json->>'applicationDate' ~ '^\\d{4}-\\d{2}-\\d{2}'
        AND sr.normalized_json->>'issueDate' ~ '^\\d{4}-\\d{2}-\\d{2}'
    ),
    stats AS (
      SELECT county, permit_class, count(*) AS n,
        percentile_cont(0.25) WITHIN GROUP (ORDER BY lag_days) AS p25,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY lag_days) AS median,
        percentile_cont(0.75) WITHIN GROUP (ORDER BY lag_days) AS p75
      FROM samples
      WHERE lag_days >= 0 AND lag_days <= 1095 -- guard: stated-date errors
      GROUP BY county, permit_class
    )
    SELECT county, permit_class, n, p25, median, p75 FROM stats`);

  await db.execute(sql`DELETE FROM stage_lag_stats`);
  let samples = 0;
  for (const r of res.rows as Record<string, unknown>[]) {
    samples += Number(r["n"]);
    await db.execute(sql`
      INSERT INTO stage_lag_stats
        (county, permit_class, from_stage, to_stage, n, p25_days, median_days, p75_days)
      VALUES (${r["county"]}, ${r["permit_class"]}, 'permit_applied', 'permit_issued',
        ${Number(r["n"])}, ${Number(r["p25"])}, ${Number(r["median"])}, ${Number(r["p75"])})`);
  }
  const summary = { groups: res.rows.length, samples };
  opts.logger?.info(summary, "stage-lag stats recomputed");
  return summary;
}

export interface StageLagEstimate {
  medianDays: number;
  p25Days: number;
  p75Days: number;
  n: number;
}

/** Estimate for one county/class; null below the sample floor (never guessed). */
export async function stageLagEstimate(
  db: Db,
  county: string,
  permitClass: string,
): Promise<StageLagEstimate | null> {
  const res = await db.execute(sql`
    SELECT n, p25_days, median_days, p75_days FROM stage_lag_stats
    WHERE county = ${county} AND permit_class = ${permitClass}
      AND from_stage = 'permit_applied' AND to_stage = 'permit_issued'`);
  const r = res.rows[0] as
    | { n: number; p25_days: number; median_days: number; p75_days: number }
    | undefined;
  if (!r || Number(r.n) < STAGE_LAG_MIN_SAMPLES) return null;
  return {
    medianDays: Number(r.median_days),
    p25Days: Number(r.p25_days),
    p75Days: Number(r.p75_days),
    n: Number(r.n),
  };
}
