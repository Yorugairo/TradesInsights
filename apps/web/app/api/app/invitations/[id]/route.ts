import { NextResponse } from "next/server";
import { getInvitation } from "@otn/intelligence";
import { jsonError, withAccount } from "../../../../../lib/api.js";

// GET /api/app/invitations/{id} — one invitation + its append-only event
// history, account-scoped (a private invitation is only visible to its account).
export const GET = withAccount<{ id: string }>(async ({ db, account, params }) => {
  const inv = await getInvitation(db, params.id);
  if (!inv || inv.accountProfileId !== account.id) return jsonError(404, "invitation not found");
  return NextResponse.json({ summary: inv.summary, events: inv.events });
});
