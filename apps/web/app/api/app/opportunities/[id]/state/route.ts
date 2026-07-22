import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DISPOSITION_REASONS } from "@otn/intelligence";
import { jsonError, withAccount } from "../../../../../../lib/api.js";

const bodySchema = z.object({
  // Manual states are sticky (scoring never clobbers them); "rescore" hands
  // the state back to the scoring bands on the next score run.
  state: z.enum(["promoted", "dismissed", "rescore"]),
  // Dismissals carry a controlled disposition reason (free text → notes).
  reason: z.enum(DISPOSITION_REASONS).optional(),
  notes: z.string().max(1000).optional(),
});

/** Body state → decision_labels.kind (CHECK-constrained, migration 0027). */
const LABEL_KIND: Record<string, string> = {
  promoted: "promote",
  dismissed: "dismiss",
  rescore: "rescore",
};

// POST /api/app/opportunities/{id}/state
export const POST = withAccount<{ id: string }>(async ({ db, session, account, params, req }) => {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "invalid state body");
  const { state, reason, notes } = parsed.data;

  // Phase 1 flywheel — snapshot BEFORE the update: the calibration label must
  // record what the human actually saw when deciding (score, band, signals,
  // corroboration), never a later re-derivation.
  const seen = await db.execute(sql`
    SELECT o.state AS prior_state, o.current_score, o.route, o.score_version,
           o.rationale_json -> 'signals' AS signals,
           p.county, p.current_stage, p.corroboration
    FROM opportunities o JOIN projects p ON p.id = o.project_id
    WHERE o.id = ${params.id} AND o.account_profile_id = ${account.id}`);
  if (seen.rows.length === 0) return jsonError(404, "opportunity not found");
  const s = seen.rows[0] as Record<string, unknown>;

  const target = state === "rescore" ? "weekly_digest" : state;
  await db.execute(sql`
    UPDATE opportunities SET state = ${target}
    WHERE id = ${params.id} AND account_profile_id = ${account.id}`);

  // Append-only label — EVERY decision (promotes included; they were
  // previously unrecorded, evaporating exactly the labels §12.3 calibration
  // needs most).
  const snapshot = {
    priorState: s["prior_state"] ?? null,
    score: s["current_score"] ?? null,
    route: s["route"] ?? null,
    scoreVersion: s["score_version"] ?? null,
    signals: s["signals"] ?? [],
    county: s["county"] ?? null,
    stage: s["current_stage"] ?? null,
    corroboration: s["corroboration"] ?? null,
  };
  await db.execute(sql`
    INSERT INTO decision_labels (account_profile_id, opportunity_id, kind, decided_by, snapshot, reason, notes)
    VALUES (${account.id}, ${params.id}, ${LABEL_KIND[state]}, ${session.accountKey},
            ${JSON.stringify(snapshot)}, ${reason ?? null}, ${notes ?? null})`);

  if (state === "dismissed" && (reason || notes)) {
    await db.execute(sql`
      INSERT INTO feedback (opportunity_id, user_id, relevant, disposition_reason, notes)
      VALUES (${params.id}, ${session.accountKey}, false, ${reason ?? null}, ${notes ?? null})`);
  }
  return NextResponse.json({ ok: true, state: target });
});
