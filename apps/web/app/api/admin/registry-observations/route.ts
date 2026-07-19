import { NextResponse } from "next/server";
import { listRegistryObservations } from "@otn/resolution";
import { withAdmin } from "../../../../lib/api.js";

// GET /api/admin/registry-observations[?status=pending&limit=10] — the
// operator's registry review queue, highest deterministic trust first.
export const GET = withAdmin(async ({ db, req }) => {
  const p = new URL(req.url).searchParams;
  const items = await listRegistryObservations(db, {
    status: p.get("status") ?? "pending",
    ...(p.get("limit") ? { limit: Number(p.get("limit")) } : {}),
  });
  return NextResponse.json({ items });
});
