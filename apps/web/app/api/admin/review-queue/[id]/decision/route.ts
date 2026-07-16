import { NextResponse } from "next/server";
import { z } from "zod";
import { decideReview } from "@otn/resolution";
import { jsonError, withAdmin } from "../../../../../../lib/api.js";

const bodySchema = z.object({
  decision: z.enum(["merge", "reject"]),
  note: z.string().max(1000).optional(),
});

// POST /api/admin/review-queue/{id}/decision — same workflow as the review
// CLI: merge joins the record to the candidate (decision=review_approved);
// reject closes the review and re-resolves with the candidate excluded.
export const POST = withAdmin<{ id: string }>(async ({ db, session, params, req }) => {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "invalid decision body");
  try {
    const outcome = await decideReview(db, params.id, parsed.data.decision, {
      decidedBy: `web:${session.accountKey ?? "admin"}`,
      ...(parsed.data.note ? { note: parsed.data.note } : {}),
    });
    return NextResponse.json({ ok: true, outcome });
  } catch (err) {
    return jsonError(409, err instanceof Error ? err.message : "decision failed");
  }
});
