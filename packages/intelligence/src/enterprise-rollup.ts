/**
 * Enterprise rollup — combined activity for all OPERATING BRANDS of one legal
 * entity.
 *
 * Insights models the operating brand (what a permit names, who you call), so
 * one legal entity can legitimately own several `organizations` rows: Apollo
 * Sheet Metal and Apollo Mechanical Contractors are distinct brands of UBI
 * 600443607. `orgActivityRollup` answers "how active is this brand"; this
 * answers "how much is this COMPANY doing in-region, across all its brands"
 * without merging the brand rows away.
 *
 * The grouping key is `organizations.registry_ref` — the registry entity — so
 * only registry-bound orgs appear. Unbound orgs have no known enterprise and are
 * excluded rather than each being treated as its own (which would fill the
 * result with unresolved single-org "enterprises").
 */
import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";

/** One legal entity's combined activity across its brands. */
export interface EnterpriseRollupRow {
  /** registry entity_id — the enterprise identity. */
  registryRef: string;
  /** Distinct Insights org rows (operating brands) bound to this entity. */
  brandCount: number;
  /** Each brand's display name, alphabetical. */
  brandNames: string[];
  /** Distinct L&I licences across those brands; empty until accepts stamp them. */
  brandLicences: string[];
  /** Projects touched by ANY brand, counted ONCE even if two brands worked it. */
  projects: number;
  projects90d: number;
  counties: string[];
  /** Summed stated valuation over the DISTINCT projects (never double-counted). */
  statedValuationTotal: number | null;
  latestActivityAt: string | null;
}

export interface EnterpriseRollupOptions {
  /** Only enterprises with ≥ this many distinct projects (noise floor). */
  minProjects?: number;
  /** Restrict to one county. */
  county?: string;
  /** Restrict to one permitting jurisdiction (city-level view). Also what makes
   * a rollup deterministic over a shared database — see org-activity. */
  jurisdiction?: string;
  limit?: number;
}

/** Roles that count as doing work on a project (mirrors org-activity). */
const ACTIVITY_ROLES = ["primary_contractor", "applicant", "owner"] as const;

export async function enterpriseRollup(
  db: Db,
  opts: EnterpriseRollupOptions = {},
): Promise<EnterpriseRollupRow[]> {
  const minProjects = opts.minProjects ?? 1;
  const limit = Math.min(opts.limit ?? 100, 500);
  const countyFilter = opts.county ? sql`AND p.county = ${opts.county}` : sql``;
  const jurisdictionFilter = opts.jurisdiction
    ? sql`AND p.permitting_jurisdiction = ${opts.jurisdiction}`
    : sql``;

  const res = await db.execute(sql`
    WITH proj_val AS (
      SELECT rr.project_id, max((sr.normalized_json->>'valuationUsd')::numeric) AS v
      FROM record_resolutions rr
      JOIN source_records sr ON sr.id = rr.source_record_id
      WHERE rr.status = 'active' AND sr.normalized_json->>'valuationUsd' IS NOT NULL
      GROUP BY rr.project_id
    ),
    -- One row per (enterprise, project): collapsing here is what stops a project
    -- worked by two brands of the same company from being counted or valued twice.
    ent_project AS (
      SELECT o.registry_ref, pr.project_id, p.county,
             max(pr.last_seen_at) AS last_seen_at
      FROM project_roles pr
      JOIN organizations o ON o.id = pr.organization_id
      JOIN projects p ON p.id = pr.project_id
      WHERE o.registry_ref IS NOT NULL
        AND pr.role IN (${sql.join(ACTIVITY_ROLES.map((r) => sql`${r}`), sql`, `)})
        AND p.permitting_jurisdiction != 'Test Jurisdiction'
        ${countyFilter}
        ${jurisdictionFilter}
      GROUP BY o.registry_ref, pr.project_id, p.county
    ),
    activity AS (
      SELECT ep.registry_ref,
        count(*) AS projects,
        count(*) FILTER (WHERE ep.last_seen_at >= now() - interval '90 days') AS projects_90d,
        array_agg(DISTINCT ep.county) AS counties,
        sum(pv.v) AS val_total,
        max(ep.last_seen_at) AS latest_at
      FROM ent_project ep
      LEFT JOIN proj_val pv ON pv.project_id = ep.project_id
      GROUP BY ep.registry_ref
      HAVING count(*) >= ${minProjects}
    )
    SELECT a.registry_ref, a.projects, a.projects_90d, a.counties, a.val_total, a.latest_at,
           b.brand_count, b.brand_names, b.brand_licences
    FROM activity a
    JOIN LATERAL (
      SELECT count(*)::int AS brand_count,
             array_agg(o.canonical_name ORDER BY o.canonical_name) AS brand_names,
             array_remove(array_agg(DISTINCT o.registry_brand_ref), NULL) AS brand_licences
      FROM organizations o
      WHERE o.registry_ref = a.registry_ref
    ) b ON TRUE
    ORDER BY a.projects DESC, a.val_total DESC NULLS LAST, a.registry_ref
    LIMIT ${limit}`);

  const strArray = (v: unknown): string[] =>
    ((v as (string | null)[] | null) ?? []).filter((x): x is string => typeof x === "string");

  return (res.rows as Record<string, unknown>[]).map((r) => ({
    registryRef: r["registry_ref"] as string,
    brandCount: Number(r["brand_count"] ?? 0),
    brandNames: strArray(r["brand_names"]),
    brandLicences: strArray(r["brand_licences"]),
    projects: Number(r["projects"] ?? 0),
    projects90d: Number(r["projects_90d"] ?? 0),
    counties: strArray(r["counties"]),
    statedValuationTotal: r["val_total"] == null ? null : Number(r["val_total"]),
    latestActivityAt:
      r["latest_at"] == null ? null : new Date(r["latest_at"] as string).toISOString(),
  }));
}
