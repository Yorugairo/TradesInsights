import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { addOutcome } from "@otn/delivery";
import { jsonError, withAccount } from "../../../../lib/api.js";

// POST /api/app/outcomes — record a human-attributed outcome. Attributable
// revenue is only counted when influencedByOtn is explicitly true.
export const POST = withAccount(async ({ db, account, session, req }) => {
  const body = (await req.json().catch(() => ({}))) as {
    opportunityId?: string;
    outcomeType?: string;
    influencedByOtn?: boolean;
    attributableValue?: number;
    reasonCode?: string;
  };
  if (!body.opportunityId || !body.outcomeType) return jsonError(400, "opportunityId and outcomeType required");
  const owns = await db.execute(
    sql`SELECT 1 FROM opportunities WHERE id = ${body.opportunityId} AND account_profile_id = ${account.id}`,
  );
  if (owns.rows.length === 0) return jsonError(404, "opportunity not found");
  const { id } = await addOutcome(db, {
    opportunityId: body.opportunityId,
    outcomeType: body.outcomeType,
    influencedByOtn: body.influencedByOtn === true,
    attributableValue: body.attributableValue ?? null,
    reasonCode: body.reasonCode ?? null,
    createdBy: session.accountKey ?? "account",
  });
  return NextResponse.json({ id }, { status: 201 });
});
