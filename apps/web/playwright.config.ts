import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  /**
   * One worker. Not a performance oversight — a compensating control.
   *
   * The suite runs against the hosted production database, whose connection
   * pool max is 2. Two Playwright workers plus the app's own queries contend
   * for those two connections, and the symptom is a login POST that does not
   * come back inside a 5s `toHaveURL` — a failure with no relationship to the
   * code under test. Serial execution removes the contention we control.
   *
   * Remove this once e2e runs against a seeded local database. Until then,
   * concurrency here buys ~40s of wall clock and costs the gate its meaning.
   */
  workers: 1,
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
   * just-in-time compile racing a 60s per-test budget and a remote database
   * pool. Measured: one run failed 9 of 21, an identical re-run minutes later
   * passed 21/21 with no code change. A gate that can report nine failures for
   * environmental reasons cannot tell a dropped `data-testid` from a bad
   * afternoon — and the cockpit retrofit's entire safety argument is "e2e green
   * after each page".
   *
   * The build costs ~60-90s once per run and buys a deterministic gate. It also
   * tests what actually ships: `next build` is the only mode that exercises
   * server/client boundary errors, and dev's forgiving module graph can hide
   * a `"use client"` leak that breaks production.
   *
   * STILL OUTSTANDING: the repo `.env` points DATABASE_URL at the hosted
   * production database. That is the other half of the fragility (pool max 2)
   * and is unfixed here — it needs a seeded local corpus, which is a data task,
   * not a config one.
   */
  webServer: {
    command: "pnpm build && pnpm start --port 3100",
    url: "http://localhost:3100",
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  },
});
