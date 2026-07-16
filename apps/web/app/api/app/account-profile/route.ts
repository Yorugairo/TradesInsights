import { NextResponse } from "next/server";
import { withAccount } from "../../../../lib/api.js";
import { accountRules } from "../../../../lib/queries.js";

// GET /api/app/account-profile — the account's profile plus the latest
// version of each rule (rules are append-only; see spec §12).
export const GET = withAccount(async ({ db, account }) => {
  return NextResponse.json({ ...account, rules: await accountRules(db, account.id) });
});
