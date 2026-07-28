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
 * THE CEILING IS NOW REAL. It was 30s while the suite ran against the hosted
 * database, where absolute numbers moved with WAN latency and whatever else was
 * querying. Against the local corpus the whole 29-test suite finishes in ~28s,
 * so a per-page ceiling can be tight enough to catch a regression the day it
 * lands rather than the month someone notices.
 *
 * Measured 2026-07-28, local corpus, two workers: every route below responds in
 * well under a second. 5s leaves generous room for a cold route compile and CI
 * being slower than a laptop, while still failing loudly if someone
 * reintroduces a per-request seam pull (the defect that made the cockpit 21.8s
 * and /app/admin/corporate-families 109s).
 */

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const PASSWORD = process.env.AUTH_SECRET ?? "";

/** Per-route ceiling. See the header note for why 5s and not 30s or 1s. */
const BUDGET_MS = 5_000;

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
    test.setTimeout(ROUTES.length * BUDGET_MS * 3);
    await login(request);
    await page.context().addCookies(await request.storageState().then((s) => s.cookies));

    // No warm-up pass. `REGISTRY_DATABASE_URL` is unset for e2e
    // (playwright.config.ts), so the family snapshot never derives and the
    // seam-dependent pages render their "seam offline" state immediately —
    // which is itself worth having under a budget.
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
