/**
 * Thin re-export. The definitions moved into `@otn/db` (`packages/db/src/test-urls.ts`)
 * so every harness can reach them through the package it already depends on —
 * the e2e suite wrote to production for months because this guard lived
 * somewhere only vitest imported from.
 *
 * A relative path rather than the package specifier: `vitest.config.ts` loads
 * this file before workspace aliases resolve.
 */
export { LOCAL_TEST_DB, e2eDatabaseUrl, testDatabaseUrl } from "./packages/db/src/test-urls.js";

/**
 * Same guard, for OBJECT STORAGE — and it became load-bearing the moment raw
 * artifacts moved to Supabase Storage (2026-07-27).
 *
 * vitest.config.ts used to read `process.env.OBJECT_STORAGE_ENDPOINT ?? localhost`,
 * which INHERITS. Repointing .env at Supabase would therefore have silently sent
 * object-store.test.ts — which writes and overwrites objects — into the
 * production artifact bucket holding the only copy of 328 source bodies.
 *
 * Returns the local MinIO endpoint unless the configured one is already local,
 * or ALLOW_REMOTE_TEST_DB=1 is set (one switch for both stores: they are the
 * same decision — "let tests touch production").
 */
export function testObjectStorageEndpoint(): string {
  const configured = process.env.OBJECT_STORAGE_ENDPOINT;
  const LOCAL = "http://localhost:9000";
  if (!configured) return LOCAL;
  const isLocal = /localhost|127\.0\.0\.1/.test(configured);
  if (isLocal || process.env.ALLOW_REMOTE_TEST_DB === "1") return configured;
  console.warn(
    "[vitest] OBJECT_STORAGE_ENDPOINT is non-local — tests use the LOCAL MinIO instead " +
      "(set ALLOW_REMOTE_TEST_DB=1 to override; tests write objects and must not touch production).",
  );
  return LOCAL;
}

/** True when the resolved object-storage endpoint is the local MinIO. */
export function usingLocalObjectStorage(): boolean {
  return /localhost|127\.0\.0\.1/.test(testObjectStorageEndpoint());
}
