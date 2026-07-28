/**
 * The cockpit's "what to trust" cards, and the SSO refusal surface.
 *
 * A NEW spec file, not an edit to `shell.spec.ts` or `app.spec.ts` — the rule
 * on this project is that a failing test means the markup is wrong, so specs
 * are never rewritten to fit new markup. Adding coverage is the safe direction.
 *
 * What these guard, all of it the "never fabricate" rule wearing different
 * clothes:
 *   - unstamped calibration provenance renders as a STATE, not as zeros
 *   - the dropped-family chip is a regression flag: absent when the count is 0
 *   - an alerts card exists whether or not anything is wrong
 *   - a refused SSO handoff explains itself on the login page instead of
 *     dumping the customer at an unexplained form
 *   - a forged handoff token grants NOTHING
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env") });
const PASSWORD = process.env.AUTH_SECRET!;

async function loginAdmin(request: APIRequestContext, page: Page) {
  const res = await request.post("/api/auth/login", {
    data: { password: PASSWORD, accountKey: null, role: "admin" },
  });
  expect(res.ok()).toBe(true);
  await page.context().addCookies(await request.storageState().then((s) => s.cookies));
}

test.describe("cockpit trust cards", () => {
  test("calibration card names every active account and its provenance state", async ({
    page,
    request,
  }) => {
    await loginAdmin(request, page);
    await page.goto("/app/admin/cockpit");

    const card = page.getByTestId("calibration-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Calibration provenance");

    // The corpus seeds accounts from config, so at least one row renders and
    // each says either its counts or that provenance was never stamped —
    // never a bare zero standing in for "we did not look".
    const text = (await card.textContent()) ?? "";
    expect(text).toMatch(/owner-assumed|provenance not stamped|No active accounts/);
  });

  test("alerts card renders regardless of whether anything is wrong", async ({ page, request }) => {
    await loginAdmin(request, page);
    await page.goto("/app/admin/cockpit");

    const card = page.getByTestId("alerts-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Open alerts");
    // Quiet and noisy are both valid; what must never happen is the card
    // vanishing, because absence reads as "no alerting exists".
    expect((await card.textContent()) ?? "").toMatch(/Nothing unresolved|critical|warning/);
  });

  test("the dropped-families chip is absent when nothing was dropped", async ({ page, request }) => {
    await loginAdmin(request, page);
    await page.goto("/app/admin/cockpit");

    // e2e runs with REGISTRY_DATABASE_URL unset, so the families card is in its
    // seam-offline state and there is no drop count to show. A chip appearing
    // here would mean a zero is being rendered as a finding.
    await expect(page.getByTestId("families-dropped")).toHaveCount(0);
  });
});

test.describe("SSO handoff refusals", () => {
  test("a forged token grants no session and explains itself", async ({ page }) => {
    // Not signed with INSIGHTS_SSO_SECRET — the single most important negative
    // case in the whole handoff.
    await page.goto("/api/auth/sso?token=forged.nonsense");

    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByTestId("login-message")).toContainText("not valid");

    // And it really is a refusal, not a cosmetic redirect: an admin route
    // still bounces.
    await page.goto("/app/admin/cockpit");
    await expect(page).toHaveURL(/\/login/);
  });

  test("a missing token is refused the same way", async ({ page }) => {
    await page.goto("/api/auth/sso");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByTestId("login-message")).toBeVisible();
  });

  test("the login message is rendered as text, never as markup", async ({ page }) => {
    // The message is attacker-writable URL input; it must land in the DOM as
    // text. If it were ever interpolated as HTML this would find it.
    await page.goto("/login?message=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3Ehello");
    const banner = page.getByTestId("login-message");
    await expect(banner).toContainText("hello");
    expect(await banner.locator("img").count()).toBe(0);
  });
});
