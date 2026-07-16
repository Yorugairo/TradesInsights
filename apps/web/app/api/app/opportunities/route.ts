import { NextResponse } from "next/server";
import { withAccount } from "../../../../lib/api.js";
import { listOpportunities } from "../../../../lib/queries.js";

// GET /api/app/opportunities?state=&limit=
export const GET = withAccount(async ({ db, account, req }) => {
  const url = new URL(req.url);
  const state = url.searchParams.get("state") ?? undefined;
  const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined;
  const items = await listOpportunities(db, account.id, {
    ...(state ? { state } : {}),
    ...(limit ? { limit } : {}),
  });
  return NextResponse.json({ account: account.key, items });
});
