import { NextResponse } from "next/server";
import { addSuppression } from "@otn/intelligence";
import { jsonError, withAccount } from "../../../../lib/api.js";

// POST /api/app/suppressions — suppress a project or organization for this
// account. Suppression is applied before delivery assembly (§9).
export const POST = withAccount(async ({ db, account, session, req }) => {
  const body = (await req.json().catch(() => ({}))) as {
    targetType?: "project" | "organization";
    targetId?: string;
    reason?: string;
    expiresAt?: string;
  };
  if (!body.targetType || !body.targetId || !["project", "organization"].includes(body.targetType)) {
    return jsonError(400, "targetType (project|organization) and targetId required");
  }
  const { id } = await addSuppression(db, {
    accountProfileId: account.id,
    targetType: body.targetType,
    targetId: body.targetId,
    reason: body.reason ?? null,
    expiresAt: body.expiresAt ?? null,
    createdBy: session.accountKey ?? "account",
  });
  return NextResponse.json({ id }, { status: 201 });
});
