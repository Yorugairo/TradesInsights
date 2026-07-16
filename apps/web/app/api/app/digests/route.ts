import { NextResponse } from "next/server";
import { withAccount } from "../../../../lib/api.js";
import { listDigests } from "../../../../lib/queries.js";

// GET /api/app/digests
export const GET = withAccount(async ({ db, account }) => {
  return NextResponse.json({ account: account.key, items: await listDigests(db, account.id) });
});
