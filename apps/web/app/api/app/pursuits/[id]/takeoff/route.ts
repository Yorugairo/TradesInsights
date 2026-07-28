import { NextResponse } from "next/server";
import {
  getOrCreateTakeoffSheet,
  getPursuitDetail,
  rederiveSheet,
  stampEstimate,
  TakeoffError,
  updateSheetMeta,
} from "@otn/intelligence";
import { jsonError, withAccount } from "../../../../../../lib/api.js";

/** TakeoffError → HTTP. Mirrors how the transition route maps PursuitError. */
function takeoffError(err: unknown): NextResponse {
  if (err instanceof TakeoffError) {
    const status =
      err.code === "not_found" || err.code === "line_not_found" ? 404
      : err.code === "sheet_final" ? 409
      : 400;
    return jsonError(status, err.message);
  }
  throw err;
}

// GET /api/app/pursuits/{id}/takeoff — the sheet, derived on first call.
export const GET = withAccount<{ id: string }>(async ({ db, account, params }) => {
  const p = await getPursuitDetail(db, params.id);
  if (!p || p.accountProfileId !== account.id) return jsonError(404, "pursuit not found");
  const sheet = await getOrCreateTakeoffSheet(db, {
    id: p.id,
    accountProfileId: p.accountProfileId,
    opportunityId: p.opportunityId,
  });
  return NextResponse.json({ sheet });
});

// POST {action:'rederive'} — refresh derived lines (manual lines untouched).
export const POST = withAccount<{ id: string }>(async ({ db, account, params, req }) => {
  const p = await getPursuitDetail(db, params.id);
  if (!p || p.accountProfileId !== account.id) return jsonError(404, "pursuit not found");
  const body = (await req.json().catch(() => ({}))) as { action?: string };
  if (body.action !== "rederive") return jsonError(400, "action must be 'rederive'");
  try {
    const sheet = await rederiveSheet(db, { id: p.id, opportunityId: p.opportunityId });
    return NextResponse.json({ sheet });
  } catch (err) {
    return takeoffError(err);
  }
});

// PATCH — sheet meta (waste/overhead/margin/status) or {action:'stamp-estimate'}.
export const PATCH = withAccount<{ id: string }>(async ({ db, account, session, params, req }) => {
  const p = await getPursuitDetail(db, params.id);
  if (!p || p.accountProfileId !== account.id) return jsonError(404, "pursuit not found");
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    wastePct?: number;
    overheadPct?: number;
    marginPct?: number;
    status?: "draft" | "final";
  };
  try {
    if (body.action === "stamp-estimate") {
      const { bidPrice } = await stampEstimate(db, { id: p.id }, session.accountKey ?? "account");
      return NextResponse.json({ bidPrice });
    }
    const sheet = await getOrCreateTakeoffSheet(db, {
      id: p.id,
      accountProfileId: p.accountProfileId,
      opportunityId: p.opportunityId,
    });
    await updateSheetMeta(db, sheet.id, {
      ...(body.wastePct !== undefined ? { wastePct: body.wastePct } : {}),
      ...(body.overheadPct !== undefined ? { overheadPct: body.overheadPct } : {}),
      ...(body.marginPct !== undefined ? { marginPct: body.marginPct } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return takeoffError(err);
  }
});
