/**
 * Mobile M1 — the digest reader.
 *
 * NEW spec file; the pre-existing specs are the redesign safety net and are
 * never edited.
 *
 * This one seeds and removes its OWN delivery row rather than relying on the
 * corpus: the e2e seed creates no deliveries (the digest worker makes them), so
 * a test that waited for one would assert nothing on a fresh database. The row
 * is deleted in `afterAll` so the suite leaves no residue, and its delivery_type
 * is marked so a leaked row is obviously test debris.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { e2eDatabaseUrl } from "@otn/db";

config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env") });
const PASSWORD = process.env.AUTH_SECRET!;
const RUN = randomUUID().slice(0, 8);
const MARKER = `e2e digest body ${RUN}`;

let deliveryId = "";

async function withPg<T>(fn: (q: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) => Promise<T>): Promise<T> {
  const pg = await import("pg");
  const pool = new pg.default.Pool({ connectionString: e2eDatabaseUrl(), max: 1 });
  try {
    return await fn((sql, params) => pool.query(sql, params) as Promise<{ rows: Record<string, unknown>[] }>);
  } finally {
    await pool.end();
  }
}

async function login(request: APIRequestContext, accountKey: string) {
  const res = await request.post("/api/auth/login", {
    data: { password: PASSWORD, accountKey, role: "customer" },
  });
  expect(res.ok()).toBe(true);
}

test.beforeAll(async () => {
  deliveryId = await withPg(async (q) => {
    const acct = await q(`SELECT id FROM account_profiles WHERE key = $1 LIMIT 1`, [
      "solis_interiors",
    ]);
    const accountId = acct.rows[0]?.["id"] as string;
    expect(accountId).toBeTruthy();
    const ins = await q(
      `INSERT INTO deliveries
         (account_profile_id, delivery_type, period_start, period_end, rendered_content,
          status, idempotency_key, sent_at)
       VALUES ($1, 'e2e_digest', now() - interval '7 days', now(),
               $2, 'sent', $3, now())
       RETURNING id`,
      [accountId, `<h2>Week in review</h2><p>${MARKER}</p>`, `e2e-digest-${RUN}`],
    );
    return ins.rows[0]!["id"] as string;
  });
});

test.afterAll(async () => {
  if (!deliveryId) return;
  await withPg((q) => q(`DELETE FROM deliveries WHERE id = $1`, [deliveryId]));
});

test.describe("digest reader", () => {
  test("a digest row links to a page that renders its stored content", async ({
    request,
    browser,
    baseURL,
  }) => {
    await login(request, "solis_interiors");
    const ctx = await browser.newContext({ baseURL: baseURL! });
    await ctx.addCookies((await request.storageState()).cookies);
    const page = await ctx.newPage();

    await page.goto("/app/digests");
    await page.getByTestId("digest-link").first().click();

    await expect(page.getByTestId("digest-detail")).toBeVisible();
    // The stored worker-rendered HTML, not a rebuild (ADR-9).
    await expect(page.getByTestId("digest-content")).toContainText(MARKER);

    await ctx.close();
  });

  test("a digest id from another account reads as not found, not as content", async ({
    request,
    browser,
    baseURL,
  }) => {
    // Delivery ids are UUIDs, but "hard to guess" is not authorization. The
    // query filters on account_profile_id; this is that filter's test.
    await login(request, "lacey_glass_at_home");
    const ctx = await browser.newContext({ baseURL: baseURL! });
    await ctx.addCookies((await request.storageState()).cookies);
    const page = await ctx.newPage();

    await page.goto(`/app/digests/${deliveryId}`);
    await expect(page.getByTestId("digest-not-found")).toBeVisible();
    await expect(page.getByTestId("digest-content")).toHaveCount(0);

    await ctx.close();
  });

  test("an unknown id is a stated not-found, never a blank page", async ({
    request,
    browser,
    baseURL,
  }) => {
    await login(request, "solis_interiors");
    const ctx = await browser.newContext({ baseURL: baseURL! });
    await ctx.addCookies((await request.storageState()).cookies);
    const page = await ctx.newPage();

    await page.goto(`/app/digests/${randomUUID()}`);
    await expect(page.getByTestId("digest-not-found")).toBeVisible();

    await ctx.close();
  });
});
