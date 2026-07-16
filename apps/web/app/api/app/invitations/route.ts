import { NextResponse } from "next/server";
import { withAccount } from "../../../../lib/api.js";
import { listAccountInvitations } from "../../../../lib/queries.js";

// GET /api/app/invitations — the account's OWN private bid invitations
// (M4.6). Query is scoped by sources.account_profile_id; every read is
// access-audited (spec §20).
export const GET = withAccount(async ({ db, session, account }) => {
  const items = await listAccountInvitations(db, account.id, `web:${session.accountKey}`);
  return NextResponse.json({ account: account.key, items });
});
