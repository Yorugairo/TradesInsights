import { NextResponse } from "next/server";
import { buildDecisionMemo, latestDecisionMemo, persistDecisionMemo } from "@otn/intelligence";
import { jsonError, withAccount } from "../../../../../../lib/api.js";

// GET /api/app/opportunities/{id}/decision-memo — account-scoped. Returns the
// latest persisted memo, generating v1 on first view. Ownership is enforced via
// the assembled memo's accountProfileId (an opportunity is only visible to its
// own account, spec §17).
export const GET = withAccount<{ id: string }>(async ({ db, account, params }) => {
  const built = await buildDecisionMemo(db, params.id);
  if (!built || built.accountProfileId !== account.id) return jsonError(404, "opportunity not found");
  const existing = await latestDecisionMemo(db, params.id);
  if (existing) return NextResponse.json(existing);
  const persisted = await persistDecisionMemo(db, params.id);
  return NextResponse.json(persisted!.memo);
});
