import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";

/**
 * Flywheel Phase 1 — corroboration derivation. Computes, per project, a
 * cross-reference summary over data the resolver already stores:
 *
 *  - `sourceCount`  — distinct PUBLIC source keys among the project's ACTIVE
 *    record resolutions. Two independent publishers describing the same project
 *    is categorically stronger evidence than one; the digest/cockpit DISCLOSE
 *    this ("seen independently in N sources") and scoring emits only the
 *    score-neutral `corroborated_multi_source` signal (§12.3 stays frozen).
 *  - `stageDepth`   — distinct resulting lifecycle stages among CONFIRMED
 *    project events. A coherent multi-stage chain (NOA → applied → issued)
 *    marks a project that is actually progressing.
 *  - `contradictions` — same numeric fact stated MATERIALLY differently by
 *    sibling records (max > min × 1.25, so revised-valuation noise does not
 *    flag). Both values are kept with their record ids — NO winner is ever
 *    picked (no-fabrication rule); the digest routes these to the review queue.
 *
 * Full re-derive each run (reset then set), so deactivated resolutions never
 * leave stale summaries. Projects with no active public resolutions keep
 * corroboration = NULL — unknown, never a fabricated zero.
 */

/** Numeric normalized_json fields checked for material same-fact conflicts. */
const CONTRADICTION_FIELDS = ["valuationUsd", "units", "squareFeet", "lots"] as const;

/** Material-difference guard: values must differ by more than this ratio. */
const CONTRADICTION_RATIO = 1.25;

export interface CorroborationSummary {
  /** Projects whose corroboration summary was (re)written this run. */
  projectsDerived: number;
  /** Of those, projects corroborated by ≥2 distinct public sources. */
  multiSource: number;
  /** Of those, projects carrying at least one material contradiction. */
  withContradictions: number;
}

export interface CorroborationOptions {
  logger?: { info(o: unknown, m?: string): void };
}

export async function deriveCorroboration(
  db: Db,
  opts: CorroborationOptions = {},
): Promise<CorroborationSummary> {
  // Reset first: a project that lost its last active public resolution since
  // the previous run must fall back to NULL (unknown), not keep a stale count.
  await db.execute(sql`UPDATE projects SET corroboration = NULL WHERE corroboration IS NOT NULL`);

  const fieldRows = sql.join(
    CONTRADICTION_FIELDS.map((f) => sql`(${f}, (sr.normalized_json ->> ${f})::numeric)`),
    sql`, `,
  );

  await db.execute(sql`
    WITH src AS (
      -- Distinct PUBLIC publishers per project (active resolutions only).
      SELECT rr.project_id, count(DISTINCT s.key) AS source_count
      FROM record_resolutions rr
      JOIN source_records sr ON sr.id = rr.source_record_id
      JOIN sources s ON s.id = sr.source_id AND s.account_profile_id IS NULL
      WHERE rr.status = 'active'
      GROUP BY rr.project_id
    ),
    stages AS (
      SELECT pe.project_id, count(DISTINCT pe.resulting_stage) AS stage_depth
      FROM project_events pe
      WHERE pe.confirmed = true AND pe.resulting_stage IS NOT NULL
      GROUP BY pe.project_id
    ),
    conflicts AS (
      SELECT c.project_id,
             jsonb_agg(jsonb_build_object(
               'field', c.field, 'values', c.vals, 'recordIds', c.rids)) AS contradictions
      FROM (
        SELECT rr.project_id, fld.field,
               jsonb_agg(DISTINCT fld.num)        AS vals,
               jsonb_agg(DISTINCT sr.id::text)    AS rids
        FROM record_resolutions rr
        JOIN source_records sr ON sr.id = rr.source_record_id
        JOIN sources s ON s.id = sr.source_id AND s.account_profile_id IS NULL
        CROSS JOIN LATERAL (VALUES ${fieldRows}) AS fld(field, num)
        WHERE rr.status = 'active' AND fld.num IS NOT NULL
        GROUP BY rr.project_id, fld.field
        -- Material difference only: distinct values AND max > min × ratio
        -- (min = 0 always flags — a stated zero vs a stated value IS material).
        HAVING count(DISTINCT fld.num) > 1
           AND max(fld.num) > min(fld.num) * ${CONTRADICTION_RATIO}
      ) c
      GROUP BY c.project_id
    )
    UPDATE projects p
    SET corroboration = jsonb_build_object(
      'sourceCount', src.source_count,
      'stageDepth', COALESCE(st.stage_depth, 0),
      'contradictions', COALESCE(cf.contradictions, '[]'::jsonb),
      'derivedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
    FROM src
    LEFT JOIN stages st ON st.project_id = src.project_id
    LEFT JOIN conflicts cf ON cf.project_id = src.project_id
    WHERE p.id = src.project_id`);

  const res = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE corroboration IS NOT NULL)                                        AS derived,
      count(*) FILTER (WHERE (corroboration ->> 'sourceCount')::int >= 2)                      AS multi,
      count(*) FILTER (WHERE jsonb_array_length(corroboration -> 'contradictions') > 0)        AS conflicted
    FROM projects`);
  const row = res.rows[0] as Record<string, unknown>;
  const summary: CorroborationSummary = {
    projectsDerived: Number(row["derived"] ?? 0),
    multiSource: Number(row["multi"] ?? 0),
    withContradictions: Number(row["conflicted"] ?? 0),
  };
  opts.logger?.info(summary, "corroboration derived");
  return summary;
}
