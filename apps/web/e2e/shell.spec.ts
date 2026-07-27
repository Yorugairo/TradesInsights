/**
 * Phase 2 — the cockpit shell contract.
 *
 * A NEW spec file, not an edit to `app.spec.ts`. The rule on this project is
 * that a failing test means the markup is wrong; specs are never rewritten to
 * match new markup. Adding coverage the old suite never had is the one safe
 * direction, and these are the guarantees the retrofit in Phase 3 will lean on:
 *
 *   - every nav destination resolves (the shell's original bug was a link to a
 *     route that did not exist, and a page reachable only from inside itself)
 *   - the active link is machine-detectable, not just gold
 *   - the palette is keyboard-complete and does not steal Cmd-K from a filter
 *   - density survives a reload
 *   - a customer session is never offered an admin route
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env") });
const PASSWORD = process.env.AUTH_SECRET!;

async function login(
  request: APIRequestContext,
  page: Page,
  accountKey: string | null,
  role: "customer" | "admin",
) {
  const res = await request.post("/api/auth/login", {
    data: { password: PASSWORD, accountKey, role },
  });
  expect(res.ok()).toBe(true);
  await page.context().addCookies(await request.storageState().then((s) => s.cookies));
}

const NAV = 'nav[aria-label="Primary"]';

/**
 * Block until the shell has hydrated.
 *
 * DensityToggle renders `data-state="unknown"` on the server and cannot render
 * anything else there — it reads the real value from the DOM in an effect. So
 * the attribute flipping is proof that client JS is attached, which is what
 * keyboard-shortcut tests actually depend on. Waiting on visibility instead
 * would pass against server-rendered markup with no handlers bound, and fail
 * intermittently under parallel load.
 */
async function hydrated(page: Page) {
  await expect(page.getByTestId("density-toggle")).not.toHaveAttribute("data-state", "unknown");
}

test.describe("cockpit shell", () => {
  test("every primary nav link resolves", async ({ page, request }) => {
    // Fourteen sequential page loads against a remote database. The default 60s
    // is genuinely too small for the work, and padding it is honest where
    // re-running until it passes would not be.
    test.setTimeout(180_000);
    // Admin sees the widest nav, so this covers the customer set too.
    await login(request, page, "solis_interiors", "admin");
    await page.goto("/app/opportunities");

    const hrefs = await page.locator(`${NAV} a`).evaluateAll((links) =>
      links.map((a) => (a as HTMLAnchorElement).getAttribute("href")).filter(Boolean),
    );
    // Guard against the locator silently matching nothing and the loop below
    // then "passing" over an empty list.
    expect(hrefs.length).toBeGreaterThanOrEqual(13);

    for (const href of hrefs) {
      const response = await page.goto(href!);
      expect(response?.status(), `${href} status`).toBeLessThan(400);
      // A Next 404 renders with a 200 in some configurations, so assert the
      // shell itself came back rather than trusting the status alone.
      await expect(page.getByTestId("session-info"), `${href} shell`).toBeVisible();
    }
  });

  test("the active link is marked aria-current, including on nested routes", async ({
    page,
    request,
  }) => {
    await login(request, page, "solis_interiors", "customer");

    await page.goto("/app/pursuits");
    await expect(page.locator(`${NAV} a[aria-current="page"]`)).toHaveText("Pursuits");

    // A detail page must keep its section lit, or the operator loses their place.
    const list = await (await request.get("/api/app/opportunities?limit=1")).json();
    await page.goto(`/app/opportunities/${list.items[0].id}`);
    await expect(page.locator(`${NAV} a[aria-current="page"]`)).toHaveText("Opportunities");
  });

  test("a customer session is offered no admin route", async ({ page, request }) => {
    await login(request, page, "solis_interiors", "customer");
    await page.goto("/app/opportunities");
    await expect(page.locator(`${NAV} a[href^="/app/admin"]`)).toHaveCount(0);
    await expect(page.getByTestId("command-palette-trigger")).toBeVisible();
  });

  test("Cmd-K opens the palette and Enter navigates", async ({ page, request }) => {
    await login(request, page, "solis_interiors", "customer");
    await page.goto("/app/opportunities");
    await hydrated(page);

    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByTestId("command-palette")).toBeVisible();

    await page.getByTestId("command-palette-input").fill("radar");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/app\/radar/);
    await expect(page.getByTestId("command-palette")).toBeHidden();
  });

  test("Cmd-K is not stolen from a filter input", async ({ page, request }) => {
    await login(request, page, "solis_interiors", "customer");
    await page.goto("/app/opportunities");

    await hydrated(page);

    await page.locator('[data-testid="opportunity-filters"] input[name="q"]').focus();
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByTestId("command-palette")).toBeHidden();
  });

  test("Escape closes the palette", async ({ page, request }) => {
    await login(request, page, "solis_interiors", "customer");
    await page.goto("/app/opportunities");
    await hydrated(page);
    await page.getByTestId("command-palette-trigger").click();
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("command-palette")).toBeHidden();
  });

  test("density persists across a reload", async ({ page, request }) => {
    await login(request, page, "solis_interiors", "customer");
    await page.goto("/app/opportunities");
    await hydrated(page);

    const html = page.locator("html");
    const toggle = page.getByTestId("density-toggle");
    // Absent, not "comfortable": app/layout.tsx deliberately does not render
    // the attribute, so React cannot undo the no-flash script at hydration.
    await expect(html).not.toHaveAttribute("data-density", "compact");
    await expect(toggle).toHaveAttribute("data-state", "comfortable");

    await toggle.click();
    await expect(html).toHaveAttribute("data-density", "compact");

    await page.reload();
    // Survives because the inline script in app/layout.tsx re-applies it before
    // paint AND nothing reconciles it away afterwards. Both halves matter: the
    // script alone passed this assertion once and failed it under load, because
    // hydration was restoring the server value.
    await expect(html).toHaveAttribute("data-density", "compact");
    await expect(toggle).toHaveAttribute("data-state", "compact");
  });
});
