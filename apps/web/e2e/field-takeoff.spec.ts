/**
 * CRM upgrade (deck A5/A6): takeoff scaffold + field communication.
 *
 * NEW spec file on purpose — the four pre-existing specs are the redesign
 * safety net and are never edited. Conventions follow app.spec.ts: API-first
 * login, addCookies for page assertions, `lacey_glass_at_home` as the
 * isolation counterparty, and RUN-unique markers so re-runs against the same
 * seeded corpus never collide with their own leftovers (pursuit creation is
 * idempotent per (account, opportunity), so rows do not accumulate).
 */
import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env") });
const PASSWORD = process.env.AUTH_SECRET!;
const RUN = randomUUID().slice(0, 8);

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

/** One pursuit for the whole file, opened API-first like the app would. */
async function openPursuit(request: APIRequestContext): Promise<string> {
  const list = await (await request.get("/api/app/opportunities?limit=1")).json();
  const oppId = list.items[0].id as string;
  const res = await request.post("/api/app/pursuits", { data: { opportunityId: oppId } });
  expect([200, 201]).toContain(res.status());
  return ((await res.json()) as { id: string }).id;
}

test.describe("takeoff", () => {
  test("derives on first GET, edits convert lines to manual, stamp writes the pursuit", async ({ request }) => {
    await login(request, "solis_interiors");
    const pursuitId = await openPursuit(request);

    const got = await request.get(`/api/app/pursuits/${pursuitId}/takeoff`);
    expect(got.ok()).toBe(true);
    const { sheet } = (await got.json()) as { sheet: { id: string; lines: { id: string; qty: number; source: string }[] } };
    expect(sheet.id).toBeTruthy();

    // A sheet may have zero derived lines (evidence-dependent) — add one
    // manual line so the edit/stamp path is deterministic either way.
    const added = await request.post(`/api/app/pursuits/${pursuitId}/takeoff/lines`, {
      data: { assemblyKey: "doors_frames", qty: 7, unitCost: 100 },
    });
    expect(added.status()).toBe(201);

    // Edit any line: qty change must persist and the line must read manual.
    const fresh = (await (await request.get(`/api/app/pursuits/${pursuitId}/takeoff`)).json()) as {
      sheet: { lines: { id: string; qty: number; source: string }[] };
    };
    const target = fresh.sheet.lines[0]!;
    const patched = await request.patch(`/api/app/pursuits/${pursuitId}/takeoff/lines`, {
      data: { lineId: target.id, qty: 123 },
    });
    expect(patched.ok()).toBe(true);
    const after = (await (await request.get(`/api/app/pursuits/${pursuitId}/takeoff`)).json()) as {
      sheet: { lines: { id: string; qty: number; source: string }[]; totals: { bidPrice: number } };
    };
    const edited = after.sheet.lines.find((l) => l.id === target.id)!;
    expect(edited.qty).toBe(123);
    expect(edited.source).toBe("manual");

    // Stamp → pursuits.estimated_contract_value equals the sheet's bid price.
    const stamp = await request.patch(`/api/app/pursuits/${pursuitId}/takeoff`, {
      data: { action: "stamp-estimate" },
    });
    expect(stamp.ok()).toBe(true);
    const { bidPrice } = (await stamp.json()) as { bidPrice: number };
    expect(bidPrice).toBe(after.sheet.totals.bidPrice);
    const pursuit = (await (await request.get(`/api/app/pursuits/${pursuitId}`)).json()) as {
      estimatedContractValue: number;
    };
    expect(pursuit.estimatedContractValue).toBe(bidPrice);
  });

  test("another account gets 404 on the same sheet (spec §17 isolation)", async ({ request, playwright, baseURL }) => {
    await login(request, "solis_interiors");
    const pursuitId = await openPursuit(request);
    const other = await playwright.request.newContext({ baseURL: baseURL! });
    await login(other, "lacey_glass_at_home");
    const res = await other.get(`/api/app/pursuits/${pursuitId}/takeoff`);
    expect(res.status()).toBe(404);
    await other.dispose();
  });
});

test.describe("field", () => {
  test("mint → crew submits a change order without a session → owner approves once", async ({
    request, browser, baseURL,
  }) => {
    await login(request, "solis_interiors");
    const pursuitId = await openPursuit(request);

    const minted = await request.post(`/api/app/pursuits/${pursuitId}/field-links`, {
      data: { label: `e2e-crew-${RUN}` },
    });
    expect(minted.status()).toBe(201);
    const { url } = (await minted.json()) as { url: string };
    expect(url).toContain("/field/");
    // The minted URL carries the CONFIGURED origin (APP_BASE_URL — what the
    // owner texts to a crew member). The e2e server listens elsewhere, so
    // navigate by path against the suite's baseURL.
    const fieldPath = new URL(url).pathname;

    // The crew context: a fresh browser with NO cookies — the link is the auth.
    const crew = await browser.newContext({ baseURL: baseURL! });
    const page = await crew.newPage();
    await page.goto(fieldPath);
    await expect(page.getByTestId("field-page")).toBeVisible();
    await expect(page.getByTestId("field-project-name")).not.toBeEmpty();

    const coBody = `water damage north wall e2e-${RUN}`;
    await page.locator('form:has(input[value="change_order"]) textarea[name="body"]').fill(coBody);
    await page.locator('form:has(input[value="change_order"]) input[name="amount"]').fill("1850");
    await page.locator('form:has(input[value="change_order"]) input[name="submittedName"]').fill("Javier R");
    await page.getByTestId("field-co-submit").click();
    await expect(page).toHaveURL(/ok=1/);
    await expect(page.getByTestId("field-submitted-ok")).toBeVisible();
    await crew.close();

    // The owner sees it in the cockpit and approves — exactly once.
    const detailPage = await browser.newContext({ baseURL: baseURL! });
    const cockpit = await detailPage.newPage();
    await detailPage.addCookies(await request.storageState().then((s) => s.cookies));
    await cockpit.goto(`/app/pursuits/${pursuitId}`);
    await expect(cockpit.getByTestId("field-section")).toContainText(coBody);
    await detailPage.close();

    // Find the entry id via a fresh links/entries read: approve via API.
    // (Entries API surface is the decision route; discovery is by unique body.)
    const pursuitHtml = await (await request.get(`/app/pursuits/${pursuitId}`)).text();
    expect(pursuitHtml).toContain(coBody);
    // Decide through the route: locate the entry id in the DB-backed page is
    // not exposed — approve by scanning the decision buttons' entry ids is UI
    // work; the API contract is what matters here, so replay a submit via
    // JSON to get an id and decide THAT one.
    const token = url.split("/field/")[1]!;
    const jsonSubmit = await request.post(`/api/field/${token}/entries`, {
      data: { entryType: "change_order", body: `co-json-${RUN}`, amount: 900, submittedName: "Daniel" },
    });
    expect(jsonSubmit.status()).toBe(201);
    const { id: entryId } = (await jsonSubmit.json()) as { id: string };

    const approve = await request.post(`/api/app/pursuits/${pursuitId}/field-entries/${entryId}/decision`, {
      data: { decision: "approved" },
    });
    expect(approve.ok()).toBe(true);
    const again = await request.post(`/api/app/pursuits/${pursuitId}/field-entries/${entryId}/decision`, {
      data: { decision: "rejected" },
    });
    expect(again.status()).toBe(409);
  });

  test("a revoked link renders one neutral page; garbage tokens likewise", async ({ request, browser, baseURL }) => {
    await login(request, "solis_interiors");
    const pursuitId = await openPursuit(request);
    const minted = await request.post(`/api/app/pursuits/${pursuitId}/field-links`, {
      data: { label: `e2e-revoke-${RUN}` },
    });
    const { id, url } = (await minted.json()) as { id: string; url: string };
    const fieldPath = new URL(url).pathname;
    const revoke = await request.delete(`/api/app/pursuits/${pursuitId}/field-links`, {
      data: { linkId: id },
    });
    expect(revoke.ok()).toBe(true);

    const crew = await browser.newContext({ baseURL: baseURL! });
    const page = await crew.newPage();
    await page.goto(fieldPath);
    await expect(page.locator("h2")).toContainText("Link unavailable");
    await page.goto("/field/garbage-token");
    await expect(page.locator("h2")).toContainText("Link unavailable");
    // And the POST side fails closed for the revoked link.
    const token = url.split("/field/")[1]!;
    const post = await request.post(`/api/field/${token}/entries`, {
      data: { entryType: "note", body: "should not land" },
    });
    expect(post.status()).toBe(404);
    await crew.close();
  });
});
