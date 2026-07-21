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
export function createPool(databaseUrl = process.env.DATABASE_URL): pg.Pool {
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
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
  return new pg.Pool({ connectionString: registryDatabaseUrl, max: 4 });
}

export function createDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema });
}
