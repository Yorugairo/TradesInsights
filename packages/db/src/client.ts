import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;

/**
 * Search-path connection contract (Part E co-location): Insights tables live in
 * the `insights` schema; queries stay unqualified because DATABASE_URL embeds
 * `?options=-csearch_path%3Dinsights%2Cpublic%2Cextensions` (insights first,
 * then public, then Supabase's `extensions` for PostGIS). The contract rides
 * the URL — NOT this pool — so every consumer (web pool, worker pool, pg-boss,
 * drizzle migrator, vitest) inherits it from one place. A URL missing the
 * options makes unqualified lookups miss and tests fail loudly; see
 * docs/runbooks/registry-seam-golive.md Part C.
 */
/**
 * Keep-alive contract for the Supavisor pooler.
 *
 * Supabase's pooler reaps connections that have sat idle, and node's pool will
 * happily hand that dead socket to the next caller — which then dies with
 * "Connection terminated unexpectedly" or ETIMEDOUT. On 2026-07-27 that took out
 * three unrelated subsystems in one day: a full rescore stopped at row ~31 of
 * ~1,260 and left production on a MIX of algorithm versions; a source run parsed
 * its record cleanly but failed writing `source_runs`, so the ledger recorded a
 * failure that never happened; and six of seven scraper workers died at once.
 *
 * `idleTimeoutMillis` BELOW the pooler's own reaper is the fix: node closes idle
 * connections first and opens a fresh one on demand, so a reaped socket is never
 * handed back. `keepAlive` holds the TCP session up across shorter gaps.
 * `connectionTimeoutMillis` bounds acquisition so a network fault surfaces as a
 * prompt error rather than an indefinite hang.
 *
 * These values were proven in the Google Place batch driver before they lived
 * here; that they sat in one standalone script, where nothing could inherit them,
 * is the reason the same bug was rediscovered three times.
 */
const POOL_KEEPALIVE = {
  idleTimeoutMillis: 10_000,
  keepAlive: true,
  connectionTimeoutMillis: 30_000,
} as const;

export function createPool(databaseUrl = process.env.DATABASE_URL): pg.Pool {
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  // `max` stays 10: the connections die while IDLE, not from contention, so
  // raising or lowering the ceiling does not address this.
  return new pg.Pool({ connectionString: databaseUrl, max: 10, ...POOL_KEEPALIVE });
}

/**
 * Read-only pool for the One Trade Network registry's contract surface
 * (registry_public.*), from REGISTRY_DATABASE_URL. Returns null when unset so
 * the app boots and the pipeline runs without a registry connection — the
 * registry-link step then reports a visible "skipped" state (mirrors the
 * model-key rule: no key ⇒ blocked/skipped, never a crash). Small pool: the
 * link job is a low-frequency batch read.
 */
export function createRegistryPool(
  registryDatabaseUrl = process.env.REGISTRY_DATABASE_URL,
): pg.Pool | null {
  if (!registryDatabaseUrl) return null;
  // Same keep-alive contract: a low-frequency batch read is MORE exposed to an
  // idle reap, not less, because the gaps between its queries are longer.
  return new pg.Pool({ connectionString: registryDatabaseUrl, max: 4, ...POOL_KEEPALIVE });
}

export function createDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema });
}
