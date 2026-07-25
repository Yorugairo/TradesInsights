/**
 * Contested Google Place links, read across the seam and grouped for review.
 *
 * WHY: the re-score stages contested confirmations deliberately rather than
 * dropping them — a place several businesses all confirm is information the
 * registry needs in order to resolve the conflict, and a silent drop would leave
 * it looking unexamined forever. But staging them was only half the job: they
 * landed as `relationship_pending` / `not_public_pending_review` and appeared in
 * NO view and NO UI. `google_place_review_v1` returns zero of them. This module
 * is the read side that makes them resolvable.
 *
 * THE REVIEWER DECIDES PER PLACE, NOT PER LINK. One row per claimant is the
 * right storage shape and the wrong review shape: the question is "which of
 * these businesses owns this listing", asked once per listing. `groupByPlace`
 * does that collapse, and it is pure so the grouping is testable without a
 * database.
 *
 * A ROW COUNT IS NOT A WORKLOAD. `rivalCount === 0` means no competing entity
 * claimed the listing, so the row is not a conflict at all. Live on 2026-07-25
 * that was 139 of 143 rows — fallout from a scorer defect that keyed the
 * contested test by LICENCE rather than by ENTITY, which made one company
 * holding two L&I licences look like two rival claimants on its own listing.
 * `google-place-scrape.ts` is fixed (re-scoring now yields 3 contested places,
 * not ~141) but the fix does not heal rows already written, so
 * `realConflicts()` exists to keep the true conflicts separable. Reporting 143
 * as "conflicts to review" would be wrong by roughly 70x.
 *
 * NOTHING HERE DECIDES ANYTHING. Read-only. Resolution stays on the registry's
 * governed link table, which carries `decision_locked`, supersession and a
 * phone-write policy that must not be reimplemented behind the seam.
 *
 * SKIP-SAFE: a missing view (42P01) degrades to an empty result, because the
 * Insights deploy and the registry migration are not atomic. EVERY other error
 * rethrows — a permission failure must never masquerade as "no conflicts",
 * which is the exact shape of a silent seam outage.
 */
import type { RegistryPoolLike } from "./registry-link.js";

export const GOOGLE_PLACE_CONTESTED_VIEW = "registry_public.google_place_contested_v1";

/** Postgres `undefined_table` — the only error this module swallows. */
const UNDEFINED_TABLE = "42P01";

function isMissingRelation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === UNDEFINED_TABLE;
}

const str = (v: unknown): string | null => {
  const s = v == null ? "" : String(v).trim();
  return s === "" ? null : s;
};

/** One CLAIMANT on one contested listing. */
export interface ContestedPlaceRow {
  entityId: string;
  entityName: string | null;
  googlePlaceId: string;
  /** The listing itself — identical across every claimant on this place id. */
  scrapedName: string | null;
  scrapedPhone: string | null;
  profileUrl: string | null;
  /** This claimant's own L&I identity, for side-by-side comparison. */
  lniName: string | null;
  lniPhone: string | null;
  lniLicenseNumber: string | null;
  linkStatus: string | null;
  publicSurfacePolicy: string | null;
  /** The OTHER entities that also confirmed this listing. */
  competingEntityIds: string[];
  /** `competingEntityIds.length`, computed in the view. 0 => not a conflict. */
  rivalCount: number;
  /** Distinct LICENCES reaching this place id — not a conflict signal, because
   * one company can hold several. */
  sharedLicenceCount: number;
}

/**
 * Read every contested claimant.
 *
 * Returns [] when the registry migration has not landed yet. Any other failure
 * rethrows.
 */
export async function loadContestedPlaces(pool: RegistryPoolLike): Promise<ContestedPlaceRow[]> {
  try {
    const res = await pool.query(
      `SELECT entity_id, entity_name, google_place_id, scraped_name, scraped_phone,
              profile_url, lni_name, lni_phone, lni_license_number, link_status,
              public_surface_policy, competing_entity_ids, rival_count, shared_licence_count
         FROM ${GOOGLE_PLACE_CONTESTED_VIEW}`,
    );
    return (res.rows as Record<string, unknown>[]).map((r) => ({
      entityId: String(r["entity_id"]),
      entityName: str(r["entity_name"]),
      googlePlaceId: String(r["google_place_id"]),
      scrapedName: str(r["scraped_name"]),
      scrapedPhone: str(r["scraped_phone"]),
      profileUrl: str(r["profile_url"]),
      lniName: str(r["lni_name"]),
      lniPhone: str(r["lni_phone"]),
      lniLicenseNumber: str(r["lni_license_number"]),
      linkStatus: str(r["link_status"]),
      publicSurfacePolicy: str(r["public_surface_policy"]),
      competingEntityIds: Array.isArray(r["competing_entity_ids"])
        ? (r["competing_entity_ids"] as unknown[]).map(String)
        : [],
      rivalCount: Number(r["rival_count"] ?? 0),
      sharedLicenceCount: Number(r["shared_licence_count"] ?? 0),
    }));
  } catch (err) {
    if (isMissingRelation(err)) return [];
    throw err;
  }
}

/** One listing and everyone claiming it — the unit a human actually decides. */
export interface ContestedPlaceGroup {
  googlePlaceId: string;
  /** Taken from the first claimant; the listing is the same for all of them. */
  scrapedName: string | null;
  scrapedPhone: string | null;
  profileUrl: string | null;
  claimants: ContestedPlaceRow[];
  /** True when more than one DISTINCT entity claims this listing. The others are
   * legacy mislabels, not conflicts — see the module header. */
  isRealConflict: boolean;
}

/**
 * Collapse claimant rows into one group per listing.
 *
 * Pure. Groups are returned most-contested first so the genuine conflicts sort
 * to the top of any surface that renders them in order.
 */
export function groupByPlace(rows: readonly ContestedPlaceRow[]): ContestedPlaceGroup[] {
  const byPlace = new Map<string, ContestedPlaceRow[]>();
  for (const row of rows) {
    const list = byPlace.get(row.googlePlaceId);
    if (list) list.push(row);
    else byPlace.set(row.googlePlaceId, [row]);
  }
  const groups: ContestedPlaceGroup[] = [];
  for (const [googlePlaceId, claimants] of byPlace) {
    const first = claimants[0]!;
    // Judged on DISTINCT entities present, not on claimants.length and not on
    // rivalCount alone: the same entity can appear twice (one row per licence),
    // and that is not two claimants.
    const distinctEntities = new Set(claimants.map((c) => c.entityId));
    groups.push({
      googlePlaceId,
      scrapedName: first.scrapedName,
      scrapedPhone: first.scrapedPhone,
      profileUrl: first.profileUrl,
      claimants,
      isRealConflict: distinctEntities.size > 1,
    });
  }
  groups.sort((a, b) => {
    if (a.isRealConflict !== b.isRealConflict) return a.isRealConflict ? -1 : 1;
    if (b.claimants.length !== a.claimants.length) return b.claimants.length - a.claimants.length;
    return a.googlePlaceId.localeCompare(b.googlePlaceId);
  });
  return groups;
}

/** Only the listings a human genuinely has to adjudicate. */
export function realConflicts(groups: readonly ContestedPlaceGroup[]): ContestedPlaceGroup[] {
  return groups.filter((g) => g.isRealConflict);
}
