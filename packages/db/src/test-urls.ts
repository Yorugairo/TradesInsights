import { config as loadEnv } from "dotenv";

/**
 * WHICH DATABASE MAY TESTS TOUCH — one definition, owned by the db package.
 *
 * It lived at the repo root (`vitest.test-db.ts`) and vitest was its only
 * caller. That is precisely how the e2e suite ended up writing to production:
 * the guard existed, was correct, and Playwright never called it. Moving it
 * into the package every harness already depends on removes the reason to
 * re-implement it.
 *
 * It also has to live here for a duller reason: `packages/db` cannot import a
 * file above its own root without tripping `verbatimModuleSyntax` (the root
 * package is CJS-typed, the package is ESM), which typecheck caught.
 */

/**
 * Find the repo-root `.env` from WHEREVER the caller happens to run.
 *
 * A bare `loadEnv()` resolves against `process.cwd()`. That is the repo root
 * under vitest, so it worked — but Playwright runs from `apps/web`, which has
 * no `.env`, so `PG_PORT` came back undefined and the URL below fell through to
 * 5432. On a machine with a native Postgres on 5432 — exactly the case the
 * PG_PORT override exists for — that is a DIFFERENT DATABASE, and the failure
 * surfaced as `password authentication failed for user "otn"`, which reads like
 * a credentials problem rather than a wrong-port one.
 *
 * Anchoring to `import.meta.url` would be tidier and does NOT work: Playwright
 * transpiles its config graph to CJS, where `import.meta` is a syntax error.
 * Walking a short list of relative candidates is format-agnostic, and dotenv
 * never overwrites an already-set variable, so the first hit wins.
 */
for (const candidate of [".env", "../.env", "../../.env", "../../../.env"]) {
  loadEnv({ path: candidate });
}

const SEARCH_PATH = "options=-csearch_path%3Dinsights%2Cpublic%2Cextensions";

/**
 * PRODUCTION-SAFETY GUARD. The repo `.env` points DATABASE_URL at the hosted
 * database, but tests truncate data and insert fixtures into shared tables. A
 * non-local DATABASE_URL is therefore IGNORED — callers fall back to the local
 * Docker default — unless ALLOW_REMOTE_TEST_DB=1 is set explicitly. PG_PORT
 * keeps the fallback correct where a native Postgres shadows 5432.
 */
export const LOCAL_TEST_DB = `postgres://otn:otn@localhost:${process.env.PG_PORT || "5432"}/otn?${SEARCH_PATH}`;

/** The database VITEST runs against. */
export function testDatabaseUrl(): string {
  const configured = process.env.DATABASE_URL;
  if (!configured) return LOCAL_TEST_DB;
  const isLocal = /localhost|127\.0\.0\.1/.test(configured);
  if (isLocal || process.env.ALLOW_REMOTE_TEST_DB === "1") return configured;
  console.warn(
    "[test-db] DATABASE_URL is non-local — tests run against the LOCAL Docker DB instead " +
      "(set ALLOW_REMOTE_TEST_DB=1 to override; tests truncate data and must not touch production).",
  );
  return LOCAL_TEST_DB;
}

/**
 * The database the E2E SUITE runs against — `otn_e2e`, separate from vitest's
 * `otn` and from production.
 *
 * Separate from vitest is not fussiness. The e2e corpus inserts projects and
 * opportunities that vitest tests then read: seeding it into `otn` broke
 * `assistant.test.ts`, which asserts a filter returns exactly one row and got
 * two. That is the same "one suite writes what another reads" defect this work
 * exists to remove, so it gets the same answer rather than a tuned corpus.
 */
export function e2eDatabaseUrl(): string {
  return LOCAL_TEST_DB.replace(/\/otn\?/, "/otn_e2e?");
}
