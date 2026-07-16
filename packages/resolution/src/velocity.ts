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
