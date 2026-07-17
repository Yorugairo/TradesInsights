import { NextResponse } from "next/server";
import { listAccountOrganizations, orgActivityRollup, relationshipTargets } from "@otn/intelligence";
import { withAccount } from "../../../../lib/api.js";

// GET /api/app/organizations[?view=league|targets&county=&flagged=1&min=2]
// Account-scoped. Default view keeps the S4 list; 'league' returns the P1
// activity rollup; 'targets' returns the relationship-play generator.
export const GET = withAccount(async ({ db, account, req }) => {
  const p = new URL(req.url).searchParams;
  const view = p.get("view") ?? "list";
  if (view === "league") {
    const items = await orgActivityRollup(db, {
      accountProfileId: account.id,
      ...(p.get("county") ? { county: p.get("county")! } : {}),
      includeFlagged: p.get("flagged") === "1",
      ...(p.get("min") ? { minProjects: Number(p.get("min")) } : {}),
    });
    return NextResponse.json({ items });
  }
  if (view === "targets") {
    const items = await relationshipTargets(db, account.id, {
      ...(p.get("min") ? { minRelevantProjects: Number(p.get("min")) } : {}),
    });
    return NextResponse.json({ items });
  }
  const items = await listAccountOrganizations(db, account.id);
  return NextResponse.json({ items });
});
