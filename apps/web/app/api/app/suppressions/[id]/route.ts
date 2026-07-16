import { NextResponse } from "next/server";
import { removeSuppression } from "@otn/intelligence";
import { jsonError, withAccount } from "../../../../../lib/api.js";

// DELETE /api/app/suppressions/{id} — lift a suppression (account-scoped).
export const DELETE = withAccount<{ id: string }>(async ({ db, account, params }) => {
  const ok = await removeSuppression(db, account.id, params.id);
  if (!ok) return jsonError(404, "suppression not found");
  return NextResponse.json({ removed: true });
});
