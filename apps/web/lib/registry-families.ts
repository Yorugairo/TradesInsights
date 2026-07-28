import "./env.js";
import {
  buildFamilies,
  loadPersonCandidates,
  readCorporateFamilySnapshot,
  readCorporateFamilyStamp,
  type FamilyGroup,
} from "@otn/intelligence";
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
 * The corporate-family snapshot: MATERIALISED first, derived on demand only as
 * a fallback.
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
 * The nightly maintenance chain now derives once and persists the snapshot
 * (`corporate_family_summary` + pairs, migration 0037). This module reads that
 * table first — a cheap same-database read, fast even on the first request
 * after a deploy. The per-process stale-while-revalidate derivation below
 * remains as the FALLBACK for a table that has never been written (fresh
 * database, pre-first-run) or has gone dead (two missed nightly runs).
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

/** How long a fallback-derived snapshot is served without a background refresh. */
const TTL_MS = 15 * 60 * 1000;
/** Past this the UI should say so out loud rather than quietly showing old counts. */
export const STALE_WARN_MS = 60 * 60 * 1000;
/** Nightly cadence: a persisted snapshot older than one missed run is flagged. */
const TABLE_STALE_WARN_MS = 26 * 60 * 60 * 1000;
/** Two missed nightly runs ⇒ the table is dead; fall back to deriving on demand. */
const TABLE_FALLBACK_MS = 48 * 60 * 60 * 1000;

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
 * The nightly-materialised snapshot, if it is present and alive.
 *
 * Steady state costs ONE tiny same-database query per request (the stamp): the
 * blobs are re-read only when `derived_at` moves. Anything unreadable — table
 * missing on a pre-0037 database, blob shape drift — falls through to the
 * on-demand path rather than taking the page down.
 */
async function persistedSnapshot(now: number): Promise<FamilySnapshot | null> {
  try {
    const stamp = await readCorporateFamilyStamp(db());
    if (!stamp) return null;
    const age = now - Date.parse(stamp);
    if (age > TABLE_FALLBACK_MS) return null;
    const stale = age > TABLE_STALE_WARN_MS;

    const entry = globalStore.__otnFamilySnapshot;
    if (entry && entry.snapshot.derivedAt === stamp) {
      return { ...entry.snapshot, stale };
    }
    const snap = await readCorporateFamilySnapshot(db());
    if (!snap) return null;
    const full: FamilySnapshot = { ...snap, stale };
    globalStore.__otnFamilySnapshot = { snapshot: full, refreshing: false };
    return full;
  } catch {
    // A broken fast path must degrade to the slow one, never to a 500.
    return null;
  }
}

/**
 * The current snapshot. `null` means the registry seam is offline — the same
 * null every caller already branches on, never an empty snapshot.
 *
 * Table first (nightly materialisation, cheap read). Fallback: the on-demand
 * derivation — cold (nothing cached) awaits it; warm and fresh is instant;
 * warm and past TTL returns the existing snapshot IMMEDIATELY and refreshes in
 * the background, so no single unlucky request pays the 30-second bill.
 */
export async function familySnapshot(): Promise<FamilySnapshot | null> {
  const now = Date.now();

  const persisted = await persistedSnapshot(now);
  if (persisted) return persisted;

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
