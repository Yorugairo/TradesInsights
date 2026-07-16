import { NextResponse } from "next/server";
import { jsonError, withAccount } from "../../../../../lib/api.js";
import { accountHasProject, projectDetail } from "../../../../../lib/queries.js";

// GET /api/app/projects/{id} — visible to an account only via one of its own
// opportunities (account isolation); admins see everything.
export const GET = withAccount<{ id: string }>(async ({ db, session, account, params }) => {
  if (session.role !== "admin") {
    const allowed = await accountHasProject(db, account.id, params.id);
    if (!allowed) return jsonError(404, "project not found");
  }
  const detail = await projectDetail(db, params.id);
  if (!detail) return jsonError(404, "project not found");
  return NextResponse.json(detail);
});
