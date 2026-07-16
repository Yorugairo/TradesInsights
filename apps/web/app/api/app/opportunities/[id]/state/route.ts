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

// POST /api/app/opportunities/{id}/state
export const POST = withAccount<{ id: string }>(async ({ db, session, account, params, req }) => {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "invalid state body");
  const { state, reason, notes } = parsed.data;

  const target = state === "rescore" ? "weekly_digest" : state;
  const updated = await db.execute(sql`
    UPDATE opportunities SET state = ${target}
    WHERE id = ${params.id} AND account_profile_id = ${account.id}
    RETURNING id`);
  if (updated.rows.length === 0) return jsonError(404, "opportunity not found");

  if (state === "dismissed" && (reason || notes)) {
    await db.execute(sql`
      INSERT INTO feedback (opportunity_id, user_id, relevant, disposition_reason, notes)
      VALUES (${params.id}, ${session.accountKey}, false, ${reason ?? null}, ${notes ?? null})`);
  }
  return NextResponse.json({ ok: true, state: target });
});
