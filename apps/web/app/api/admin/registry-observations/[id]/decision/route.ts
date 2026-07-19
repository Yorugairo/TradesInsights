import { NextResponse } from "next/server";
import { z } from "zod";
import { decideRegistryObservation } from "@otn/resolution";
import { jsonError, withAdmin } from "../../../../../../lib/api.js";

const bodySchema = z.object({
  decision: z.enum(["accept", "reject"]),
  note: z.string().max(1000).optional(),
});

// POST /api/admin/registry-observations/{id}/decision — accept applies the
// local side effect immediately (bind organization / create global contact;
// export types queue for the nightly push to registry_partner). Every decision
// feeds the rule's accept history for the next generation pass.
export const POST = withAdmin<{ id: string }>(async ({ db, session, params, req }) => {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "invalid decision body");
  try {
    const outcome = await decideRegistryObservation(db, params.id, parsed.data.decision, {
      decidedBy: `web:${session.accountKey ?? "admin"}`,
      ...(parsed.data.note ? { note: parsed.data.note } : {}),
    });
    return NextResponse.json({ ok: true, outcome });
  } catch (err) {
    return jsonError(409, err instanceof Error ? err.message : "decision failed");
  }
});
