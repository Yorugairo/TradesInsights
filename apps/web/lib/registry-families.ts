import "./env.js";
import { buildFamilies, loadPersonCandidates, type FamilyGroup } from "@otn/intelligence";
import {
  buildPrincipalPersonIndex,
  fetchRegistryIdentityRows,
  matchPrincipalsToPeople,
  type PrincipalPersonPair,
  type RegistryIdentityRow,
} from "@otn/resolution";
import { db } from "./db.js";
import { registryPool } from "./registry-db.js";

/**
 * The corporate-family derivation, cached per process with stale-while-revalidate.
 *
 * WHY. Measured against production on 2026-07-27, per page load:
 *
 *   fetchRegistryIdentityRows   5.2s warm / 29-79s cold   72,952 rows
 *   loadPersonCandidates        6.4s                       2,779 rows
 *   buildFamilies               0.3s   (pure JS)
 *   matchPrincipalsToPeople     0.007s (pure JS)
 *
 * The derivation itself is half a second. The cost is shipping the entire
 * registry identity view across the seam on every request, to render three
 * integers on the cockpit and fifty rows on the families page. That made the
 * cockpit a 9-21s page and `/app/admin/corporate-families` a **109-second**
 * page, and it is what tipped the cockpit past `statement_timeout` into a 500.
 *
 * No query tweak fixes that — 73k rows over a WAN is the floor. So the result is
 * derived on a schedule instead of per request.
 *
 * TWO RULES THIS MODULE EXISTS TO KEEP.
 *
 * 1. **`derivedAt` travels with the data and the UI renders it.** A cached count
 *    presented as live is the never-fabricate rule with extra steps. Callers get
 *    the stamp and are expected to show it.
 * 2. **A failed refresh never replaces good data with a zero.** If the seam is
 *    slow or down mid-refresh, the previous snapshot stands and its `derivedAt`
 *    goes stale — a stale honest number beats a fresh fake one. `stale` says so.
 */

/** How long a snapshot is served without triggering a background refresh. */
const TTL_MS = 15 * 60 * 1000;
/** Past this the UI should say so out loud rather than quietly showing old counts. */
export const STALE_WARN_MS = 60 * 60 * 1000;

export interface FamilySnapshot {
  families: FamilyGroup[];
  dropped: { principalKey: string; entityCount: number }[];
  pairs: PrincipalPersonPair[];
  /**
   * Identity rows for the entities actually referenced by `families` and
   * `pairs` — roughly 3k of the 73k fetched. The pages only ever look up
   * entities they display, so retaining the full view would cost ~20x the
   * memory for rows nothing reads.
   */
  rows: RegistryIdentityRow[];
  derivedAt: string;
  /** True when the snapshot is older than STALE_WARN_MS. */
  stale: boolean;
}

type CacheEntry = { snapshot: FamilySnapshot; refreshing: boolean };
const globalStore = globalThis as unknown as { __otnFamilySnapshot?: CacheEntry };

async function derive(): Promise<FamilySnapshot | null> {
  const pool = registryPool();
  if (!pool) return null;

  const allRows = await fetchRegistryIdentityRows(pool);
  const { families, dropped } = buildFamilies(allRows);
  const candidates = await loadPersonCandidates(db());
  const pairs = matchPrincipalsToPeople(candidates, buildPrincipalPersonIndex(allRows));

  // Keep only the identity rows the pages can actually display.
  const referenced = new Set<string>();
  for (const f of families) for (const e of f.entityIds) referenced.add(e);
  for (const p of pairs) referenced.add(p.entity.entityId);
  const rows = allRows.filter((r) => referenced.has(r.entityId));

  return {
    families,
    dropped,
    pairs,
    rows,
    derivedAt: new Date().toISOString(),
    stale: false,
  };
}

function withStaleness(snapshot: FamilySnapshot, now: number): FamilySnapshot {
  const age = now - Date.parse(snapshot.derivedAt);
  return { ...snapshot, stale: age > STALE_WARN_MS };
}

/**
 * The current snapshot. `null` means the registry seam is offline — the same
 * null every caller already branches on, never an empty snapshot.
 *
 * Cold (nothing cached): awaits the derivation. Warm and fresh: instant.
 * Warm and past TTL: returns the existing snapshot IMMEDIATELY and refreshes in
 * the background, so no single unlucky request pays the 30-second bill.
 */
export async function familySnapshot(): Promise<FamilySnapshot | null> {
  const now = Date.now();
  const entry = globalStore.__otnFamilySnapshot;

  if (!entry) {
    const fresh = await derive();
    if (!fresh) return null;
    globalStore.__otnFamilySnapshot = { snapshot: fresh, refreshing: false };
    return fresh;
  }

  const age = now - Date.parse(entry.snapshot.derivedAt);
  if (age > TTL_MS && !entry.refreshing) {
    entry.refreshing = true;
    // Deliberately not awaited. A rejected refresh leaves the previous snapshot
    // in place; it must never clear the cache or write a zeroed one.
    void derive()
      .then((fresh) => {
        if (fresh) entry.snapshot = fresh;
      })
      .catch(() => {
        /* keep the old snapshot; its derivedAt going stale IS the signal */
      })
      .finally(() => {
        entry.refreshing = false;
      });
  }

  return withStaleness(entry.snapshot, now);
}

/** Just the three integers the cockpit renders, plus the stamp. */
export function familyCounts(s: FamilySnapshot): {
  count: number;
  pairsNew: number;
  pairsStrong: number;
  derivedAt: string;
  stale: boolean;
} {
  const newPairs = s.pairs.filter((p) => !p.alreadyBound);
  const strong = newPairs.filter((p) => p.verdict === "strong" || p.verdict === "corroborated");
  return {
    count: s.families.length,
    pairsNew: newPairs.length,
    pairsStrong: strong.length,
    derivedAt: s.derivedAt,
    stale: s.stale,
  };
}
