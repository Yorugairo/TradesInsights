import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";
import { orgNameKey, splitOrgNameAddress } from "@otn/resolution";

/**
 * P1 — GC league table + relationship target list. A trade sub (Solis first)
 * wins work through GC relationships: the question this module answers is
 * "which organizations keep running relevant work in my territory — and which
 * of them don't know me yet?" Everything is a deterministic rollup over
 * stored roles/projects/valuations; account relevance is the ROUTER's
 * judgment (an org's project counts as relevant when it has an opportunity
 * row for the account), never a fresh guess.
 *
 * Name hygiene (display/grouping only — organization rows in the graph are
 * never merged here): variants that share an `orgNameKey` ("ABC Construction"
 * / "ABC CONSTRUCTION LLC") roll up into one league row listing its variants,
 * and names with a fused mailing address are split so the individual/entity
 * heuristics run on the actual name.
 */

/** Roles that indicate the org is running/owning work (agencies excluded). */
const ACTIVITY_ROLES = ["applicant", "owner", "primary_contractor", "contractor"] as const;

/** Data-quality flags — flagged, never silently dropped. */
const PLACEHOLDER_RE =
  /^(NO |NOT |N\/A|NA$|UNKNOWN|NONE|OWNER$|SAME AS|TBD|SEE |APPLICANT$|PER PLANS)/i;
const ENTITY_TOKEN_RE =
  /(LLC|INC|CORP|COMPANY|CO\.|LP|LLP|PLLC|LTD|GROUP|CONSTRUCTION|BUILDERS|HOMES|DEVELOPMENT|ELECTRIC|PLUMBING|MECHANICAL|ROOFING|SERVICES|ENTERPRISES|ASSOCIATES|PARTNERS|CITY OF|COUNTY|DISTRICT|AUTHORITY|CHURCH|SCHOOL)/i;

function looksLikeEntity(cleanedName: string): boolean {
  return (
    ENTITY_TOKEN_RE.test(cleanedName) || cleanedName.split(/\s+/).filter(Boolean).length >= 4
  );
}

export interface OrgActivityRow {
  /** Primary variant's organization id (most projects in the group). */
  organizationId: string;
  /** Cleaned display name (address tail stripped, canonical casing). */
  name: string;
  /** Raw canonical names covered by this row (≥1; >1 when variants grouped). */
  variantNames: string[];
  registryRef: string | null;
  /** True when the org carries a governed registry binding that has been verified
   * (organizations.verified_at IS NOT NULL) — drives the digest "✓ verified" badge. */
  verified: boolean;
  /** GLOBAL public-business phone adopted from the registry (L&I or, when L&I is
   * absent, Google) — account_profile_id IS NULL, source_type 'public_business'.
   * Null when no public contact has been adopted yet. */
  phone: string | null;
  /** Google Business rating (0–5) cached on the registry identity snapshot; null
   * when unbound or unrated. Display/signal only, never a score input. */
  rating: number | null;
  /** 'placeholder' | 'likely_individual' | 'address_in_name' (UI filters, never deletes). */
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

interface VariantRow {
  organization_id: string;
  canonical_name: string;
  registry_ref: string | null;
  relationship_state: string | null;
  verified: boolean;
  gc_phone: string | null;
  rating: number | null;
  projects: number;
  projects_90d: number;
  counties: string[];
  relevant_projects: number;
  val_total: number | null;
  val_max: number | null;
  latest_at: string | null;
}

export async function orgActivityRollup(
  db: Db,
  opts: OrgActivityOptions,
): Promise<OrgActivityRow[]> {
  const minProjects = opts.minProjects ?? 2;
  const limit = Math.min(opts.limit ?? 100, 500);
  const countyFilter = opts.county ? sql`AND p.county = ${opts.county}` : sql``;

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
    SELECT a.*, o.canonical_name, o.registry_ref, rel.relationship_state,
      (o.verified_at IS NOT NULL) AS verified,
      (o.registry_identity_json->>'google_rating')::float AS rating,
      (SELECT oc.phone FROM organization_contacts oc
         WHERE oc.organization_id = a.organization_id
           AND oc.account_profile_id IS NULL
           AND oc.source_type = 'public_business'
           AND oc.phone IS NOT NULL
         ORDER BY oc.phone
         LIMIT 1) AS gc_phone
    FROM activity a
    JOIN organizations o ON o.id = a.organization_id
    LEFT JOIN account_organization_relationships rel
      ON rel.organization_id = a.organization_id
      AND rel.account_profile_id = ${opts.accountProfileId}
    ORDER BY a.relevant_projects DESC, a.val_total DESC NULLS LAST, a.projects DESC
    LIMIT 500`);

  // Group variants by name key. Counts are summed across variants (a project
  // shared by two variants of the same org counts once per variant — league
  // display, not the system of record).
  const groups = new Map<string, VariantRow[]>();
  for (const raw of res.rows as unknown as VariantRow[]) {
    const key = orgNameKey(raw.canonical_name);
    const list = groups.get(key);
    if (list) list.push(raw);
    else groups.set(key, [raw]);
  }

  const rows: OrgActivityRow[] = [];
  for (const variants of groups.values()) {
    // Deterministic primary: most projects, name as tie-break.
    variants.sort(
      (a, b) =>
        Number(b.projects) - Number(a.projects) ||
        a.canonical_name.localeCompare(b.canonical_name),
    );
    const primary = variants[0]!;
    const split = splitOrgNameAddress(primary.canonical_name);
    const hadTail = variants.some((v) => splitOrgNameAddress(v.canonical_name).addressTail !== null);
    // A legal suffix / entity token on ANY variant is evidence for the whole
    // group — "COLE DRYWALL" grouped with "COLE DRYWALL LLC" is a company
    // even when the suffix-less spelling is primary.
    const anyEntity = variants.some((v) => looksLikeEntity(splitOrgNameAddress(v.canonical_name).name));
    const flags: string[] = [];
    if (PLACEHOLDER_RE.test(split.name)) flags.push("placeholder");
    if (!anyEntity) flags.push("likely_individual");
    if (hadTail) flags.push("address_in_name");
    const valTotals = variants.map((v) => v.val_total).filter((v): v is number => v !== null);
    const valMaxes = variants.map((v) => v.val_max).filter((v): v is number => v !== null);
    const latest = variants.map((v) => v.latest_at).filter((v): v is string => v !== null).sort();
    const phone = variants.map((v) => v.gc_phone).find((p) => p != null) ?? null;
    const ratingHit = variants.map((v) => v.rating).find((r) => r != null) ?? null;
    rows.push({
      organizationId: primary.organization_id,
      name: split.name,
      variantNames: variants.map((v) => v.canonical_name),
      registryRef: variants.find((v) => v.registry_ref !== null)?.registry_ref ?? null,
      // A verified binding on ANY variant verifies the grouped org; the public
      // phone/rating come from whichever variant carries them (adopted globally).
      verified: variants.some((v) => v.verified),
      phone,
      rating: ratingHit == null ? null : Number(ratingHit),
      flags,
      projects: variants.reduce((s, v) => s + Number(v.projects), 0),
      projects90d: variants.reduce((s, v) => s + Number(v.projects_90d), 0),
      counties: [...new Set(variants.flatMap((v) => v.counties ?? []))].sort(),
      relevantProjects: variants.reduce((s, v) => s + Number(v.relevant_projects ?? 0), 0),
      statedValuationTotal:
        valTotals.length > 0 ? valTotals.reduce((s, v) => s + Number(v), 0) : null,
      statedValuationMax: valMaxes.length > 0 ? Math.max(...valMaxes.map(Number)) : null,
      latestActivityAt: latest.length > 0 ? latest[latest.length - 1]! : null,
      relationshipState:
        primary.relationship_state ??
        variants.find((v) => v.relationship_state !== null)?.relationship_state ??
        null,
    });
  }

  const filtered = opts.includeFlagged
    ? rows
    : rows.filter((r) => !r.flags.includes("placeholder") && !r.flags.includes("likely_individual"));
  filtered.sort(
    (a, b) =>
      b.relevantProjects - a.relevantProjects ||
      (b.statedValuationTotal ?? -1) - (a.statedValuationTotal ?? -1) ||
      b.projects - a.projects,
  );
  return filtered.slice(0, limit);
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
