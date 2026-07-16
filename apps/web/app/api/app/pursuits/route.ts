import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { createPursuit, listPursuits, type PursuitState } from "@otn/intelligence";
import { jsonError, withAccount } from "../../../../lib/api.js";

// GET /api/app/pursuits[?state=] — account-scoped board list.
export const GET = withAccount(async ({ db, account, req }) => {
  const state = new URL(req.url).searchParams.get("state") as PursuitState | null;
  const items = await listPursuits(db, account.id, state ? { state } : {});
  return NextResponse.json({ items });
});

// POST /api/app/pursuits — open a pursuit for one of the account's opportunities.
export const POST = withAccount(async ({ db, account, session, req }) => {
  const body = (await req.json().catch(() => ({}))) as { opportunityId?: string; priority?: number };
  if (!body.opportunityId) return jsonError(400, "opportunityId required");
  const owns = await db.execute(
    sql`SELECT 1 FROM opportunities WHERE id = ${body.opportunityId} AND account_profile_id = ${account.id}`,
  );
  if (owns.rows.length === 0) return jsonError(404, "opportunity not found");
  // Idempotent: one pursuit per (account, opportunity) — return the existing one.
  const existing = await db.execute(
    sql`SELECT id FROM pursuits WHERE account_profile_id = ${account.id} AND opportunity_id = ${body.opportunityId}`,
  );
  if (existing.rows.length > 0) {
    return NextResponse.json({ id: (existing.rows[0] as { id: string }).id, existing: true });
  }
  const { id } = await createPursuit(db, {
    accountProfileId: account.id,
    opportunityId: body.opportunityId,
    ownerUserId: session.accountKey ?? "account",
    priority: body.priority ?? null,
  });
  return NextResponse.json({ id }, { status: 201 });
});
