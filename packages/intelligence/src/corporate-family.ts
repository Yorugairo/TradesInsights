/**
 * Corporate-family rollup — combined activity for every legal entity under
 * COMMON CONTROL.
 *
 * The third and highest identity tier:
 *   brand (L&I contractor licence)  → `orgActivityRollup`
 *   enterprise (UBI / registry entity) → `enterpriseRollup`
 *   corporate family (shared principal) → here
 *
 * `Blue Flame Htg Air & Electric` and `Rescue Rooter` share a UBI, so the
 * enterprise tier already catches them. `Erdahl, Darrin P` controls NINE separate
 * UBIs — nine entities the enterprise tier necessarily sees as unrelated, because
 * common control sits above the UBI. This tier reads the principal to group them.
 *
 * A family is DERIVED, never stored: membership changes whenever L&I republishes,
 * and denormalizing it onto `organizations` would make a stale grouping look
 * authoritative. It is also purely analytic — it never creates a `registry_ref`,
 * never stamps an identifier, and never feeds `evaluateStrictBind`.
 *
 * PRIVACY: principal names are private individuals. Every consumer of this module
 * must sit behind `currentSession()`; nothing here may reach a public page, a
 * pSEO surface, or a digest to a non-customer.
 */
import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";
import type { PersonCandidate, RegistryIdentityRow } from "@otn/resolution";
import { corePrincipalKey } from "@otn/resolution";

/**
 * A group larger than this is almost certainly a registered agent that slipped
 * both registry-side filters, not a real family. The largest verified genuine
 * family is 9 entities, and zero groups exceed this cap in live data — so a
 * breach means the filters regressed. Such a group is DROPPED and logged, never
 * silently truncated: a truncated family reads as a small true one.
 */
export const MAX_FAMILY_ENTITIES = 12;

/** One set of registry entities under common control. */
export interface FamilyGroup {
  /** Deterministic id: the lexicographically smallest principal key in the group. */
  familyId: string;
  /** Every principal key that reaches this family (spelling variants collapse
   * registry-side, but one family can legitimately have several officers). */
  principalKeys: string[];
  /** Display spellings for those principals, deduped, alphabetical. */
  principalNames: string[];
  /** Registry entity ids in the family, sorted. */
  entityIds: string[];
  /** Those entities' canonical names, alphabetical. */
  entityNames: string[];
}

export interface BuildFamiliesResult {
  families: FamilyGroup[];
  /** Groups dropped for exceeding MAX_FAMILY_ENTITIES, with their size — surfaced
   * so an agent-filter regression is visible instead of silent. */
  dropped: { principalKey: string; entityCount: number }[];
}

/**
 * Group contract rows into corporate families by shared principal.
 *
 * PURE and DB-free. Union-find over (entity, principal) pairs: two entities join
 * when they share ANY principal, and two principals join when they sit on the
 * same entity — so a family with two officers who each also control a third
 * company resolves to one group rather than two overlapping ones.
 *
 * The coarse `SURNAME|GIVEN` key is used for grouping, matching the discovery
 * lane. Registry-side normalization already folds middle-name-vs-initial, so this
 * only additionally tolerates a missing middle name.
 */
export function buildFamilies(rows: RegistryIdentityRow[]): BuildFamiliesResult {
  // entity/principal nodes in one disjoint-set forest, namespaced by prefix.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = parent.get(x) ?? x;
    if (root === x) {
      parent.set(x, x);
      return x;
    }
    root = find(root);
    parent.set(x, root); // path compression
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const entityName = new Map<string, string | null>();
  const keyNames = new Map<string, Set<string>>();
  let sawPair = false;

  for (const row of rows) {
    if (row.status != null && row.status !== "active") continue;
    for (const p of row.principals ?? []) {
      const core = corePrincipalKey(p.key);
      if (!core) continue;
      sawPair = true;
      entityName.set(row.entityId, row.canonicalName);
      const names = keyNames.get(core) ?? new Set<string>();
      names.add(p.name);
      keyNames.set(core, names);
      union(`e:${row.entityId}`, `k:${core}`);
    }
  }
  if (!sawPair) return { families: [], dropped: [] };

  const groups = new Map<string, { entities: Set<string>; keys: Set<string> }>();
  for (const node of parent.keys()) {
    const root = find(node);
    const g = groups.get(root) ?? { entities: new Set<string>(), keys: new Set<string>() };
    if (node.startsWith("e:")) g.entities.add(node.slice(2));
    else g.keys.add(node.slice(2));
    groups.set(root, g);
  }

  const families: FamilyGroup[] = [];
  const dropped: BuildFamiliesResult["dropped"] = [];
  for (const g of groups.values()) {
    // A single entity is not a family — every entity has a principal, so keeping
    // them would return the whole registry as ~25,000 one-member "families".
    if (g.entities.size < 2) continue;
    const keys = [...g.keys].sort();
    if (g.entities.size > MAX_FAMILY_ENTITIES) {
      dropped.push({ principalKey: keys[0] ?? "?", entityCount: g.entities.size });
      continue;
    }
    const names = new Set<string>();
    for (const k of keys) for (const n of keyNames.get(k) ?? []) names.add(n);
    const entityIds = [...g.entities].sort();
    families.push({
      familyId: keys[0]!,
      principalKeys: keys,
      principalNames: [...names].sort(),
      entityIds,
      entityNames: entityIds
        .map((id) => entityName.get(id) ?? null)
        .filter((n): n is string => n !== null)
        .sort(),
    });
  }
  families.sort((a, b) => b.entityIds.length - a.entityIds.length || a.familyId.localeCompare(b.familyId));
  return { families, dropped };
}

/** One corporate family's combined activity across every brand of every member. */
export interface CorporateFamilyRollupRow extends FamilyGroup {
  /** Registry entities in the family that Insights actually has orgs bound to. */
  boundEntityCount: number;
  /** Distinct Insights org rows (operating brands) across the whole family. */
  brandCount: number;
  orgNames: string[];
  /** Projects touched by ANY member, counted ONCE even if two members worked it. */
  projects: number;
  projects90d: number;
  counties: string[];
  statedValuationTotal: number | null;
  latestActivityAt: string | null;
}

export interface CorporateFamilyRollupOptions {
  minProjects?: number;
  county?: string;
  jurisdiction?: string;
  limit?: number;
}

/** Roles that count as doing work on a project (mirrors enterprise-rollup). */
const ACTIVITY_ROLES = ["primary_contractor", "applicant", "owner"] as const;

/**
 * Roll activity up to the corporate family.
 *
 * Takes the families as an argument rather than reading them, because they are
 * derived from the REGISTRY contract while activity lives in Insights — one
 * caller fetches the contract once and reuses it for both this and the discovery
 * lane.
 */
export async function corporateFamilyRollup(
  db: Db,
  families: FamilyGroup[],
  opts: CorporateFamilyRollupOptions = {},
): Promise<CorporateFamilyRollupRow[]> {
  if (families.length === 0) return [];
  const minProjects = opts.minProjects ?? 1;
  const limit = Math.min(opts.limit ?? 100, 500);
  const countyFilter = opts.county ? sql`AND p.county = ${opts.county}` : sql``;
  const jurisdictionFilter = opts.jurisdiction
    ? sql`AND p.permitting_jurisdiction = ${opts.jurisdiction}`
    : sql``;

  // (family_id, entity_id) pairs pushed down as a VALUES list so the grouping
  // happens in the database and a project shared by two members collapses before
  // aggregation — the same reason enterprise-rollup has its `ent_project` CTE.
  const pairs = families.flatMap((f) => f.entityIds.map((e) => sql`(${f.familyId}, ${e})`));

  const res = await db.execute(sql`
    WITH fam(family_id, entity_id) AS (VALUES ${sql.join(pairs, sql`, `)}),
    proj_val AS (
      SELECT rr.project_id, max((sr.normalized_json->>'valuationUsd')::numeric) AS v
      FROM record_resolutions rr
      JOIN source_records sr ON sr.id = rr.source_record_id
      WHERE rr.status = 'active' AND sr.normalized_json->>'valuationUsd' IS NOT NULL
      GROUP BY rr.project_id
    ),
    -- One row per (family, project): collapsing here is what stops a project
    -- worked by two COMPANIES of the same family being counted or valued twice.
    fam_project AS (
      SELECT f.family_id, pr.project_id, p.county,
             max(pr.last_seen_at) AS last_seen_at
      FROM project_roles pr
      JOIN organizations o ON o.id = pr.organization_id
      JOIN fam f ON f.entity_id = o.registry_ref
      JOIN projects p ON p.id = pr.project_id
      WHERE pr.role IN (${sql.join(ACTIVITY_ROLES.map((r) => sql`${r}`), sql`, `)})
        AND p.permitting_jurisdiction != 'Test Jurisdiction'
        ${countyFilter}
        ${jurisdictionFilter}
      GROUP BY f.family_id, pr.project_id, p.county
    ),
    activity AS (
      SELECT fp.family_id,
        count(*) AS projects,
        count(*) FILTER (WHERE fp.last_seen_at >= now() - interval '90 days') AS projects_90d,
        array_agg(DISTINCT fp.county) AS counties,
        sum(pv.v) AS val_total,
        max(fp.last_seen_at) AS latest_at
      FROM fam_project fp
      LEFT JOIN proj_val pv ON pv.project_id = fp.project_id
      GROUP BY fp.family_id
      HAVING count(*) >= ${minProjects}
    )
    SELECT a.family_id, a.projects, a.projects_90d, a.counties, a.val_total, a.latest_at,
           b.brand_count, b.org_names, b.bound_entities
    FROM activity a
    JOIN LATERAL (
      SELECT count(*)::int AS brand_count,
             array_agg(o.canonical_name ORDER BY o.canonical_name) AS org_names,
             count(DISTINCT o.registry_ref)::int AS bound_entities
      FROM organizations o
      JOIN fam f2 ON f2.entity_id = o.registry_ref
      WHERE f2.family_id = a.family_id
    ) b ON TRUE
    ORDER BY a.projects DESC, a.val_total DESC NULLS LAST, a.family_id
    LIMIT ${limit}`);

  const strArray = (v: unknown): string[] =>
    ((v as (string | null)[] | null) ?? []).filter((x): x is string => typeof x === "string");
  const byId = new Map(families.map((f) => [f.familyId, f]));

  return (res.rows as Record<string, unknown>[]).flatMap((r) => {
    const family = byId.get(r["family_id"] as string);
    if (!family) return [];
    return [{
      ...family,
      boundEntityCount: Number(r["bound_entities"] ?? 0),
      brandCount: Number(r["brand_count"] ?? 0),
      orgNames: strArray(r["org_names"]),
      projects: Number(r["projects"] ?? 0),
      projects90d: Number(r["projects_90d"] ?? 0),
      counties: strArray(r["counties"]),
      statedValuationTotal: r["val_total"] == null ? null : Number(r["val_total"]),
      latestActivityAt:
        r["latest_at"] == null ? null : new Date(r["latest_at"] as string).toISOString(),
    }];
  });
}

/**
 * Load the Insights-side people to test against registry principals.
 *
 * Two sources, kept labelled because they mean different things:
 * - `organization` — an org row whose canonical name is a human. Usually a sole
 *   proprietor. If that human is a principal of registry entities, this "small
 *   unrelated outfit" is actually part of a corporate family.
 * - `contact` — a named person at a company. If they are a principal of a
 *   DIFFERENT entity, that is cross-company control we could not otherwise see.
 *
 * Only public-provenance contacts are read. Customer-supplied contacts are that
 * customer's private CRM data and must not be cross-referenced against the
 * registry for anyone else's benefit.
 */
export async function loadPersonCandidates(db: Db, limit = 5000): Promise<PersonCandidate[]> {
  const capped = Math.min(limit, 20000);
  // Coarse SQL prefilter: two or three words and no obvious company token. It
  // exists only to avoid dragging every organization row across the wire —
  // `personCoreKey` remains the authoritative gate, and it is strictly stricter
  // than this, so the prefilter can never admit something the key would reject.
  const looksPersonal = (col: ReturnType<typeof sql>) => sql`
    ${col} IS NOT NULL
    AND ${col} ~ '^[A-Za-z][A-Za-z''.,-]*( +[A-Za-z][A-Za-z''.,-]*){1,2}$'
    AND ${col} !~* '\\m(llc|inc|corp|co|company|pllc|ltd|lp|llp|ps|pc|group|services?|construction|contracting|contractors?|plumbing|electric|heating|roofing|hvac|mechanical|builders?|homes?|trust|and|the)\\M'`;
  // Each source gets its OWN cap: a single shared LIMIT over the union would let
  // the (much larger) organization side crowd contacts out entirely.
  const res = await db.execute(sql`
    (SELECT 'organization'::text AS source, o.id::text AS organization_id,
            o.canonical_name AS organization_name, o.canonical_name AS person_name,
            o.registry_ref
       FROM organizations o
      WHERE ${looksPersonal(sql`o.canonical_name`)}
      ORDER BY o.canonical_name
      LIMIT ${capped})
    UNION ALL
    (SELECT 'contact', o.id::text, o.canonical_name, c.name, o.registry_ref
       FROM organization_contacts c
       JOIN organizations o ON o.id = c.organization_id
      WHERE c.source_type = 'public_business' AND ${looksPersonal(sql`c.name`)}
      ORDER BY c.name
      LIMIT ${capped})`);

  return (res.rows as Record<string, unknown>[]).map((r) => ({
    source: r["source"] as PersonCandidate["source"],
    organizationId: r["organization_id"] as string,
    organizationName: (r["organization_name"] as string | null) ?? "",
    personName: (r["person_name"] as string | null) ?? "",
    registryRef: (r["registry_ref"] as string | null) ?? null,
  }));
}
