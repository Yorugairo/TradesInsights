import { NextResponse } from "next/server";
import { jsonError, withAdmin } from "../../../../../lib/api.js";
import { sourceRunDetail } from "../../../../../lib/queries.js";

// GET /api/admin/source-runs/{id} — full run metrics incl. dead-letter
// entries inside metrics_json.
export const GET = withAdmin<{ id: string }>(async ({ db, params }) => {
  const run = await sourceRunDetail(db, params.id);
  if (!run) return jsonError(404, "source run not found");
  return NextResponse.json(run);
});
