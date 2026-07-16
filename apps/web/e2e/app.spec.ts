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
    // S1 decision memo leads the page with recommended action + capacity/procurement.
    await expect(page.getByTestId("decision-memo")).toBeVisible();
    await expect(page.getByTestId("memo-recommended-action")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Confirmed facts vs. inferences" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Publication gate" })).toBeVisible();

    const detail = await (await request.get(`/api/app/opportunities/${oppId}`)).json();
    expect(detail.gate.status).toMatch(/pass|fail|blocked_on_verifier/);
    expect(Array.isArray(detail.evidence)).toBe(true);

    // S1 decision-memo API + idempotent regenerate.
    const memo = await (await request.get(`/api/app/opportunities/${oppId}/decision-memo`)).json();
    expect(memo.procurementState).toMatch(/unknown|relationship_radar|monitoring|bidding_confirmed|late_or_closed/);
    expect(Array.isArray(memo.scoreComponents)).toBe(true);
    const regen = await request.post(`/api/app/opportunities/${oppId}/regenerate-memo`);
    expect(regen.ok()).toBe(true);
    const regenBody = await regen.json();
    expect(typeof regenBody.decisionVersion).toBe("number");

    const fb = await request.post(`/api/app/opportunities/${oppId}/feedback`, {
      data: { relevant: true, timely: false, dispositionReason: null, notes: "e2e feedback" },
    });
    expect(fb.ok()).toBe(true);

    // Controlled disposition vocabulary (M3.7): known reason accepted,
    // free-form reason rejected (free text belongs in notes).
    const good = await request.post(`/api/app/opportunities/${oppId}/feedback`, {
      data: { relevant: false, dispositionReason: "wrong_trade" },
    });
    expect(good.ok()).toBe(true);
    const bad = await request.post(`/api/app/opportunities/${oppId}/feedback`, {
      data: { relevant: false, dispositionReason: "just not feeling it" },
    });
    expect(bad.status()).toBe(400);
  });

  test("pursuit workflow: create, list, invalid transition blocked, isolation", async ({ request, playwright, baseURL }) => {
    await login(request, "solis_interiors");
    const list = await (await request.get("/api/app/opportunities?limit=1")).json();
    const oppId = list.items[0].id as string;

    // Idempotent create (re-runnable against seeded data).
    const created = await request.post("/api/app/pursuits", { data: { opportunityId: oppId } });
    expect(created.ok()).toBe(true);
    const pursuitId = (await created.json()).id as string;

    const board = await (await request.get("/api/app/pursuits")).json();
    expect(board.items.some((p: { id: string }) => p.id === pursuitId)).toBe(true);

    const detail = await (await request.get(`/api/app/pursuits/${pursuitId}`)).json();
    expect(Array.isArray(detail.allowedTransitions)).toBe(true);

    // 'discovered' is never a valid target — the state machine rejects it (422).
    const bad = await request.post(`/api/app/pursuits/${pursuitId}/transition`, { data: { to: "discovered" } });
    expect(bad.status()).toBe(422);

    // Task-type validation.
    const badTask = await request.post(`/api/app/pursuits/${pursuitId}/tasks`, {
      data: { title: "x", taskType: "nope" },
    });
    expect(badTask.status()).toBe(422);

    // Account isolation: another account cannot read this pursuit.
    const other = await playwright.request.newContext({ baseURL: baseURL! });
    await login(other, "lacey_glass_at_home");
    const cross = await other.get(`/api/app/pursuits/${pursuitId}`);
    expect(cross.status()).toBe(404);
    await other.dispose();
  });

  test("invitation upload: ingest, idempotent re-upload, account isolation", async ({ request, playwright, baseURL }) => {
    await login(request, "solis_interiors");
    const mid = `e2e-inv-${Date.now()}@acme-gc.com`;
    const rawEml = [
      `From: "Acme GC" <estimating@acme-gc.com>`,
      `To: bids@solis.example`,
      `Subject: Invitation to Bid`,
      `Message-ID: <${mid}>`,
      ``,
      `You are invited to submit a bid.`,
      `Project: E2E Nonmatching Project`,
      `Scope: Division 09 drywall`,
      `Bids due: August 15, 2026`,
    ].join("\n");

    const up = await request.post("/api/app/invitations/upload", { data: { rawEml } });
    expect(up.status()).toBe(201);
    const first = await up.json();
    expect(first.deduped).toBe(false);
    expect(first.invitationId).toBeTruthy();

    // Same Message-ID → idempotent.
    const up2 = await request.post("/api/app/invitations/upload", { data: { rawEml } });
    expect((await up2.json()).deduped).toBe(true);

    // Detail is account-scoped: another account gets 404.
    const other = await playwright.request.newContext({ baseURL: baseURL! });
    await login(other, "lacey_glass_at_home");
    const cross = await other.get(`/api/app/invitations/${first.invitationId}`);
    expect(cross.status()).toBe(404);
    await other.dispose();
  });

  test("GC relationships: account-specific state, public roles stay distinct", async ({ request, playwright, baseURL }) => {
    await login(request, "solis_interiors");
    const orgs = (await (await request.get("/api/app/organizations")).json()).items as { id: string }[];
    if (orgs.length === 0) return; // no org on seeded opportunities → nothing to exercise
    const orgId = orgs[0]!.id;

    const set = await request.post(`/api/app/organizations/${orgId}/relationship`, {
      data: { relationshipState: "preferred", preferred: true },
    });
    expect(set.ok()).toBe(true);
    const view = await set.json();
    expect(view.relationship.relationshipState).toBe("preferred");
    expect(Array.isArray(view.publicRoles)).toBe(true); // public roles present + distinct from state

    // Another account sees the same public org but NOT this account's relationship.
    const other = await playwright.request.newContext({ baseURL: baseURL! });
    await login(other, "lacey_glass_at_home");
    const otherView = await (await other.get(`/api/app/organizations/${orgId}/relationship`)).json();
    expect(otherView.relationship?.relationshipState ?? null).not.toBe("preferred");
    await other.dispose();
  });

  test("ROI scorecard, suppression, outcome, and admin correction", async ({ page, request }) => {
    await login(request, "solis_interiors");
    const scorecard = await (await request.get("/api/app/roi")).json();
    expect(typeof scorecard.opportunitiesDelivered).toBe("number");
    expect(scorecard.unsupportedFactCount).toBe(0);

    await page.context().addCookies(await request.storageState().then((s) => s.cookies));
    await page.goto("/app/roi");
    await expect(page.getByTestId("roi-table")).toBeVisible();
    await expect(page.getByTestId("unsupported-facts")).toBeVisible();

    // Suppression create + lift, and a non-attributed outcome.
    const list = await (await request.get("/api/app/opportunities?limit=1")).json();
    const oppId = list.items[0].id as string;
    const detail = await (await request.get(`/api/app/opportunities/${oppId}`)).json();
    const projectId = detail.project.id as string;

    const sup = await request.post("/api/app/suppressions", { data: { targetType: "project", targetId: projectId, reason: "e2e" } });
    expect(sup.status()).toBe(201);
    const supId = (await sup.json()).id as string;
    const del = await request.delete(`/api/app/suppressions/${supId}`);
    expect(del.ok()).toBe(true);

    const outcome = await request.post("/api/app/outcomes", { data: { opportunityId: oppId, outcomeType: "won", influencedByOtn: false } });
    expect(outcome.status()).toBe(201);

    // Admin-only immutable correction.
    await login(request, null, "admin");
    const corr = await request.post("/api/admin/corrections", { data: { correctionType: "unit_count", priorValue: 198, correctedValue: 180, reason: "e2e" } });
    expect(corr.status()).toBe(201);
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
