import { sql, type SQL } from "drizzle-orm";
import type { Db } from "@otn/db";
import type { NormalizedSourceRecord } from "@otn/domain";
import { nameSimilarity, type MatchFeatures } from "./normalize.js";

/**
 * M2.3 — fuzzy/geospatial candidate generation (spec §10 passes 4–5) with
 * review thresholds. Rules, per spec:
 *  - Pass 4 (address + compatible name): auto only when the normalized
 *    address matches AND the name is compatible AND not generic. Same
 *    address with an incompatible/generic name (separate tenant projects)
 *    goes to review.
 *  - Pass 5 (proximity + org/name): auto only with organization support.
 *    A fuzzy match without parcel/organization support goes to review.
 */
export const PROXIMITY_METERS = 75;
export const NAME_COMPAT_THRESHOLD = 0.5;
export const AUTO_SCORES = {
  address_name: 0.85,
  proximity_org: 0.8,
} as const;

export interface FuzzyCandidate {
  projectId: string;
  canonicalName: string;
  distanceMeters: number | null;
  orgBases: string[];
}

export interface FuzzyOutcome {
  kind: "auto" | "review" | "none";
  rule: "address_name" | "proximity_org";
  projectId: string;
  score: number;
  reasons: string[];
}

/** Title with the leading external-id prefix stripped ("X-1 – Name" → "Name"). */
export function bareTitle(title: string): string {
  // Adapters join id and name with a spaced en/em dash; plain hyphens can
  // occur inside the id itself (SUP25-0002), so only split on " – ".
  return title.replace(/^.{1,40}?\s[–—]\s/, "").trim() || title;
}

/** Projects at the same normalized address in the same county. */
export async function addressCandidates(
  db: Db,
  record: NormalizedSourceRecord,
  features: MatchFeatures,
): Promise<FuzzyCandidate[]> {
  if (!features.address?.line) return [];
  const rows = await db.execute(sql`
    SELECT p.id, p.canonical_name
    FROM projects p
    WHERE p.county = ${record.county}
      AND p.address_normalized = ${features.address.line}
    LIMIT 5`);
  return (rows.rows as { id: string; canonical_name: string }[]).map((r) => ({
    projectId: r.id,
    canonicalName: r.canonical_name,
    distanceMeters: null,
    orgBases: [],
  }));
}

/** Projects with geometry within PROXIMITY_METERS in the same county. */
export async function proximityCandidates(
  db: Db,
  record: NormalizedSourceRecord,
  features: MatchFeatures,
): Promise<FuzzyCandidate[]> {
  if (!features.point) return [];
  const [lng, lat] = features.point;
  const rows = await db.execute(sql`
    SELECT p.id, p.canonical_name,
      ST_DistanceSphere(p.geometry, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)) AS dist,
      COALESCE((
        SELECT array_agg(o.canonical_name)
        FROM project_roles pr JOIN organizations o ON o.id = pr.organization_id
        WHERE pr.project_id = p.id
      ), '{}') AS org_names
    FROM projects p
    WHERE p.county = ${record.county}
      AND p.geometry IS NOT NULL
      AND ST_DistanceSphere(p.geometry, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)) <= ${PROXIMITY_METERS}
    ORDER BY dist ASC
    LIMIT 5`);
  return (rows.rows as { id: string; canonical_name: string; dist: number; org_names: string[] }[]).map(
    (r) => ({
      projectId: r.id,
      canonicalName: r.canonical_name,
      distanceMeters: r.dist,
      orgBases: r.org_names ?? [],
    }),
  );
}

/** SQL expression building a PostGIS point from GeoJSON, or NULL. */
export function geometrySql(record: NormalizedSourceRecord): SQL {
  if (record.geometry) {
    return sql`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(record.geometry)}), 4326)`;
  }
  return sql`NULL`;
}

/**
 * Evaluate fuzzy passes for a record against candidates. Returns the winning
 * auto-merge, a review request, or none. Conflicting candidates (more than
 * one plausible project) always review.
 */
export async function evaluateFuzzy(
  db: Db,
  record: NormalizedSourceRecord,
  features: MatchFeatures,
): Promise<FuzzyOutcome | null> {
  const title = bareTitle(record.title);

  // Pass 4 — normalized address + compatible project name.
  const byAddress = await addressCandidates(db, record, features);
  if (byAddress.length > 1) {
    return {
      kind: "review",
      rule: "address_name",
      projectId: byAddress[0]!.projectId,
      score: 0.5,
      reasons: ["multiple_address_candidates"],
    };
  }
  if (byAddress.length === 1) {
    const c = byAddress[0]!;
    const similarity = nameSimilarity(bareTitle(c.canonicalName), title);
    if (!features.generic && similarity >= NAME_COMPAT_THRESHOLD) {
      return {
        kind: "auto",
        rule: "address_name",
        projectId: c.projectId,
        score: AUTO_SCORES.address_name,
        reasons: [],
      };
    }
    // Same address, incompatible or generic name → separate-TI risk (spec §10).
    return {
      kind: "review",
      rule: "address_name",
      projectId: c.projectId,
      score: 0.55,
      reasons: features.generic ? ["generic_name", "same_address"] : ["same_address_name_mismatch"],
    };
  }

  // Pass 5 — geospatial proximity + organization/name support.
  const nearby = await proximityCandidates(db, record, features);
  if (nearby.length === 0) return null;
  const recordOrgBases = new Set(features.orgBases);
  for (const c of nearby) {
    const orgOverlap = c.orgBases.some((o) =>
      recordOrgBases.has(o) || [...recordOrgBases].some((r) => r && o.includes(r)),
    );
    if (orgOverlap && !features.generic) {
      return {
        kind: "auto",
        rule: "proximity_org",
        projectId: c.projectId,
        score: AUTO_SCORES.proximity_org,
        reasons: [],
      };
    }
  }
  // Proximity with name-only or no support → review, never auto (spec §10).
  const best = nearby[0]!;
  const similarity = nameSimilarity(bareTitle(best.canonicalName), title);
  if (similarity >= NAME_COMPAT_THRESHOLD || features.generic) {
    return {
      kind: "review",
      rule: "proximity_org",
      projectId: best.projectId,
      score: 0.6,
      reasons:
        similarity >= NAME_COMPAT_THRESHOLD
          ? ["fuzzy_without_parcel_or_org_support"]
          : ["generic_name", "proximity_only"],
    };
  }
  return null;
}
