import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";

/**
 * #2 — lead-time backtest. Two deterministic measurements over stored events,
 * answering the question a pilot customer actually asks: "how many days of
 * advance notice does OTN give me?"
 *
 * 1. EVIDENCE LEAD TIME (per account): for each of the account's opportunities
 *    whose project reached a permit-issued milestone, the days between the
 *    EARLIEST event on the project's timeline (SEPA, entitlement, application…)
 *    and the permit-issued event. 0 = the permit itself was our first sighting
 *    (no early warning); large = the evidence graph knew long before the
 *    permit. Uses stated event dates, so it measures what the SOURCE GRAPH
 *    could have known — independent of when we started fetching.
 *
 * 2. DETECTION LAG (per source): record first_seen_at minus the stated
 *    event_date — the pipeline's freshness. Backfilled history inflates the
 *    all-time number (a record ingested months after its event date is not a
 *    live miss), so a recent window (records first seen in the trailing 30
 *    days) is reported alongside it.
 *
 * No fabrication: projects without a dated permit-issued event are excluded,
 * not guessed; empty sets return nulls, never zeros.
 */

export interface EvidenceLeadTime {
  /** Opportunities whose project has a dated permit-issued milestone. */
  measured: number;
  medianDays: number | null;
  p25Days: number | null;
  p75Days: number | null;
  /** Share of measured opportunities with ≥30/60/90 days of advance notice. */
  shareGte30d: number | null;
  shareGte60d: number | null;
  shareGte90d: number | null;
  /** Measured but with zero lead — first sighting WAS the permit. */
  noEarlyWarning: number;
}

export async function evidenceLeadTime(
  db: Db,
  accountProfileId: string,
): Promise<EvidenceLeadTime> {
  const res = await db.execute(sql`
    WITH milestones AS (
      SELECT o.project_id,
        MIN(pe.event_date) FILTER (WHERE pe.resulting_stage = 'permit_issued') AS issued_at,
        MIN(COALESCE(pe.event_date, pe.observed_at)) AS earliest_at
      FROM opportunities o
      JOIN project_events pe ON pe.project_id = o.project_id
      WHERE o.account_profile_id = ${accountProfileId}
      GROUP BY o.project_id
    ),
    leads AS (
      SELECT GREATEST(extract(epoch FROM issued_at - earliest_at) / 86400, 0) AS lead_days
      FROM milestones WHERE issued_at IS NOT NULL
    )
    SELECT count(*) AS n,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY lead_days) AS median,
      percentile_cont(0.25) WITHIN GROUP (ORDER BY lead_days) AS p25,
      percentile_cont(0.75) WITHIN GROUP (ORDER BY lead_days) AS p75,
      count(*) FILTER (WHERE lead_days >= 30) AS ge30,
      count(*) FILTER (WHERE lead_days >= 60) AS ge60,
      count(*) FILTER (WHERE lead_days >= 90) AS ge90,
      count(*) FILTER (WHERE lead_days < 1) AS no_warning
    FROM leads`);
  const r = res.rows[0] as Record<string, unknown>;
  const n = Number(r["n"] ?? 0);
  const days = (v: unknown): number | null =>
    v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10;
  const share = (v: unknown): number | null =>
    n === 0 ? null : Math.round((Number(v) / n) * 1000) / 1000;
  return {
    measured: n,
    medianDays: days(r["median"]),
    p25Days: days(r["p25"]),
    p75Days: days(r["p75"]),
    shareGte30d: share(r["ge30"]),
    shareGte60d: share(r["ge60"]),
    shareGte90d: share(r["ge90"]),
    noEarlyWarning: Number(r["no_warning"] ?? 0),
  };
}

export interface SourceDetectionLag {
  sourceKey: string;
  events: number;
  /** All-time median — inflated by backfill (a backfilled record is not a live miss). */
  medianDaysAllTime: number | null;
  /** Median over records first seen in the trailing window (default 30d) — live freshness. */
  recentEvents: number;
  medianDaysRecent: number | null;
}

export async function detectionLagBySource(
  db: Db,
  opts: { recentWindowDays?: number; includeTestSources?: boolean } = {},
): Promise<SourceDetectionLag[]> {
  const windowDays = opts.recentWindowDays ?? 30;
  const testFilter = opts.includeTestSources ? sql`` : sql`AND s.priority != 'test'`;
  const res = await db.execute(sql`
    SELECT s.key,
      count(*) AS events,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM sr.first_seen_at - pe.event_date) / 86400)
        AS median_all,
      count(*) FILTER (WHERE sr.first_seen_at >= now() - make_interval(days => ${windowDays})) AS recent_events,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM sr.first_seen_at - pe.event_date) / 86400)
        FILTER (WHERE sr.first_seen_at >= now() - make_interval(days => ${windowDays})) AS median_recent
    FROM project_events pe
    JOIN source_records sr ON sr.id = pe.source_record_id
    JOIN sources s ON s.id = sr.source_id
    WHERE pe.event_date IS NOT NULL ${testFilter}
    GROUP BY s.key
    ORDER BY s.key`);
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    sourceKey: r["key"] as string,
    events: Number(r["events"] ?? 0),
    medianDaysAllTime:
      r["median_all"] === null ? null : Math.round(Number(r["median_all"]) * 10) / 10,
    recentEvents: Number(r["recent_events"] ?? 0),
    medianDaysRecent:
      r["median_recent"] === null || r["median_recent"] === undefined
        ? null
        : Math.round(Number(r["median_recent"]) * 10) / 10,
  }));
}

/** A per-source first-look group needs at least this many milestoned projects
 * before its median is published — a thin sample would read as an
 * over-confident guarantee. */
export const FIRST_LOOK_MIN_SAMPLES = 20;

export interface SourceFirstLook {
  sourceKey: string;
  /** The source's county (null for statewide feeds like wa_sepa). */
  county: string | null;
  /** Milestoned projects this source surfaced FIRST (before any other source). */
  projects: number;
  /** Median days our earliest sighting predated the permit-issued milestone,
   * over ALL milestoned projects (0 for a permit-only source that never beats
   * the permit — most projects are permit-first, so this understates the edge). */
  medianLeadDays: number | null;
  p25Days: number | null;
  p75Days: number | null;
  /** Share whose first sighting genuinely predated the permit (lead > 0) —
   * "how often we surface it before it hits the boards". */
  shareEarly: number | null;
  /** Median lead over ONLY the early ones (lead > 0) — "when we are early, how
   * early". The marketable number; null when nothing was early. */
  medianLeadDaysWhenEarly: number | null;
}

/**
 * FIRST-LOOK ADVANTAGE (per first-look source × county) — the "we see it first"
 * number, the marketable proof behind the premium price. For every project
 * that reached the bid-relevant `permit_issued` milestone, the days between OUR
 * EARLIEST sighting of that project and the permit-issued date, credited to the
 * source that gave us that earliest sighting. `permit_issued` is the
 * public/biddable proxy: once a permit issues it surfaces on the aggregator bid
 * boards, so "days before permit_issued" is "days before everyone else could
 * act on it". A permit-only source scores ~0 here (it never beats the permit);
 * a pre-permit feed (SEPA, land-use, pre-application) shows real lead.
 *
 * No fabrication: stated event dates (ingestion time only as a fallback), lead
 * floored at 0, test sources excluded, and groups below the sample floor are
 * dropped rather than published thin.
 */
export async function firstLookByCoverage(
  db: Db,
  opts: { minSamples?: number; includeTestSources?: boolean } = {},
): Promise<SourceFirstLook[]> {
  const floor = opts.minSamples ?? FIRST_LOOK_MIN_SAMPLES;
  const testFilter = opts.includeTestSources ? sql`` : sql`AND s.priority != 'test'`;
  const res = await db.execute(sql`
    WITH ev AS (
      SELECT pe.project_id, s.key AS source_key, s.county AS county,
        COALESCE(pe.event_date, pe.observed_at) AS at, pe.resulting_stage
      FROM project_events pe
      JOIN source_records sr ON sr.id = pe.source_record_id
      JOIN sources s ON s.id = sr.source_id
      WHERE COALESCE(pe.event_date, pe.observed_at) IS NOT NULL ${testFilter}
    ),
    milestone AS (
      SELECT project_id, MIN(at) FILTER (WHERE resulting_stage = 'permit_issued') AS issued_at
      FROM ev GROUP BY project_id
    ),
    first_sight AS (
      SELECT DISTINCT ON (project_id) project_id, source_key, county, at AS earliest_at
      FROM ev ORDER BY project_id, at ASC
    ),
    leads AS (
      SELECT fs.source_key, fs.county,
        GREATEST(extract(epoch FROM m.issued_at - fs.earliest_at) / 86400, 0) AS lead_days
      FROM first_sight fs JOIN milestone m ON m.project_id = fs.project_id
      WHERE m.issued_at IS NOT NULL
    )
    SELECT source_key, county, count(*) AS n,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY lead_days) AS median,
      percentile_cont(0.25) WITHIN GROUP (ORDER BY lead_days) AS p25,
      percentile_cont(0.75) WITHIN GROUP (ORDER BY lead_days) AS p75,
      count(*) FILTER (WHERE lead_days > 0) AS early,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY lead_days) FILTER (WHERE lead_days > 0) AS median_early
    FROM leads
    GROUP BY source_key, county
    HAVING count(*) >= ${floor}
    ORDER BY median_early DESC NULLS LAST, early DESC`);
  const days = (v: unknown): number | null =>
    v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10;
  return (res.rows as Record<string, unknown>[]).map((r) => {
    const n = Number(r["n"] ?? 0);
    return {
      sourceKey: r["source_key"] as string,
      county: (r["county"] as string | null) ?? null,
      projects: n,
      medianLeadDays: days(r["median"]),
      p25Days: days(r["p25"]),
      p75Days: days(r["p75"]),
      shareEarly: n === 0 ? null : Math.round((Number(r["early"]) / n) * 1000) / 1000,
      medianLeadDaysWhenEarly: days(r["median_early"]),
    };
  });
}
