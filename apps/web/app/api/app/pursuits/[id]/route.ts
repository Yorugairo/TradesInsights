import { NextResponse } from "next/server";
import { getPursuitDetail } from "@otn/intelligence";
import { jsonError, withAccount } from "../../../../../lib/api.js";

// GET /api/app/pursuits/{id} — account-scoped via the pursuit's accountProfileId.
export const GET = withAccount<{ id: string }>(async ({ db, account, params }) => {
  const detail = await getPursuitDetail(db, params.id);
  if (!detail || detail.accountProfileId !== account.id) return jsonError(404, "pursuit not found");
  return NextResponse.json(detail);
});
