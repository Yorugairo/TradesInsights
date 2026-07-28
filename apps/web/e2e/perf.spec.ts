/**
 * Response-budget gate.
 *
 * A NEW spec file, not an edit to an existing one. It exists because the two
 * worst pages in this app were slow for months without anything failing: the
 * queue cockpit rendered in 9.6-21.8s and `/app/admin/corporate-families` in
 * **109 seconds**, and the only reason either was noticed is that the cockpit
 * eventually crossed `statement_timeout` and started returning 500s during an
 * unrelated e2e run. Nothing measured latency, so nothing objected to it.
 *
 * WHY THE CEILING IS LOOSE. These budgets run against the hosted PRODUCTION
 * database (the same finding as `playwright.config.ts`'s `workers: 1` note), so
 * absolute numbers vary with WAN latency and whatever else is querying. The
 * ceiling here is set to catch a REGRESSION IN KIND — a page going from
 * ~1s to ~30s because someone reintroduced a per-request seam pull — not to
 * police a p95. Tighten it to something meaningful once e2e runs against a
 * seeded local corpus.
 *
 * Measured 2026-07-27 after the seam fix, warm:
 *   /app/admin/sources              0.42s
 *   /app/admin/review               1.61s
 *   /app/admin/cockpit              1.44s   (was 21.8s)
 *   /app/admin/corporate-families   0.61s   (was 109s)
 */

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const PASSWORD = process.env.AUTH_SECRET ?? "";

/** Deliberately generous — see the header note. */
const BUDGET_MS = 30_000;

/**
 * The cold-start allowance for the FIRST request of the run.
 *
 * The corporate-family snapshot is derived on demand and costs 22-79s the first
 * time a process needs it. That is by design (see `lib/registry-families.ts`);
 * this test warms it once and then holds every subsequent page to `BUDGET_MS`.
 */
const WARMUP_MS = 120_000;

const ROUTES = [
  "/app/opportunities",
  "/app/pipeline",
  "/app/pursuits",
  "/app/radar",
  "/app/roi",
  "/app/admin/sources",
  "/app/admin/review",
  "/app/admin/cockpit",
  "/app/admin/corporate-families",
  "/app/admin/google-place-review",
  "/app/admin/coverage",
];

async function login(request: APIRequestContext): Promise<void> {
  const res = await request.post("/api/auth/login", {
    data: { password: PASSWORD, accountKey: "solis_interiors", role: "admin" },
  });
  expect(res.ok(), "login").toBeTruthy();
}

async function timed(page: Page, path: string): Promise<number> {
  const t0 = Date.now();
  const res = await page.goto(path);
  expect(res?.status(), `${path} status`).toBeLessThan(400);
  return Date.now() - t0;
}

test.describe("response budgets", () => {
  test("every admin and customer page responds inside its budget", async ({ page, request }) => {
    test.setTimeout(WARMUP_MS + ROUTES.length * BUDGET_MS);
    await login(request);
    await page.context().addCookies(await request.storageState().then((s) => s.cookies));

    // Warm the process: the family snapshot derives on first demand.
    await timed(page, "/app/admin/corporate-families");

    const slow: string[] = [];
    for (const path of ROUTES) {
      const ms = await timed(page, path);
      if (ms > BUDGET_MS) slow.push(`${path} ${(ms / 1000).toFixed(1)}s`);
    }

    // Report every offender at once. Failing on the first one hides the rest,
    // and "which pages regressed" is the actual question.
    expect(slow, `over ${BUDGET_MS / 1000}s budget: ${slow.join(", ")}`).toEqual([]);
  });
});
