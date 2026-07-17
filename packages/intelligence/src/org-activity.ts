import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";

/**
 * P1 — GC league table + relationship target list. A trade sub (Solis first)
 * wins work through GC relationships: the question this module answers is
 * "which organizations keep running relevant work in my territory — and which
 * of them don't know me yet?" Everything is a deterministic rollup over
 * stored roles/projects/valuations; account relevance is the ROUTER's
 * judgment (an org's project counts as relevant when it has an opportunity
 * row for the account), never a fresh guess.
 */

/** Roles that indicate the org is running/owning work (agencies excluded). */
const ACTIVITY_ROLES = ["applicant", "owner", "primary_contractor", "contractor"] as const;

/** Data-quality flags — flagged, never silently dropped. */
const PLACEHOLDER_RE =
  "^(NO |NOT |N/A|NA$|UNKNOWN|NONE|OWNER$|SAME AS|TBD|SEE |APPLICANT$|PER PLANS)";
const ENTITY_TOKEN_RE = "(LLC|INC|CORP|COMPANY|CO\\.|LP|LLP|PLLC|LTD|GROUP|CONSTRUCTION|BUILDERS|HOMES|DEVELOPMENT|ELECTRIC|PLUMBING|MECHANICAL|ROOFING|SERVICES|ENTERPRISES|ASSOCIATES|PARTNERS|CITY OF|COUNTY|DISTRICT|AUTHORITY|CHURCH|SCHOOL)";

export interface OrgActivityRow {
  organizationId: string;
  name: string;
  registryRef: string | null;
  /** Data-quality flags: 'placeholder' | 'likely_individual' (UI filters, never deletes). */
  flags: string[];
  projects: number;
  projects90d: number;
  counties: string[];
  /** Projects of this org routed to the account (any non-archive band) — the
   * router's relevance judgment, not a keyword guess. */
  relevantProjects: number;
  statedValuationTotal: number | null;
  statedValuationMax: number | null;
  latestActivityAt: string | null;
  relationshipState: string | null;
}

export interface OrgActivityOptions {
  /** Account whose routing defines relevance + whose relationship states join. */
  accountProfileId: string;
  county?: string;
  /** Only orgs with ≥ this many total projects (noise floor). */
  minProjects?: number;
  includeFlagged?: boolean;
  limit?: number;
}

export async function orgActivityRollup(
  db: Db,
  opts: OrgActivityOptions,
): Promise<OrgActivityRow[]> {
  const minProjects = opts.minProjects ?? 2;
  const limit = Math.min(opts.limit ?? 100, 500);
  const countyFilter = opts.county ? sql`AND p.county = ${opts.county}` : sql``;
  const flaggedFilter = opts.includeFlagged
    ? sql``
    : sql`AND NOT (o.canonical_name ~* ${PLACEHOLDER_RE})
          AND (o.canonical_name ~* ${ENTITY_TOKEN_RE}
               OR array_length(regexp_split_to_array(trim(o.canonical_name), '\\s+'), 1) >= 4)`;

  const res = await db.execute(sql`
    WITH proj_val AS (
      SELECT rr.project_id, max((sr.normalized_json->>'valuationUsd')::numeric) AS v
      FROM record_resolutions rr
      JOIN source_records sr ON sr.id = rr.source_record_id
      WHERE rr.status = 'active' AND sr.normalized_json->>'valuationUsd' IS NOT NULL
      GROUP BY rr.project_id
    ),
    activity AS (
      SELECT pr.organization_id,
        count(DISTINCT pr.project_id) AS projects,
        count(DISTINCT pr.project_id) FILTER (
          WHERE pr.last_seen_at >= now() - interval '90 days') AS projects_90d,
        array_agg(DISTINCT p.county) AS counties,
        count(DISTINCT opp.project_id) AS relevant_projects,
        sum(pv.v) AS val_total,
        max(pv.v) AS val_max,
        max(pr.last_seen_at) AS latest_at
      FROM project_roles pr
      JOIN projects p ON p.id = pr.project_id
      LEFT JOIN proj_val pv ON pv.project_id = pr.project_id
      LEFT JOIN opportunities opp ON opp.project_id = pr.project_id
        AND opp.account_profile_id = ${opts.accountProfileId}
        AND opp.state != 'archive'
      WHERE pr.role IN (${sql.join(
        ACTIVITY_ROLES.map((r) => sql`${r}`),
        sql`, `,
      )})
        AND p.permitting_jurisdiction != 'Test Jurisdiction'
        ${countyFilter}
      GROUP BY pr.organization_id
      HAVING count(DISTINCT pr.project_id) >= ${minProjects}
    )
    SELECT a.*, o.canonical_name, o.registry_ref,
      (o.canonical_name ~* ${PLACEHOLDER_RE}) AS is_placeholder,
      NOT (o.canonical_name ~* ${ENTITY_TOKEN_RE}
           OR array_length(regexp_split_to_array(trim(o.canonical_name), '\\s+'), 1) >= 4)
        AS is_individual,
      rel.relationship_state
    FROM activity a
    JOIN organizations o ON o.id = a.organization_id
    LEFT JOIN account_organization_relationships rel
      ON rel.organization_id = a.organization_id
      AND rel.account_profile_id = ${opts.accountProfileId}
    WHERE true ${flaggedFilter}
    ORDER BY a.relevant_projects DESC, a.val_total DESC NULLS LAST, a.projects DESC
    LIMIT ${limit}`);

  return (res.rows as Record<string, unknown>[]).map((r) => ({
    organizationId: r["organization_id"] as string,
    name: r["canonical_name"] as string,
    registryRef: (r["registry_ref"] as string | null) ?? null,
    flags: [
      ...(r["is_placeholder"] ? ["placeholder"] : []),
      ...(r["is_individual"] ? ["likely_individual"] : []),
    ],
    projects: Number(r["projects"]),
    projects90d: Number(r["projects_90d"]),
    counties: (r["counties"] as string[]) ?? [],
    relevantProjects: Number(r["relevant_projects"] ?? 0),
    statedValuationTotal: r["val_total"] === null ? null : Number(r["val_total"]),
    statedValuationMax: r["val_max"] === null ? null : Number(r["val_max"]),
    latestActivityAt: (r["latest_at"] as string | null) ?? null,
    relationshipState: (r["relationship_state"] as string | null) ?? null,
  }));
}

/**
 * P1.2 — the weekly "relationship play" generator: active, relevant orgs the
 * account has NO working relationship with. Blocked/do-not-pursue/incumbent
 * orgs are excluded here (suppression, §9), as are already-worked states.
 */
export async function relationshipTargets(
  db: Db,
  accountProfileId: string,
  opts: { minRelevantProjects?: number; limit?: number } = {},
): Promise<OrgActivityRow[]> {
  const minRelevant = opts.minRelevantProjects ?? 2;
  const rows = await orgActivityRollup(db, {
    accountProfileId,
    minProjects: minRelevant,
    limit: 500,
  });
  return rows
    .filter(
      (r) =>
        r.relevantProjects >= minRelevant &&
        (r.relationshipState === null ||
          r.relationshipState === "unknown" ||
          r.relationshipState === "research_needed"),
    )
    .slice(0, Math.min(opts.limit ?? 20, 100));
}
