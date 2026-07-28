import { defineConfig } from "@playwright/test";
import { e2eDatabaseUrl } from "@otn/db";

/**
 * The suite runs against `otn_e2e` — a local database of its own, seeded by
 * `pnpm db:seed:e2e`. Never the hosted one, and deliberately not vitest's `otn`
 * either: the corpus inserts rows vitest tests would otherwise read
 * (`assistant.test.ts` asserts a filter returns exactly one row and saw two).
 * `e2e/global-setup.ts` enforces both and explains what it cost before it did.
 *
 * Importing the ROOT `testDatabaseUrl()` rather than restating the rule is the
 * point: vitest already had this guard, playwright simply never called it, and
 * two copies of "which database may tests touch" is how that happens again.
 */
const E2E_DATABASE_URL = e2eDatabaseUrl();

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  globalSetup: "./e2e/global-setup.ts",
  /**
   * Two workers, not one, and not the CPU-count default.
   *
   * `workers: 1` was a compensating control for contention against the hosted
   * database's 2-connection pool — a login POST that did not return inside a 5s
   * assertion, with no relationship to the code under test. The local corpus
   * removes that, so the control goes with it.
   *
   * Still capped at 2 rather than defaulted: these tests share one database and
   * a few mutate account-scoped state, so unbounded concurrency would trade a
   * measured cost for an unmeasured one.
   */
  workers: 2,
  use: {
    baseURL: "http://localhost:3100",
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } }
      : {}),
  },
  /**
   * Runs a PRODUCTION build, not `next dev`. (Changed 2026-07-27.)
   *
   * Under `next dev` every route compiles on first request, so the suite was a
   * just-in-time compile racing a 60s per-test budget. Measured: one run failed
   * 9 of 21, an identical re-run minutes later passed 21/21 with no code change.
   * A gate that can report nine failures for environmental reasons cannot tell a
   * dropped `data-testid` from a bad afternoon.
   *
   * The build costs ~60-90s once per run and buys a deterministic gate. It also
   * tests what actually ships: `next build` is the only mode that exercises
   * server/client boundary errors, and dev's forgiving module graph can hide a
   * `"use client"` leak that breaks production.
   */
  webServer: {
    command: "pnpm build && pnpm start --port 3100",
    url: "http://localhost:3100",
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    /**
     * SPREAD `process.env` FIRST. Playwright REPLACES the child environment with
     * this object rather than merging into it, so omitting the spread strips
     * AUTH_SECRET and every login in the suite fails with a 401 that reads like
     * an auth regression.
     *
     * `DATABASE_URL` is set last so the repo `.env` — which points at the hosted
     * database — cannot win.
     */
    env: {
      ...(process.env as Record<string, string>),
      DATABASE_URL: E2E_DATABASE_URL,
      /**
       * The registry seam stays unset on purpose. The cockpit then renders its
       * "seam offline" state, which is a real state worth exercising, and no
       * assertion needs registry data.
       */
      REGISTRY_DATABASE_URL: "",
      /**
       * A throwaway handoff secret, set so the SSO refusal paths are exercised
       * for real: with no secret the route short-circuits on "not configured"
       * and the signature check — the single most important negative case in
       * the handoff — would never run. It signs nothing here; no test mints a
       * valid token, and the production secret lives only in the deployment.
       */
      INSIGHTS_SSO_SECRET: "e2e-not-a-real-secret",
    },
  },
});
