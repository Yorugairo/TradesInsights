import { NextResponse } from "next/server";
import { z } from "zod";
import { registryPool } from "../../../../../../lib/registry-db.js";
import { jsonError, withAdmin } from "../../../../../../lib/api.js";

/**
 * POST /api/admin/google-place-review/{review_id}/decision
 *
 * The queue row lives in the REGISTRY (`registry_internal`), which Insights must
 * never write. So a decision is INSERTed into the partner hand-off table and the
 * registry's own applier performs the guarded UPDATE — the registry keeps the last
 * word on its own queue, and a row another actor already resolved is never stomped.
 *
 * `dedupe_key` is `google_place:<review_id>` and UNIQUE, so a double-click or a
 * retried request records ONE decision. A replay still returns 200 (with
 * `alreadyDecided: true`) rather than a confusing error.
 */
const bodySchema = z.object({
  resolution: z.enum(["accepted", "rejected", "needs_evidence"]),
  note: z.string().max(1000).optional(),
});

export const POST = withAdmin<{ id: string }>(async ({ session, params, req }) => {
  const reviewId = Number(params.id);
  if (!Number.isInteger(reviewId) || reviewId <= 0) return jsonError(400, "invalid review id");

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "invalid decision body");

  // First interactive route that needs the registry seam: a batch-style silent
  // skip would leave the operator clicking into the void, so say so explicitly.
  const pool = registryPool();
  if (!pool) return jsonError(503, "registry seam offline (REGISTRY_DATABASE_URL is not set)");

  try {
    const res = await pool.query(
      `INSERT INTO registry_partner.partner_queue_decisions
         (source_system, queue_type, review_id, resolution, note, decided_by, dedupe_key)
       VALUES ('otn_insights', 'google_place', $1, $2, $3, $4, $5)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING decision_id`,
      [
        reviewId,
        parsed.data.resolution,
        parsed.data.note ?? null,
        `web:${session.accountKey ?? "admin"}`,
        `google_place:${reviewId}`,
      ],
    );
    const alreadyDecided = res.rows.length === 0;
    return NextResponse.json({
      ok: true,
      alreadyDecided,
      decisionId: alreadyDecided ? null : (res.rows[0] as { decision_id: string }).decision_id,
      // The queue row itself flips when the registry applier next runs.
      applied: false,
    });
  } catch (err) {
    return jsonError(500, err instanceof Error ? err.message : "decision failed");
  }
});
