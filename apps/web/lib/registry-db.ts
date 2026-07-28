import "./env.js";
import type pg from "pg";
import { createRegistryPool } from "@otn/db";

/**
 * One registry pool per process, memoised exactly like `db()` in `./db.ts`.
 *
 * WHY THIS EXISTS. `createRegistryPool()` allocates a NEW `pg.Pool` (max: 4)
 * every time it is called. Five request paths were calling it inline — four
 * admin pages and the Google Place decision route — and none of them closed it.
 * Every page load therefore leaked a four-connection pool against the registry
 * database; a fifty-view operator session leaked two hundred connections. It had
 * not caused a visible outage yet, which is the only reason it survived.
 *
 * `null` when `REGISTRY_DATABASE_URL` is unset, and that null is load-bearing:
 * the entire "seam offline, never a fake zero" contract branches on it. The
 * result is memoised in a wrapper object rather than by truthiness, so a
 * legitimate `null` is cached once instead of re-attempted on every request.
 */
const globalStore = globalThis as unknown as {
  __otnRegistryPool?: { pool: pg.Pool | null };
};

export function registryPool(): pg.Pool | null {
  if (!globalStore.__otnRegistryPool) {
    globalStore.__otnRegistryPool = { pool: createRegistryPool() };
  }
  return globalStore.__otnRegistryPool.pool;
}
