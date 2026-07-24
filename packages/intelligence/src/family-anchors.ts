import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";

/**
 * Map registry entity id → an Insights organization bound to it (`registry_ref`),
 * for the corporate-family accept action's PROVENANCE anchor.
 *
 * A relationship observation's `organization_id` is NOT NULL but is only "who
 * confirmed it"; when neither company in a pair has a bound Insights org the
 * accept button is disabled (there is no org to anchor on). One org per entity is
 * enough — several Insights orgs can share a `registry_ref`; any is a valid
 * anchor, so `DISTINCT ON` takes the first by id.
 *
 * Entity ids are pushed down as a VALUES list (the corporate-family convention),
 * not `ANY(array)`, so registry_ref's uuid↔text comparison behaves as it does in
 * `corporateFamilyRollup`'s `fam` CTE.
 */
export async function loadBoundOrgIdsByEntity(db: Db, entityIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (entityIds.length === 0) return map;
  const values = entityIds.map((e) => sql`(${e})`);
  const res = await db.execute(sql`
    SELECT DISTINCT ON (o.registry_ref) o.registry_ref, o.id
    FROM organizations o
    JOIN (VALUES ${sql.join(values, sql`, `)}) AS want(entity_id) ON want.entity_id = o.registry_ref
    ORDER BY o.registry_ref, o.id`);
  for (const r of res.rows as Record<string, unknown>[]) {
    const ref = r["registry_ref"];
    const id = r["id"];
    if (typeof ref === "string" && typeof id === "string") map.set(ref, id);
  }
  return map;
}
