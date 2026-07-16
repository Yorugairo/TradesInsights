import { NextResponse } from "next/server";
import { roiScorecard } from "@otn/delivery";
import { withAccount } from "../../../../lib/api.js";

// GET /api/app/roi[?days=90] — account-scoped scorecard reproduced from events.
export const GET = withAccount(async ({ db, account, req }) => {
  const days = Number(new URL(req.url).searchParams.get("days") ?? "90");
  const end = new Date();
  const start = new Date(end.getTime() - (Number.isFinite(days) ? days : 90) * 86_400_000);
  return NextResponse.json(await roiScorecard(db, account.id, { start, end }));
});
