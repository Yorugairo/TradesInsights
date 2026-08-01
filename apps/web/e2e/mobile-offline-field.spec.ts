/**
 * Mobile M0/M1 — offline field capture and entry idempotency.
 *
 * NEW spec file: the pre-existing specs are the redesign safety net and are
 * never edited. Conventions follow field-takeoff.spec.ts — API-first login,
 * `solis_interiors` as the account, a fresh cookie-less context for the crew
 * (the link IS the auth), and a RUN-unique marker so re-runs never collide.
 *
 * WHAT THIS PROVES that the unit tests cannot: that the database really stores
 * ONE row for a replayed key. `field.test.ts` stubs the Db and so would pass
 * even if migration 0042's partial unique index were missing; only a real
 * INSERT can tell us the index exists and is doing its job.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env") });
const PASSWORD = process.env.AUTH_SECRET!;
const RUN = randomUUID().slice(0, 8);

async function login(request: APIRequestContext, accountKey: string | null) {
  const res = await request.post("/api/auth/login", {
    data: { password: PASSWORD, accountKey, role: "customer" },
  });
  expect(res.ok()).toBe(true);
}

async function openPursuit(request: APIRequestContext): Promise<string> {
  const list = await (await request.get("/api/app/opportunities?limit=1")).json();
  const oppId = list.items[0].id as string;
  const res = await request.post("/api/app/pursuits", { data: { opportunityId: oppId } });
  expect([200, 201]).toContain(res.status());
  return ((await res.json()) as { id: string }).id;
}

async function mintFieldPath(request: APIRequestContext, pursuitId: string): Promise<string> {
  const minted = await request.post(`/api/app/pursuits/${pursuitId}/field-links`, {
    data: { label: `e2e-offline-${RUN}` },
  });
  expect(minted.status()).toBe(201);
  const { url } = (await minted.json()) as { url: string };
  // The minted URL carries APP_BASE_URL; the suite's server listens elsewhere.
  return new URL(url).pathname;
}

test.describe("field entry idempotency", () => {
  test("the same clientEntryId twice stores ONE row and reports deduped", async ({ request }) => {
    await login(request, "solis_interiors");
    const pursuitId = await openPursuit(request);
    const fieldPath = await mintFieldPath(request, pursuitId);
    const token = fieldPath.split("/").pop()!;

    const clientEntryId = randomUUID();
    const body = `offline replay e2e-${RUN}`;
    const payload = { entryType: "daily_log", body, boards: "40", clientEntryId };

    const first = await request.post(`/api/field/${token}/entries`, { data: payload });
    expect(first.status()).toBe(201);
    const a = (await first.json()) as { id: string; deduped: boolean };
    expect(a.deduped).toBe(false);

    // The replay an outbox performs when it never saw the first response.
    const second = await request.post(`/api/field/${token}/entries`, { data: payload });
    expect(second.status()).toBe(200);
    const b = (await second.json()) as { id: string; deduped: boolean };
    expect(b.deduped).toBe(true);
    expect(b.id).toBe(a.id);

    // The SAME id twice is itself the proof that no second row exists — a new
    // insert would have produced a new uuid. There is no list endpoint for
    // field entries, so this identity check is the available evidence, and it
    // is sufficient: it can only hold if the partial unique index from
    // migration 0042 is present and matched.
  });

  test("entries without a client key are independent — cockpit path unchanged", async ({ request }) => {
    await login(request, "solis_interiors");
    const pursuitId = await openPursuit(request);
    const fieldPath = await mintFieldPath(request, pursuitId);
    const token = fieldPath.split("/").pop()!;

    const body = `no-key twice e2e-${RUN}`;
    const one = await request.post(`/api/field/${token}/entries`, {
      data: { entryType: "note", body },
    });
    const two = await request.post(`/api/field/${token}/entries`, {
      data: { entryType: "note", body },
    });
    expect(one.status()).toBe(201);
    expect(two.status()).toBe(201);
    // Two identical notes on the same day are BOTH real work. Deduping on
    // content would silently delete a crew's second entry.
    expect(((await one.json()) as { id: string }).id).not.toBe(
      ((await two.json()) as { id: string }).id,
    );
  });

  test("a malformed client key is refused rather than squatting the index", async ({ request }) => {
    await login(request, "solis_interiors");
    const pursuitId = await openPursuit(request);
    const fieldPath = await mintFieldPath(request, pursuitId);
    const token = fieldPath.split("/").pop()!;

    const res = await request.post(`/api/field/${token}/entries`, {
      data: { entryType: "note", body: `bad key e2e-${RUN}`, clientEntryId: "not-a-uuid" },
    });
    expect(res.status()).toBe(400);
  });
});

test.describe("offline capture", () => {
  test("submitting with no network queues on the device, then sends on reconnect", async ({
    request,
    browser,
    baseURL,
  }) => {
    await login(request, "solis_interiors");
    const pursuitId = await openPursuit(request);
    const fieldPath = await mintFieldPath(request, pursuitId);

    // The crew context: no cookies — the link is the credential.
    const crew = await browser.newContext({ baseURL: baseURL! });
    const page = await crew.newPage();
    await page.goto(fieldPath);
    await expect(page.getByTestId("field-page")).toBeVisible();

    const body = `offline daily log e2e-${RUN}`;
    await crew.setOffline(true);

    await page.locator('form:has(input[value="daily_log"]) textarea[name="body"]').fill(body);
    await page.locator('form:has(input[value="daily_log"]) input[name="boards"]').fill("64");
    await page.getByTestId("field-log-submit").click();

    // Saved on the phone — and SAID to be, which is the whole promise.
    const outbox = page.getByTestId("field-outbox");
    await expect(outbox).toBeVisible();
    await expect(page.getByTestId("field-outbox-pending")).toContainText("1 entry");

    // Nothing reached the server while offline — checked on the crew page's
    // own Recent list, which is server-rendered from field_entries.
    const probe = await browser.newContext({ baseURL: baseURL! });
    const probePage = await probe.newPage();
    await probePage.goto(fieldPath);
    await expect(probePage.getByTestId("field-recent")).not.toContainText(body);
    await probe.close();

    // Reconnect: the queue flushes itself, unprompted.
    await crew.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    // The chip UNMOUNTS when the queue drains and we are online — that is the
    // "nothing to sync" state, and it must be distinguishable from "sync is
    // failing" (which keeps the chip up with a reason).
    await expect(outbox).toHaveCount(0, { timeout: 15_000 });

    // A fresh server render now shows it.
    await page.reload();
    await expect(page.getByTestId("field-recent")).toContainText(body);

    await crew.close();
  });

  test("online with an empty queue, the plain-HTML form path is untouched", async ({
    request,
    browser,
    baseURL,
  }) => {
    await login(request, "solis_interiors");
    const pursuitId = await openPursuit(request);
    const fieldPath = await mintFieldPath(request, pursuitId);

    const crew = await browser.newContext({ baseURL: baseURL! });
    const page = await crew.newPage();
    await page.goto(fieldPath);

    const body = `native submit e2e-${RUN}`;
    await page.locator('form:has(input[value="daily_log"]) textarea[name="body"]').fill(body);
    await page.getByTestId("field-log-submit").click();

    // The native 303 redirect, exactly as before the offline layer existed.
    await expect(page).toHaveURL(/ok=1/);
    await expect(page.getByTestId("field-submitted-ok")).toBeVisible();
    // No outbox chip when there is nothing queued.
    await expect(page.getByTestId("field-outbox")).toHaveCount(0);

    await crew.close();
  });
});
