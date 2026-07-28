import { NextResponse } from "next/server";
import { decideChangeOrder, FieldError, getPursuitDetail } from "@otn/intelligence";
import { jsonError, withAccount } from "../../../../../../../../lib/api.js";

// POST /api/app/pursuits/{id}/field-entries/{entryId}/decision {decision}
// Approve/reject a field-submitted change order. Second decision is a 409 —
// the service guards on status='submitted' so two taps cannot both land.
export const POST = withAccount<{ id: string; entryId: string }>(
  async ({ db, account, session, params, req }) => {
    const p = await getPursuitDetail(db, params.id);
    if (!p || p.accountProfileId !== account.id) return jsonError(404, "pursuit not found");
    const body = (await req.json().catch(() => ({}))) as { decision?: string };
    if (body.decision !== "approved" && body.decision !== "rejected") {
      return jsonError(400, "decision must be 'approved' or 'rejected'");
    }
    try {
      await decideChangeOrder(db, p.id, params.entryId, body.decision, session.accountKey ?? "account");
      return NextResponse.json({ ok: true });
    } catch (err) {
      if (err instanceof FieldError) {
        const status =
          err.code === "not_found" ? 404 : err.code === "already_decided" ? 409 : 400;
        return jsonError(status, err.message);
      }
      throw err;
    }
  },
);
