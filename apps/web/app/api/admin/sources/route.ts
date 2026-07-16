import { NextResponse } from "next/server";
import { withAdmin } from "../../../../lib/api.js";
import { listSourcesAdmin } from "../../../../lib/queries.js";

// GET /api/admin/sources
export const GET = withAdmin(async ({ db }) => {
  return NextResponse.json({ items: await listSourcesAdmin(db) });
});
