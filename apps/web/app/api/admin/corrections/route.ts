import { NextResponse } from "next/server";
import { addCorrection } from "@otn/intelligence";
import { jsonError, withAdmin } from "../../../../lib/api.js";

// POST /api/admin/corrections — append an immutable correction (§9). Admin-only.
// A correction is a new row; evidence and prior corrections are never mutated.
export const POST = withAdmin(async ({ db, session, req }) => {
  const body = (await req.json().catch(() => ({}))) as {
    evidenceItemId?: string;
    opportunityId?: string;
    correctionType?: string;
    priorValue?: unknown;
    correctedValue?: unknown;
    reason?: string;
    sourceRecordId?: string;
  };
  if (!body.correctionType) return jsonError(400, "correctionType required");
  const { id } = await addCorrection(db, {
    evidenceItemId: body.evidenceItemId ?? null,
    opportunityId: body.opportunityId ?? null,
    correctionType: body.correctionType,
    priorValue: body.priorValue,
    correctedValue: body.correctedValue,
    reason: body.reason ?? null,
    sourceRecordId: body.sourceRecordId ?? null,
    createdBy: `admin:${session.accountKey ?? "admin"}`,
  });
  return NextResponse.json({ id }, { status: 201 });
});
