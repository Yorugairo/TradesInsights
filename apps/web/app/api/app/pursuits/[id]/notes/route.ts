import { NextResponse } from "next/server";
import { addPursuitNote, getPursuitDetail } from "@otn/intelligence";
import { jsonError, withAccount } from "../../../../../../lib/api.js";

// POST /api/app/pursuits/{id}/notes — attach a note.
export const POST = withAccount<{ id: string }>(async ({ db, account, session, params, req }) => {
  const detail = await getPursuitDetail(db, params.id);
  if (!detail || detail.accountProfileId !== account.id) return jsonError(404, "pursuit not found");
  const body = (await req.json().catch(() => ({}))) as { body?: string; visibility?: string };
  if (!body.body?.trim()) return jsonError(400, "body required");
  const { id } = await addPursuitNote(db, params.id, {
    authorUserId: session.accountKey ?? "account",
    body: body.body,
    visibility: body.visibility ?? "account",
  });
  return NextResponse.json({ id }, { status: 201 });
});
