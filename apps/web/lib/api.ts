import { NextResponse } from "next/server";
import { AuthError, requireAdmin, requireSession, type Session } from "./auth.js";
import { accountByKey, type AccountView } from "./queries.js";
import { db } from "./db.js";
import type { Db } from "@otn/db";

/**
 * Route-handler wrappers: authentication/role checks happen before the
 * handler body runs, and the handler receives the resolved account so every
 * query it makes is account-scoped by construction (spec §17).
 */

type Ctx<P> = { params: Promise<P> };

export function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

async function guard<T>(fn: () => Promise<T>): Promise<T | NextResponse> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AuthError) return jsonError(err.status, err.message);
    console.error(err);
    return jsonError(500, "internal error");
  }
}

/** Customer (or admin with an account context) — handler gets the session's account. */
export function withAccount<P = Record<string, never>>(
  handler: (args: { db: Db; session: Session; account: AccountView; params: P; req: Request }) => Promise<NextResponse>,
) {
  return async (req: Request, ctx: Ctx<P>): Promise<NextResponse> =>
    guard(async () => {
      const session = await requireSession();
      if (!session.accountKey) throw new AuthError(403, "session has no account context");
      const account = await accountByKey(db(), session.accountKey);
      if (!account) throw new AuthError(403, "unknown account");
      return handler({ db: db(), session, account, params: await ctx.params, req });
    }) as Promise<NextResponse>;
}

/** Admin-only routes. */
export function withAdmin<P = Record<string, never>>(
  handler: (args: { db: Db; session: Session; params: P; req: Request }) => Promise<NextResponse>,
) {
  return async (req: Request, ctx: Ctx<P>): Promise<NextResponse> =>
    guard(async () => {
      const session = await requireAdmin();
      return handler({ db: db(), session, params: await ctx.params, req });
    }) as Promise<NextResponse>;
}
