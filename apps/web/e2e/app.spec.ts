/**
 * M3.5 — authenticated surface E2E: login, account-scoped opportunities,
 * opportunity detail with facts-vs-inferences + gate, admin pages, and the
 * account-isolation + role-authorization guarantees (spec §17).
 * Requires the local Postgres with the seeded/resolved corpus.
 */
import { expect, test, type APIRequestContext } from "@playwright/test";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env") });
const PASSWORD = process.env.AUTH_SECRET!;

async function login(
  request: APIRequestContext,
  accountKey: string | null,
  role: "customer" | "admin" = "customer",
) {
  const res = await request.post("/api/auth/login", {
    data: { password: PASSWORD, accountKey, role },
  });
  expect(res.ok()).toBe(true);
}

test.describe("authentication", () => {
  test("rejects a wrong passphrase", async ({ request }) => {
    const res = await request.post("/api/auth/login", {
      data: { password: "wrong", accountKey: "solis_interiors", role: "customer" },
    });
    expect(res.status()).toBe(401);
  });

  test("unauthenticated API access is denied", async ({ request }) => {
    const res = await request.get("/api/app/opportunities");
    expect(res.status()).toBe(401);
  });

  test("unauthenticated page access redirects to login", async ({ page }) => {
    await page.goto("/app/opportunities");
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("customer surface", () => {
  test("login lands on the account's opportunity list", async ({ page }) => {
    await page.goto("/login");
    await page.getByTestId("login-account").selectOption("solis_interiors");
    await page.getByTestId("login-password").fill(PASSWORD);
    await page.getByTestId("login-submit").click();
    await expect(page).toHaveURL(/\/app\/opportunities/);
    await expect(page.getByTestId("session-info")).toContainText("solis_interiors");
    const rows = page.getByTestId("opportunities-table").locator("tbody tr");
    expect(await rows.count()).toBeGreaterThan(0);
  });

  test("opportunity detail shows §16 sections and records feedback", async ({ page, request }) => {
    await login(request, "solis_interiors");
    const list = await (await request.get("/api/app/opportunities?limit=1")).json();
    const oppId = list.items[0].id as string;

    // Reuse the API session cookies in the browser context.
    await page.context().addCookies(await request.storageState().then((s) => s.cookies));
    await page.goto(`/app/opportunities/${oppId}`);
    await expect(page.getByTestId("opportunity-title")).toBeVisible();
    await expect(page.getByTestId("next-action")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Confirmed facts vs. inferences" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Publication gate" })).toBeVisible();

    const detail = await (await request.get(`/api/app/opportunities/${oppId}`)).json();
    expect(detail.gate.status).toMatch(/pass|fail|blocked_on_verifier/);
    expect(Array.isArray(detail.evidence)).toBe(true);

    const fb = await request.post(`/api/app/opportunities/${oppId}/feedback`, {
      data: { relevant: true, timely: false, dispositionReason: null, notes: "e2e feedback" },
    });
    expect(fb.ok()).toBe(true);
  });

  test("account isolation: one account cannot read another's opportunity", async ({ request, playwright, baseURL }) => {
    await login(request, "solis_interiors");
    const list = await (await request.get("/api/app/opportunities?limit=1")).json();
    const solisOpp = list.items[0].id as string;

    const other = await playwright.request.newContext({ baseURL: baseURL! });
    await login(other, "lacey_glass_at_home");
    const res = await other.get(`/api/app/opportunities/${solisOpp}`);
    expect(res.status()).toBe(404);
    await other.dispose();
  });

  test("customer sessions cannot reach admin APIs", async ({ request }) => {
    await login(request, "solis_interiors");
    const res = await request.get("/api/admin/sources");
    expect(res.status()).toBe(403);
  });
});

test.describe("admin surface", () => {
  test("admin sees sources with health and the review queue", async ({ page, request }) => {
    await login(request, null, "admin");
    await page.context().addCookies(await request.storageState().then((s) => s.cookies));

    await page.goto("/app/admin/sources");
    const rows = page.getByTestId("sources-table").locator("tbody tr");
    expect(await rows.count()).toBeGreaterThan(10);

    await page.goto("/app/admin/review");
    await expect(page.getByTestId("review-table")).toBeVisible();

    const coverage = await (await request.get("/api/admin/coverage")).json();
    expect(coverage.items.length).toBeGreaterThan(10);
  });
});
