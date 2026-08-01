import { NextResponse } from "next/server";
import {
  addFieldEntry,
  FieldError,
  getFieldBrief,
  touchFieldLink,
  verifyFieldToken,
} from "@otn/intelligence";
import { sendFieldChangeOrderNotification } from "@otn/delivery";
import { db } from "../../../../../lib/db.js";

/**
 * Crew submissions. Token-gated (the link is the credential — no session, no
 * withAccount): scope comes from the link row, never from the request body.
 * Hardening mirrors api/action/route.ts: per-IP limiter bounding
 * unauthenticated DB work, no-store, one neutral failure shape.
 */

const HEADERS = { "cache-control": "no-store, private", "referrer-policy": "no-referrer" } as const;

// Minimal per-IP limiter (pilot-scale; per-instance) — api/action precedent.
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

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }): Promise<NextResponse> {
  if (rateLimited(req)) {
    return NextResponse.json({ error: "too many requests" }, { status: 429, headers: HEADERS });
  }
  const { token } = await ctx.params;
  const verdict = await verifyFieldToken(db(), token);
  if (!verdict.ok) {
    return NextResponse.json({ error: "link unavailable" }, { status: 404, headers: HEADERS });
  }

  // The crew page posts plain HTML forms; JSON is accepted for tests/tools.
  let fields: Record<string, string> = {};
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    fields = Object.fromEntries(
      Object.entries(body).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, String(v)]),
    );
  } else {
    const form = await req.formData().catch(() => null);
    if (form) for (const [k, v] of form.entries()) if (typeof v === "string") fields[k] = v;
  }

  try {
    const entryType = fields["entryType"] ?? "";
    const { id, deduped } = await addFieldEntry(db(), {
      pursuitId: verdict.pursuitId,
      linkId: verdict.linkId,
      entryType,
      body: fields["body"] ?? "",
      quantities:
        entryType === "daily_log"
          ? { boards: fields["boards"] || null, tapedLf: fields["tapedLf"] || null, crewHours: fields["crewHours"] || null }
          : undefined,
      amount: fields["amount"] ? Number(fields["amount"]) : null,
      submittedName: fields["submittedName"] ?? null,
      // Device-minted idempotency key from the offline outbox (migration 0042).
      // Absent on the plain-HTML path, which is unchanged.
      clientEntryId: fields["clientEntryId"] ?? null,
    });
    await touchFieldLink(db(), verdict.linkId);

    // Change orders are money — notify the owner. Fire-and-forget: the entry
    // standing is the product, the email is a courtesy (SMTP is env-gated).
    //
    // NOT on a deduped replay: the entry already existed and the owner was
    // already told. An outbox that retried through a dropped response would
    // otherwise re-notify on every attempt, which turns a courtesy into a
    // pager.
    if (entryType === "change_order" && !deduped) {
      const brief = await getFieldBrief(db(), verdict.pursuitId);
      if (brief) {
        const base = (process.env.APP_BASE_URL ?? new URL(req.url).origin).replace(/\/$/, "");
        sendFieldChangeOrderNotification(db(), {
          accountProfileId: brief.accountProfileId,
          accountKey: brief.accountKey,
          entryId: id,
          pursuitId: brief.pursuitId,
          projectName: brief.projectName,
          body: fields["body"] ?? "",
          amount: fields["amount"] ? Number(fields["amount"]) : null,
          submittedName: fields["submittedName"] ?? null,
          baseUrl: base,
        }).catch((err) => console.error("field notify failed", err));
      }
    }

    // HTML form → redirect back to the page; JSON → 201.
    if (!contentType.includes("application/json")) {
      const back = new URL(`/field/${encodeURIComponent(token)}?ok=1`, req.url);
      return NextResponse.redirect(back, { status: 303 }) as NextResponse;
    }
    // `deduped` lets the outbox distinguish "stored just now" from "already
    // stored" — both are success and both must clear the queue entry. 200 vs
    // 201 says the same thing in status form.
    return NextResponse.json({ id, deduped }, { status: deduped ? 200 : 201, headers: HEADERS });
  } catch (err) {
    if (err instanceof FieldError) {
      return NextResponse.json({ error: err.message }, { status: 400, headers: HEADERS });
    }
    console.error(err);
    return NextResponse.json({ error: "internal error" }, { status: 500, headers: HEADERS });
  }
}
