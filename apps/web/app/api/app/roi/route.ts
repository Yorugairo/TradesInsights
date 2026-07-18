import { NextResponse } from "next/server";
import {
  detectionLagBySource,
  evidenceLeadTime,
  firstLookByCoverage,
  roiScorecard,
} from "@otn/delivery";
import { withAccount } from "../../../../lib/api.js";

// GET /api/app/roi[?days=90] — account-scoped scorecard reproduced from events,
// plus the #2 lead-time backtest (evidence lead per account, detection lag per
// source) and the first-look coverage proof (days-before-permit per source×county).
export const GET = withAccount(async ({ db, account, req }) => {
  const days = Number(new URL(req.url).searchParams.get("days") ?? "90");
  const end = new Date();
  const start = new Date(end.getTime() - (Number.isFinite(days) ? days : 90) * 86_400_000);
  const [scorecard, leadTime, detectionLag, firstLook] = await Promise.all([
    roiScorecard(db, account.id, { start, end }),
    evidenceLeadTime(db, account.id),
    detectionLagBySource(db),
    firstLookByCoverage(db),
  ]);
  return NextResponse.json({ ...scorecard, leadTime, detectionLag, firstLook });
});
