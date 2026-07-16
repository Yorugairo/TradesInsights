import { NextResponse } from "next/server";
import { listPendingReviews } from "@otn/resolution";
import { withAdmin } from "../../../../lib/api.js";

// GET /api/admin/review-queue — pending ambiguous resolution matches (M2.5).
export const GET = withAdmin(async ({ db }) => {
  return NextResponse.json({ items: await listPendingReviews(db) });
});
