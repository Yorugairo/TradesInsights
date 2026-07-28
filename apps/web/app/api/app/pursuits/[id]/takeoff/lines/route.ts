import { NextResponse } from "next/server";
import {
  addManualLine,
  deleteLine,
  getOrCreateTakeoffSheet,
  getPursuitDetail,
  TakeoffError,
  updateLine,
} from "@otn/intelligence";
import { jsonError, withAccount } from "../../../../../../../lib/api.js";

function takeoffError(err: unknown): NextResponse {
  if (err instanceof TakeoffError) {
    const status = err.code === "not_found" || err.code === "line_not_found" ? 404 : 400;
    return jsonError(status, err.message);
  }
  throw err;
}

/** Ownership check + sheet handle shared by all three verbs. The sheet id is
 * NEVER taken from the request — it is resolved from the pursuit, so a line
 * can only ever be edited through a pursuit the account owns. */
async function sheetFor(db: Parameters<typeof getPursuitDetail>[0], accountId: string, pursuitId: string) {
  const p = await getPursuitDetail(db, pursuitId);
  if (!p || p.accountProfileId !== accountId) return null;
  return getOrCreateTakeoffSheet(db, {
    id: p.id,
    accountProfileId: p.accountProfileId,
    opportunityId: p.opportunityId,
  });
}

// POST — add a manual line.
export const POST = withAccount<{ id: string }>(async ({ db, account, params, req }) => {
  const sheet = await sheetFor(db, account.id, params.id);
  if (!sheet) return jsonError(404, "pursuit not found");
  const body = (await req.json().catch(() => ({}))) as {
    assemblyKey?: string; qty?: number; unitCost?: number; description?: string;
  };
  if (!body.assemblyKey || body.qty === undefined) return jsonError(400, "assemblyKey and qty required");
  try {
    const { id } = await addManualLine(db, sheet.id, {
      assemblyKey: body.assemblyKey,
      qty: body.qty,
      ...(body.unitCost !== undefined ? { unitCost: body.unitCost } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
    });
    return NextResponse.json({ id }, { status: 201 });
  } catch (err) {
    return takeoffError(err);
  }
});

// PATCH {lineId, qty?, unitCost?, description?} — any edit makes the line manual.
export const PATCH = withAccount<{ id: string }>(async ({ db, account, params, req }) => {
  const sheet = await sheetFor(db, account.id, params.id);
  if (!sheet) return jsonError(404, "pursuit not found");
  const body = (await req.json().catch(() => ({}))) as {
    lineId?: string; qty?: number; unitCost?: number; description?: string;
  };
  if (!body.lineId) return jsonError(400, "lineId required");
  try {
    await updateLine(db, sheet.id, body.lineId, {
      ...(body.qty !== undefined ? { qty: body.qty } : {}),
      ...(body.unitCost !== undefined ? { unitCost: body.unitCost } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return takeoffError(err);
  }
});

// DELETE {lineId}.
export const DELETE = withAccount<{ id: string }>(async ({ db, account, params, req }) => {
  const sheet = await sheetFor(db, account.id, params.id);
  if (!sheet) return jsonError(404, "pursuit not found");
  const body = (await req.json().catch(() => ({}))) as { lineId?: string };
  if (!body.lineId) return jsonError(400, "lineId required");
  try {
    await deleteLine(db, sheet.id, body.lineId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return takeoffError(err);
  }
});
