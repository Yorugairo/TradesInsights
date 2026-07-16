import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";
import { developmentName, distanceMeters } from "./normalize.js";

/**
 * M2.4 — development/phase hierarchy (spec §10 pass 6). Projects sharing a
 * non-generic base name (phase/lot/division tokens stripped) in the same
 * county group into one development when the relationship is supported by
 * documents (the names come from official records), parcels, organizations,
 * or subdivision-scale proximity. Unsupported same-name groups are left
 * alone — never guessed.
 */
export const DEVELOPMENT_PROXIMITY_METERS = 1000;

interface ProjectLite {
  id: string;
  canonicalName: string;
  county: string;
  parcels: string[];
  point: [number, number] | null;
  orgIds: string[];
  firstSeenAt: Date;
  lastSeenAt: Date;
  developmentId: string | null;
}

export interface BuildDevelopmentsSummary {
  groupsConsidered: number;
  developmentsFormed: number;
  projectsLinked: number;
  parentsSet: number;
}

function haveSupport(members: ProjectLite[]): boolean {
  // Organization overlap.
  const orgCounts = new Map<string, number>();
  for (const m of members) {
    for (const o of new Set(m.orgIds)) orgCounts.set(o, (orgCounts.get(o) ?? 0) + 1);
  }
  if ([...orgCounts.values()].some((c) => c >= 2)) return true;
  // Parcel overlap.
  const parcelCounts = new Map<string, number>();
  for (const m of members) {
    for (const p of new Set(m.parcels)) parcelCounts.set(p, (parcelCounts.get(p) ?? 0) + 1);
  }
  if ([...parcelCounts.values()].some((c) => c >= 2)) return true;
  // Subdivision-scale proximity between any pair.
  const points = members.map((m) => m.point).filter((p): p is [number, number] => p !== null);
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      if (distanceMeters(points[i]!, points[j]!) <= DEVELOPMENT_PROXIMITY_METERS) return true;
    }
  }
  return false;
}

export async function buildDevelopments(
  db: Db,
  opts: { logger?: { info(o: unknown, m?: string): void } } = {},
): Promise<BuildDevelopmentsSummary> {
  const res = await db.execute(sql`
    SELECT p.id, p.canonical_name, p.county, p.parcel_ids, p.development_id,
      p.first_seen_at, p.last_seen_at,
      CASE WHEN p.geometry IS NOT NULL
        THEN ARRAY[ST_X(ST_Centroid(p.geometry)), ST_Y(ST_Centroid(p.geometry))] END AS pt,
      COALESCE((SELECT array_agg(DISTINCT pr.organization_id::text)
                FROM project_roles pr WHERE pr.project_id = p.id), '{}') AS org_ids
    FROM projects p`);

  const all: ProjectLite[] = (res.rows as never[]).map((r: Record<string, unknown>) => ({
    id: r["id"] as string,
    canonicalName: r["canonical_name"] as string,
    county: r["county"] as string,
    parcels: (r["parcel_ids"] as string[]) ?? [],
    point: (r["pt"] as [number, number] | null) ?? null,
    orgIds: (r["org_ids"] as string[]) ?? [],
    firstSeenAt: new Date(r["first_seen_at"] as string),
    lastSeenAt: new Date(r["last_seen_at"] as string),
    developmentId: (r["development_id"] as string | null) ?? null,
  }));

  // Group by (county, development base name).
  const groups = new Map<string, ProjectLite[]>();
  for (const p of all) {
    const dev = developmentName(p.canonicalName);
    if (!dev) continue;
    const key = `${p.county}::${dev.base}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }

  const summary: BuildDevelopmentsSummary = {
    groupsConsidered: 0,
    developmentsFormed: 0,
    projectsLinked: 0,
    parentsSet: 0,
  };

  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    summary.groupsConsidered++;
    if (!haveSupport(members)) continue;

    const [county = "", base = ""] = key.split("::");
    const existingDevId = members.find((m) => m.developmentId)?.developmentId ?? null;
    let devId = existingDevId;
    if (!devId) {
      const first = new Date(Math.min(...members.map((m) => m.firstSeenAt.getTime())));
      const last = new Date(Math.max(...members.map((m) => m.lastSeenAt.getTime())));
      const inserted = await db.execute(sql`
        INSERT INTO developments (canonical_name, development_type, county, first_seen_at, last_seen_at)
        VALUES (${base}, 'grouped', ${county}, ${first.toISOString()}, ${last.toISOString()})
        RETURNING id`);
      devId = (inserted.rows[0] as { id: string }).id;
      summary.developmentsFormed++;
    }

    const toLink = members.filter((m) => !m.developmentId);
    if (toLink.length > 0) {
      await db.execute(sql`
        UPDATE projects SET development_id = ${devId}
        WHERE id IN (${sql.join(toLink.map((m) => sql`${m.id}`), sql`, `)})`);
      summary.projectsLinked += toLink.length;
    }

    // Phase parents: exactly one base member (no phase label, or the plat
    // record) parents the labeled members. Ambiguity leaves parents unset.
    const withMeta = members.map((m) => ({
      m,
      dev: developmentName(m.canonicalName),
    }));
    const baseMembers = withMeta.filter((x) => x.dev && (x.dev.isPlat || x.dev.phaseLabel === null));
    const phased = withMeta.filter((x) => x.dev && x.dev.phaseLabel !== null && !x.dev.isPlat);
    if (baseMembers.length === 1 && phased.length > 0) {
      const parentId = baseMembers[0]!.m.id;
      const childIds = phased.filter((x) => x.m.id !== parentId).map((x) => x.m.id);
      if (childIds.length > 0) {
        await db.execute(sql`
          UPDATE projects SET parent_project_id = ${parentId}
          WHERE id IN (${sql.join(childIds.map((id) => sql`${id}`), sql`, `)})
            AND parent_project_id IS NULL`);
        summary.parentsSet += childIds.length;
      }
    }
  }

  opts.logger?.info(summary, "development grouping complete");
  return summary;
}
