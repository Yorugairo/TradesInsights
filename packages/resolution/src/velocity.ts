import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";

/**
 * M2.6 — permit-cluster velocity (spec §10/§21): a subdivision-scale permit
 * cluster is ONE opportunity plus a velocity signal, never N leads. For each
 * development, permit events across member projects inside the trailing
 * window emit a single `cluster_velocity` event on the development's anchor
 * project (the phase parent when set, else the earliest member).
 *
 * The event's sourceRecordId is the most recent permit record in the window
 * (the schema requires record provenance, and that permit is the observation
 * that tipped the signal). The event marks THAT a cluster is moving; the
 * current count/rate is recomputed on demand from project_events, so it can
 * never go stale inside a stored row.
 */
export const VELOCITY_WINDOW_DAYS = 90;
export const VELOCITY_MIN_PERMITS = 5;

/**
 * M2.6 depth (#3) — campus velocity. cluster_velocity groups by development
 * (name-based). A commercial/institutional CAMPUS files many DISTINCT-named
 * permits on adjacent parcels (SpaceX SE02–SE06: different buildings, different
 * parcels, no shared development) — cluster_velocity misses it and the account
 * sees N disconnected opportunities instead of one big site. Campus velocity
 * groups projects that are NOT development-grouped by their parcel-block prefix
 * (leading digits of the primary parcel = the plat/block) and emits a single
 * `campus_velocity` signal when enough distinct projects on one block have
 * active permits in the window. Excluding development-grouped projects keeps
 * residential subdivisions (already a cluster_velocity concern) out of it.
 */
export const CAMPUS_WINDOW_DAYS = 90;
export const CAMPUS_MIN_PROJECTS = 5;
/** Fallback block-prefix length when a county has no calibrated entry. */
export const PARCEL_BLOCK_PREFIX_LEN = 6;
/**
 * Per-county parcel-block prefix (#5), calibrated 2026-07-17 against the live
 * corpus (grouping power measured at len 5–8 per county):
 * - King (10-digit PIN): 6 = the official "major" number (plat/block) — exact
 *   semantics, max observed group 16.
 * - Lewis (12-digit): 6 = the base parcel of the 12-digit number; segregations
 *   and BLAs share it. Max observed group 4 — conservative.
 * - Thurston (11-digit): 7 — never merges beyond one plat for platted parcels
 *   and stays sub-quarter-section for unplatted; max observed group 5. At 5–6
 *   the unplatted numbering risks merging unrelated section-sized areas.
 * - Pierce (10-digit, calibrated 2026-07-17 after pierce_permits_arcgis
 *   activation, 3,857 parcels): 6 — max structural group 21 (vs 81 at len 5,
 *   189 at len 4); same plat/block altitude as King.
 * The ≥minProjects-distinct-projects-in-window activity gate is the primary
 * false-positive control; the prefix only shapes candidate grouping.
 */
export const PARCEL_BLOCK_PREFIX_BY_COUNTY: Record<string, number> = {
  King: 6,
  Lewis: 6,
  Pierce: 6,
  Thurston: 7,
};

export interface VelocitySummary {
  developmentsScanned: number;
  velocityEventsEmitted: number;
}

export async function computeClusterVelocity(
  db: Db,
  opts: {
    windowDays?: number;
    minPermits?: number;
    logger?: { info(o: unknown, m?: string): void };
  } = {},
): Promise<VelocitySummary> {
  const windowDays = opts.windowDays ?? VELOCITY_WINDOW_DAYS;
  const minPermits = opts.minPermits ?? VELOCITY_MIN_PERMITS;

  // Per development: permit events in window across member projects, the
  // most recent permit record (provenance), and the anchor project.
  const res = await db.execute(sql`
    WITH member_permits AS (
      SELECT p.development_id,
             pe.project_id,
             pe.source_record_id,
             pe.event_date,
             pe.observed_at
      FROM project_events pe
      JOIN projects p ON p.id = pe.project_id
      WHERE p.development_id IS NOT NULL
        AND pe.event_type IN ('permit_applied', 'permit_issued')
        AND COALESCE(pe.event_date, pe.observed_at) >= now() - make_interval(days => ${windowDays})
    ),
    clusters AS (
      SELECT development_id,
             count(*) AS permit_count,
             max(COALESCE(event_date, observed_at)) AS latest_at
      FROM member_permits
      GROUP BY development_id
      HAVING count(*) >= ${minPermits}
    )
    SELECT c.development_id, c.permit_count, c.latest_at,
      (SELECT mp.source_record_id FROM member_permits mp
        WHERE mp.development_id = c.development_id
        ORDER BY COALESCE(mp.event_date, mp.observed_at) DESC LIMIT 1) AS latest_record_id,
      COALESCE(
        (SELECT p2.parent_project_id FROM projects p2
          WHERE p2.development_id = c.development_id AND p2.parent_project_id IS NOT NULL LIMIT 1),
        (SELECT p3.id FROM projects p3
          WHERE p3.development_id = c.development_id ORDER BY p3.first_seen_at ASC LIMIT 1)
      ) AS anchor_project_id
    FROM clusters c`);

  let emitted = 0;
  for (const r of res.rows as {
    development_id: string;
    permit_count: string | number;
    latest_at: string;
    latest_record_id: string;
    anchor_project_id: string;
  }[]) {
    // Idempotency: one velocity event per (anchor, latest permit record) —
    // a new permit in the cluster moves latest_record_id and re-signals.
    const existing = await db.execute(sql`
      SELECT 1 FROM project_events
      WHERE project_id = ${r.anchor_project_id}
        AND event_type = 'cluster_velocity'
        AND source_record_id = ${r.latest_record_id}
      LIMIT 1`);
    if (existing.rows.length > 0) continue;

    await db.execute(sql`
      INSERT INTO project_events
        (project_id, source_record_id, event_type, event_date, observed_at,
         prior_stage, resulting_stage, material_change, confirmed, confidence)
      VALUES
        (${r.anchor_project_id}, ${r.latest_record_id}, 'cluster_velocity',
         ${r.latest_at}, now(), NULL, NULL, true, true, NULL)`);
    emitted++;
    opts.logger?.info(
      {
        developmentId: r.development_id,
        anchorProjectId: r.anchor_project_id,
        permitCount: Number(r.permit_count),
        windowDays,
      },
      "cluster velocity signal",
    );
  }

  const summary = {
    developmentsScanned: res.rows.length,
    velocityEventsEmitted: emitted,
  };
  opts.logger?.info(summary, "cluster velocity complete");
  return summary;
}

export interface CampusVelocitySummary {
  campusesFound: number;
  campusEventsEmitted: number;
  /** Member projects stamped with a derived campus_block this run. */
  projectsStamped: number;
}

export async function computeCampusVelocity(
  db: Db,
  opts: {
    windowDays?: number;
    minProjects?: number;
    prefixLen?: number;
    /** Restrict to one county (per-county production runs; test isolation). */
    county?: string;
    logger?: { info(o: unknown, m?: string): void };
  } = {},
): Promise<CampusVelocitySummary> {
  const windowDays = opts.windowDays ?? CAMPUS_WINDOW_DAYS;
  const minProjects = opts.minProjects ?? CAMPUS_MIN_PROJECTS;
  const countyFilter = opts.county ? sql`AND p.county = ${opts.county}` : sql``;
  // Per-county prefix (#5) unless a fixed length is forced. Built as a CASE
  // over the calibrated map so one query serves all counties.
  const prefixExpr =
    opts.prefixLen != null
      ? sql`${opts.prefixLen}::int`
      : sql`(CASE p.county ${sql.join(
          Object.entries(PARCEL_BLOCK_PREFIX_BY_COUNTY).map(
            ([county, len]) => sql`WHEN ${county} THEN ${len}`,
          ),
          sql` `,
        )} ELSE ${PARCEL_BLOCK_PREFIX_LEN} END)::int`;

  const res = await db.execute(sql`
    WITH member AS (
      SELECT p.id AS project_id, p.county, p.first_seen_at,
        left(regexp_replace(p.parcel_ids->>0, '[^0-9A-Za-z]', '', 'g'), ${prefixExpr}) AS block,
        pe.source_record_id,
        COALESCE(pe.event_date, pe.observed_at) AS at
      FROM projects p
      JOIN project_events pe ON pe.project_id = p.id
      WHERE p.development_id IS NULL
        ${countyFilter}
        AND p.parcel_ids->>0 IS NOT NULL
        AND length(regexp_replace(p.parcel_ids->>0, '[^0-9A-Za-z]', '', 'g')) >= ${prefixExpr}
        -- Any permit-lifecycle activity (application through issuance) counts as
        -- campus activity, including the application_submitted type King reports emit.
        AND pe.event_type IN ('permit_applied', 'permit_issued', 'application_submitted')
        AND COALESCE(pe.event_date, pe.observed_at) >= now() - make_interval(days => ${windowDays})
    ),
    campus AS (
      SELECT county, block, count(DISTINCT project_id) AS project_count, max(at) AS latest_at,
        json_agg(DISTINCT project_id) AS member_ids
      FROM member
      GROUP BY county, block
      HAVING count(DISTINCT project_id) >= ${minProjects}
    )
    SELECT c.county, c.block, c.project_count, c.latest_at, c.member_ids,
      (SELECT m.project_id FROM member m WHERE m.county = c.county AND m.block = c.block
        ORDER BY m.first_seen_at ASC LIMIT 1) AS anchor_project_id,
      (SELECT m.source_record_id FROM member m WHERE m.county = c.county AND m.block = c.block
        ORDER BY m.at DESC LIMIT 1) AS latest_record_id
    FROM campus c`);

  const campuses = res.rows as {
    county: string;
    block: string;
    project_count: string | number;
    latest_at: string;
    member_ids: string[];
    anchor_project_id: string;
    latest_record_id: string;
  }[];

  // Derived campus membership (#1): stamp campus_block on every member of a
  // qualifying campus so scoring, the UI, and the digest read one indexed
  // column instead of re-deriving parcel prefixes. Clear-then-stamp keeps the
  // column a pure recomputation of current state (a campus that goes quiet
  // loses the badge) — scoped to the county filter when one is set.
  let stamped = 0;
  await db.execute(sql`
    UPDATE projects p SET campus_block = NULL
    WHERE p.campus_block IS NOT NULL ${countyFilter}`);
  for (const c of campuses) {
    const key = `${c.county}:${c.block}`;
    const upd = await db.execute(sql`
      UPDATE projects SET campus_block = ${key}
      WHERE id IN (${sql.join(
        c.member_ids.map((id) => sql`${id}`),
        sql`, `,
      )})`);
    stamped += Number(upd.rowCount ?? 0);
  }

  let emitted = 0;
  for (const r of campuses) {
    // Idempotent: one campus_velocity per (anchor, latest permit record) — a new
    // permit on the block moves latest_record_id and re-signals.
    const existing = await db.execute(sql`
      SELECT 1 FROM project_events
      WHERE project_id = ${r.anchor_project_id}
        AND event_type = 'campus_velocity'
        AND source_record_id = ${r.latest_record_id}
      LIMIT 1`);
    if (existing.rows.length > 0) continue;

    await db.execute(sql`
      INSERT INTO project_events
        (project_id, source_record_id, event_type, event_date, observed_at,
         prior_stage, resulting_stage, material_change, confirmed, confidence)
      VALUES
        (${r.anchor_project_id}, ${r.latest_record_id}, 'campus_velocity',
         ${r.latest_at}, now(), NULL, NULL, true, true, NULL)`);
    emitted++;
    opts.logger?.info(
      {
        county: r.county,
        parcelBlock: r.block,
        anchorProjectId: r.anchor_project_id,
        projectCount: Number(r.project_count),
        windowDays,
      },
      "campus velocity signal",
    );
  }

  const summary = {
    campusesFound: campuses.length,
    campusEventsEmitted: emitted,
    projectsStamped: stamped,
  };
  opts.logger?.info(summary, "campus velocity complete");
  return summary;
}
