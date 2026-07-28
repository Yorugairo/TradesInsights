import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { SESSION_COOKIE, encodeSession, newSession, type Session } from "../../../../lib/auth.js";
import { requireEnv } from "../../../../lib/env.js";
import { db } from "../../../../lib/db.js";
import { accountByKey } from "../../../../lib/queries.js";
import { verifySsoToken } from "../../../../lib/sso.js";

/**
 * GET /api/auth/sso?token=… — the OTN → Insights sign-in handoff.
 *
 * Alongside /login and /api/auth/login, this is the only route reachable
 * without a session, so its order of operations IS its security:
 *
 *   1. verify the signature   (never parse unauthenticated JSON first)
 *   2. consume the jti        (an INSERT; the unique violation is the refusal)
 *   3. re-validate the account (signed ≠ still active — accounts get disabled)
 *   4. decide the role        (customer unless explicitly allowlisted)
 *   5. set the session cookie and redirect
 *
 * EVERY refusal is a redirect to /login with a plain-language message. A
 * stack trace or a bare 401 would tell a human nothing about what to do, and
 * the honest instruction is always the same: go back to OTN and click again.
 *
 * ROLE. A tenant owner is a CUSTOMER here, never an admin, regardless of their
 * role inside OTN — /app/admin/* shows corporate-family principal names, which
 * are private individuals. Admin sessions require the Supabase user id to be
 * listed in INSIGHTS_SSO_ADMIN_USER_IDS on this side, so OTN cannot promote
 * anyone by asserting it.
 */

export const dynamic = "force-dynamic";

/** Old rows serve no purpose: tokens live 60 seconds, so a day is generous. */
const CONSUMED_RETENTION = sql`interval '1 day'`;

function refuse(req: Request, message: string): NextResponse {
  const url = new URL("/login", req.url);
  url.searchParams.set("message", message);
  return NextResponse.redirect(url);
}

const EXPIRED_MESSAGE =
  "That sign-in link has expired. Open Insights again from your OneTradeNetwork dashboard.";
const INVALID_MESSAGE =
  "That sign-in link is not valid. Open Insights again from your OneTradeNetwork dashboard.";

export async function GET(req: Request): Promise<NextResponse> {
  const token = new URL(req.url).searchParams.get("token");
  const verified = verifySsoToken(token, { secret: requireEnv("INSIGHTS_SSO_SECRET") });
  if (!verified.ok) {
    console.warn(JSON.stringify({ at: "sso", outcome: `token_${verified.reason}` }));
    return refuse(req, verified.reason === "expired" ? EXPIRED_MESSAGE : INVALID_MESSAGE);
  }
  const { accountKey, tenantId, sub, jti } = verified.claims;

  // Single-use. The INSERT is the claim: a duplicate jti raises a unique
  // violation, which IS the replay refusal — race-free in a way a
  // read-then-write check is not (mirrors the atomic claim in
  // delivery/src/actions.ts).
  try {
    await db().execute(sql`INSERT INTO sso_consumed (jti) VALUES (${jti})`);
  } catch (err) {
    const code = (err as { cause?: { code?: string }; code?: string }).cause?.code
      ?? (err as { code?: string }).code;
    if (code === "23505") {
      console.warn(JSON.stringify({ at: "sso", outcome: "replayed", accountKey, tenantId, sub }));
      return refuse(req, EXPIRED_MESSAGE);
    }
    throw err;
  }
  // Opportunistic prune — no maintenance-chain step for a table this small.
  // Deliberately after a SUCCESSFUL claim so a failing prune cannot block a
  // sign-in; its own failure is swallowed for the same reason.
  void db()
    .execute(sql`DELETE FROM sso_consumed WHERE consumed_at < now() - ${CONSUMED_RETENTION}`)
    .catch(() => {});

  // Signed is not the same as still valid: an account can be deactivated after
  // a token is minted, and the login route makes the same check for the same
  // reason.
  const account = await accountByKey(db(), accountKey);
  if (!account) {
    console.warn(JSON.stringify({ at: "sso", outcome: "unknown_account", accountKey, tenantId, sub }));
    return refuse(req, "That account is not active in Insights. Contact your account manager.");
  }

  const adminIds = (process.env.INSIGHTS_SSO_ADMIN_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const role: Session["role"] = adminIds.includes(sub) ? "admin" : "customer";

  const session = newSession(accountKey, role);
  const destination = role === "admin" ? "/app/admin/cockpit" : "/app/opportunities";
  const res = NextResponse.redirect(new URL(destination, req.url));
  res.cookies.set(SESSION_COOKIE, encodeSession(session), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 12 * 60 * 60,
  });
  console.log(JSON.stringify({ at: "sso", outcome: "ok", accountKey, tenantId, sub, role }));
  return res;
}
