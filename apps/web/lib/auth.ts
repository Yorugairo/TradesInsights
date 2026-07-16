import "./env.js";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { requireEnv } from "./env.js";

/**
 * Pilot session auth: an HMAC-signed, HttpOnly cookie carrying the account
 * key and role. Login requires the shared pilot passphrase (AUTH_SECRET).
 * Every /api/app query is scoped to the session's account (spec §17 "apply
 * account/role authorization to every query"); admin routes require the
 * admin role. This is deliberately simple for the pilot — swapping in a real
 * identity provider only replaces this module.
 */

export const SESSION_COOKIE = "otn_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface Session {
  /** account_profiles.key — null for admin-only sessions. */
  accountKey: string | null;
  role: "customer" | "admin";
  exp: number;
}

function sign(payload: string): string {
  return createHmac("sha256", requireEnv("AUTH_SECRET")).update(payload).digest("base64url");
}

export function encodeSession(session: Session): string {
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function decodeSession(value: string | undefined): Session | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot < 0) return null;
  const payload = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  const expected = sign(payload);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString()) as Session;
    if (typeof session.exp !== "number" || session.exp < Date.now()) return null;
    if (session.role !== "customer" && session.role !== "admin") return null;
    return session;
  } catch {
    return null;
  }
}

export function newSession(accountKey: string | null, role: Session["role"]): Session {
  return { accountKey, role, exp: Date.now() + SESSION_TTL_MS };
}

export async function currentSession(): Promise<Session | null> {
  const store = await cookies();
  return decodeSession(store.get(SESSION_COOKIE)?.value);
}

export async function requireSession(): Promise<Session> {
  const session = await currentSession();
  if (!session) throw new AuthError(401, "not authenticated");
  return session;
}

export async function requireAdmin(): Promise<Session> {
  const session = await requireSession();
  if (session.role !== "admin") throw new AuthError(403, "admin role required");
  return session;
}

export class AuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}
