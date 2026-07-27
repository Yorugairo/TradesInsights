import { config as loadEnv } from "dotenv";

loadEnv();

/**
 * The database tests actually run against — ONE definition, shared by
 * vitest.config.ts (which injects it as `test.env.DATABASE_URL`) and
 * vitest.global-setup.ts (which pre-flights it).
 *
 * They must agree. The first version of the pre-flight read
 * `process.env.DATABASE_URL` directly and so checked the HOSTED database, which
 * is always reachable — it reported "healthy" while the local container was
 * stopped and every DB-backed test was about to fail.
 *
 * PRODUCTION-SAFETY GUARD (Part E co-location): after cutover the repo .env
 * points DATABASE_URL at the hosted Supabase DB, but tests truncate/reset data
 * (resetSource, deleteTestProjects) and insert fixture projects/orgs into shared
 * tables. A non-local DATABASE_URL is therefore IGNORED — tests fall back to the
 * local Docker default — unless ALLOW_REMOTE_TEST_DB=1 is set explicitly.
 * PG_PORT (compose override) keeps the fallback correct on machines where a
 * native Postgres shadows 5432.
 */
export const LOCAL_TEST_DB = `postgres://otn:otn@localhost:${process.env.PG_PORT || "5432"}/otn?options=-csearch_path%3Dinsights%2Cpublic%2Cextensions`;

export function testDatabaseUrl(): string {
  const configured = process.env.DATABASE_URL;
  if (!configured) return LOCAL_TEST_DB;
  const isLocal = /localhost|127\.0\.0\.1/.test(configured);
  if (isLocal || process.env.ALLOW_REMOTE_TEST_DB === "1") return configured;
  console.warn(
    "[vitest] DATABASE_URL is non-local — tests run against the LOCAL Docker DB instead " +
      "(set ALLOW_REMOTE_TEST_DB=1 to override; tests truncate data and must not touch production).",
  );
  return LOCAL_TEST_DB;
}
