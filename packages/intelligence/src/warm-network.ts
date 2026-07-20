import type { Db } from "@otn/db";
import { orgActivityRollup } from "./org-activity.js";

/** The account's territory as counties (mirrors AccountScoringInput.territory). */
export interface TerritoryCounties {
  counties_included?: string[];
  counties_excluded?: string[];
}

/** A county set intersects the territory (excluded wins over included). */
function inTerritory(counties: string[], t: TerritoryCounties): boolean {
  const excluded = new Set(t.counties_excluded ?? []);
  const present = counties.filter((c) => c && !excluded.has(c));
  const included = t.counties_included ?? [];
  if (included.length === 0) return present.length > 0; // no include list ⇒ anywhere not excluded
  const includedSet = new Set(included);
  return present.some((c) => includedSet.has(c));
}

/**
 * WS-W — the set of registry entity refs for ACTIVE, registry-BOUND general
 * contractors running relevant work in the account's territory. This is the
 * account's WARM network: GCs it could win work through, each verified by a
 * governed registry binding (registry_ref, never an auto-bind), surfaced today
 * only in the digest league table (org-activity). Returning the set lets the
 * scorer flag a project whose GC/owner is a warm, verified relationship.
 *
 * Reuses the deterministic `orgActivityRollup`; keeps only bound, real-company
 * orgs (placeholder / likely-individual flags dropped) that are running work the
 * router judged relevant to this account and sit in territory.
 *
 * Empty until orgs are registry-bound (needs the live registry connection / the
 * go-live runbook) — harmless: an empty warm set contributes no signal.
 */
export async function warmGcEntityIds(
  db: Db,
  accountProfileId: string,
  territory: TerritoryCounties,
): Promise<Set<string>> {
  const rows = await orgActivityRollup(db, { accountProfileId, minProjects: 2, limit: 500 });
  const set = new Set<string>();
  for (const r of rows) {
    if (!r.registryRef) continue; // bound entities only
    if (r.flags.includes("placeholder") || r.flags.includes("likely_individual")) continue;
    if (r.relevantProjects < 1) continue; // running relevant work
    if (!inTerritory(r.counties, territory)) continue;
    set.add(r.registryRef);
  }
  return set;
}
