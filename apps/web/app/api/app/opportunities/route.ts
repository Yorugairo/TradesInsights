import { NextResponse } from "next/server";
import { withAccount } from "../../../../lib/api.js";
import { listOpportunities } from "../../../../lib/queries.js";

// GET /api/app/opportunities?state=&county=&stage=&q=&campus=1&sort=&limit=&offset=
// Batch3 #2 — filter/search/sort/pagination; response carries total for paging.
export const GET = withAccount(async ({ db, account, req }) => {
  const p = new URL(req.url).searchParams;
  const num = (k: string) => (p.get(k) ? Number(p.get(k)) : undefined);
  const { items, total } = await listOpportunities(db, account.id, {
    ...(p.get("state") ? { state: p.get("state")! } : {}),
    ...(p.get("county") ? { county: p.get("county")! } : {}),
    ...(p.get("stage") ? { stage: p.get("stage")! } : {}),
    ...(p.get("q") ? { q: p.get("q")! } : {}),
    ...(p.get("campus") === "1" ? { campusOnly: true } : {}),
    ...(p.get("sort") === "recent" ? { sort: "recent" as const } : {}),
    ...(num("limit") !== undefined && Number.isFinite(num("limit")) ? { limit: num("limit")! } : {}),
    ...(num("offset") !== undefined && Number.isFinite(num("offset")) ? { offset: num("offset")! } : {}),
  });
  return NextResponse.json({ account: account.key, total, items });
});
