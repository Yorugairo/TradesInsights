import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { jsonError, withAccount } from "../../../../../../lib/api.js";

const bodySchema = z.object({
  relevant: z.boolean().nullable().optional(),
  newToCustomer: z.boolean().nullable().optional(),
  timely: z.boolean().nullable().optional(),
  worthPursuing: z.boolean().nullable().optional(),
  dispositionReason: z.string().max(500).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
});

// POST /api/app/opportunities/{id}/feedback — spec §16/§17: relevant / new /
// timely / pursue plus a disposition reason. Feedback is recorded, never
// auto-applied to rules (spec §12: rule changes are explicit new versions).
export const POST = withAccount<{ id: string }>(async ({ db, session, account, params, req }) => {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "invalid feedback body");

  const owns = await db.execute(sql`
    SELECT 1 FROM opportunities
    WHERE id = ${params.id} AND account_profile_id = ${account.id}`);
  if (owns.rows.length === 0) return jsonError(404, "opportunity not found");

  const b = parsed.data;
  const inserted = await db.execute(sql`
    INSERT INTO feedback
      (opportunity_id, user_id, relevant, new_to_customer, timely, worth_pursuing,
       disposition_reason, notes)
    VALUES
      (${params.id}, ${session.accountKey}, ${b.relevant ?? null}, ${b.newToCustomer ?? null},
       ${b.timely ?? null}, ${b.worthPursuing ?? null}, ${b.dispositionReason ?? null},
       ${b.notes ?? null})
    RETURNING id`);
  return NextResponse.json({ ok: true, feedbackId: (inserted.rows[0] as { id: string }).id });
});
