import { NextResponse } from "next/server";
import { buildDecisionMemo, persistDecisionMemo } from "@otn/intelligence";
import { jsonError, withAccount } from "../../../../../../lib/api.js";

// POST /api/app/opportunities/{id}/regenerate-memo — rebuild the memo from
// current stored evidence. Idempotent: a new version is written only when the
// content changed. Account-scoped via the assembled memo's accountProfileId.
export const POST = withAccount<{ id: string }>(async ({ db, account, params }) => {
  const built = await buildDecisionMemo(db, params.id);
  if (!built || built.accountProfileId !== account.id) return jsonError(404, "opportunity not found");
  const persisted = await persistDecisionMemo(db, params.id);
  return NextResponse.json({
    decisionVersion: persisted!.decisionVersion,
    created: persisted!.created,
    memo: persisted!.memo,
  });
});
