import { NextResponse } from "next/server";
import { jsonError, withAccount } from "../../../../../lib/api.js";
import { opportunityDetail } from "../../../../../lib/queries.js";

// GET /api/app/opportunities/{id} — account-scoped: an opportunity is only
// visible to the account it belongs to.
export const GET = withAccount<{ id: string }>(async ({ db, account, params }) => {
  const detail = await opportunityDetail(db, params.id, account.id);
  if (!detail) return jsonError(404, "opportunity not found");
  return NextResponse.json(detail);
});
