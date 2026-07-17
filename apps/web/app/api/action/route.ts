import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { consumeActionToken, peekActionToken } from "@otn/delivery";
import { createPursuit } from "@otn/intelligence";
import { db } from "../../../lib/db.js";

/**
 * P2.3 — one-tap email actions (hardened per security review):
 * - GET is SAFE and replayable: it only renders a confirmation page — mail
 *   security gateways prefetch every emailed link, so a GET must never
 *   consume the token or mutate anything.
 * - POST (the confirm button) atomically consumes the single-use token and
 *   applies the effect through the same audited paths as the logged-in UI.
 * - Responses are no-store + no-referrer; a small per-IP limiter bounds
 *   unauthenticated DB work; HTML is escaped by construction.
 */

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store, private",
  "referrer-policy": "no-referrer",
} as const;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function page(title: string, bodyHtml: string, status = 200): NextResponse {
  return new NextResponse(
    `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)}</title>
<body style="font-family:sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem">
<h2>${esc(title)}</h2>${bodyHtml}
<p><a href="/app/opportunities">Open OTN Insights</a></p></body>`,
    { status, headers: HEADERS },
  ) as NextResponse;
}

const FAIL_PAGES = {
  invalid: { title: "Link unavailable", body: "<p>This link is not valid.</p>", status: 400 },
  expired: {
    title: "Link expired",
    body: "<p>This link has expired — open the app to act on the opportunity.</p>",
    status: 410,
  },
  already_used: {
    title: "Already done",
    body: "<p>This action was already recorded — nothing more to do.</p>",
    status: 410,
  },
} as const;

// Minimal per-IP limiter (pilot-scale; per-instance). Bounds unauthenticated
// DB work from scanners/abuse — 30 requests/min/IP.
const hits = new Map<string, { n: number; windowStart: number }>();
function rateLimited(req: Request): boolean {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.windowStart > 60_000) {
    hits.set(ip, { n: 1, windowStart: now });
    return false;
  }
  h.n++;
  if (hits.size > 10_000) hits.clear(); // memory bound
  return h.n > 30;
}

const ACTION_LABELS = { pursue: "Pursue this opportunity", dismiss: "Mark not relevant" } as const;

/** SAFE: renders the confirmation page only. Never consumes, never mutates. */
export async function GET(req: Request): Promise<NextResponse> {
  if (rateLimited(req)) return page("Slow down", "<p>Too many requests.</p>", 429);
  const t = new URL(req.url).searchParams.get("t") ?? "";
  const peek = await peekActionToken(db(), t);
  if (!peek.ok) {
    const f = FAIL_PAGES[peek.reason];
    return page(f.title, f.body, f.status);
  }
  return page(
    "Confirm",
    `<p>Tap to confirm: <strong>${esc(ACTION_LABELS[peek.action])}</strong>.</p>
<form method="post" action="/api/action">
  <input type="hidden" name="t" value="${esc(t)}"/>
  <button type="submit" style="font-size:1.2rem;padding:0.6rem 1.4rem">${esc(ACTION_LABELS[peek.action])}</button>
</form>
<p style="color:#666">If you didn't mean to open this, just close the page — nothing has happened yet.</p>`,
  );
}

/** Mutating step: consumes the single-use token, applies the audited effect. */
export async function POST(req: Request): Promise<NextResponse> {
  if (rateLimited(req)) return page("Slow down", "<p>Too many requests.</p>", 429);
  const form = await req.formData().catch(() => null);
  const t = typeof form?.get("t") === "string" ? (form.get("t") as string) : "";
  const result = await consumeActionToken(db(), t);
  if (!result.ok) {
    const f = FAIL_PAGES[result.reason];
    return page(f.title, f.body, f.status);
  }

  const { action, accountProfileId, opportunityId } = result;
  if (action === "pursue") {
    const existing = await db().execute(sql`
      SELECT id FROM pursuits
      WHERE account_profile_id = ${accountProfileId} AND opportunity_id = ${opportunityId}`);
    if (existing.rows.length === 0) {
      await createPursuit(db(), { accountProfileId, opportunityId, ownerUserId: "email-one-tap" });
    }
    return page(
      "✓ Pursuing",
      "<p>Added to your pursuit board (state: discovered). Assign an owner and next step in the app.</p>",
    );
  }

  // dismiss — sticky manual state + a controlled-disposition feedback row.
  await db().execute(sql`
    UPDATE opportunities SET state = 'dismissed'
    WHERE id = ${opportunityId} AND account_profile_id = ${accountProfileId}`);
  await db().execute(sql`
    INSERT INTO feedback (opportunity_id, user_id, relevant, disposition_reason, notes)
    VALUES (${opportunityId}, 'email-one-tap', false, 'other', 'one-tap email dismiss')`);
  return page(
    "✗ Dismissed",
    "<p>Marked not relevant — this improves next week's picks. You can undo from the app (rescore).</p>",
  );
}
