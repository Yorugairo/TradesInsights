import { NextResponse } from "next/server";
import { listAccountOrganizations } from "@otn/intelligence";
import { withAccount } from "../../../../lib/api.js";

// GET /api/app/organizations — account-scoped org list (relationship state is
// this account's only; public roles come from the shared graph).
export const GET = withAccount(async ({ db, account }) => {
  const items = await listAccountOrganizations(db, account.id);
  return NextResponse.json({ items });
});
