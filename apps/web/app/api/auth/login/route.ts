import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { SESSION_COOKIE, encodeSession, newSession } from "../../../../lib/auth.js";
import { requireEnv } from "../../../../lib/env.js";
import { db } from "../../../../lib/db.js";
import { accountByKey } from "../../../../lib/queries.js";
import { jsonError } from "../../../../lib/api.js";

const bodySchema = z.object({
  password: z.string().min(1),
  accountKey: z.string().nullable().optional(),
  role: z.enum(["customer", "admin"]).default("customer"),
});

function secretMatches(candidate: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(requireEnv("AUTH_SECRET"));
  return a.length === b.length && timingSafeEqual(a, b);
}

// POST /api/auth/login — pilot shared-passphrase login. Customer sessions
// must name a real, active account; admin sessions may omit the account.
export async function POST(req: Request): Promise<NextResponse> {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "invalid login body");
  const { password, role } = parsed.data;
  const accountKey = parsed.data.accountKey ?? null;

  if (!secretMatches(password)) return jsonError(401, "invalid credentials");
  if (role === "customer") {
    if (!accountKey) return jsonError(400, "customer login requires accountKey");
    const account = await accountByKey(db(), accountKey);
    if (!account) return jsonError(401, "unknown or inactive account");
  } else if (accountKey) {
    const account = await accountByKey(db(), accountKey);
    if (!account) return jsonError(401, "unknown or inactive account");
  }

  const session = newSession(accountKey, role);
  const res = NextResponse.json({ ok: true, accountKey, role });
  res.cookies.set(SESSION_COOKIE, encodeSession(session), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 12 * 60 * 60,
  });
  return res;
}
