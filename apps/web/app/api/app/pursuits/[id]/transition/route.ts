import { NextResponse } from "next/server";
import { PursuitError, getPursuitDetail, transitionPursuit, type PursuitState } from "@otn/intelligence";
import { jsonError, withAccount } from "../../../../../../lib/api.js";

// POST /api/app/pursuits/{id}/transition — a UI-initiated (human) state change.
// Server-side validation blocks invalid transitions and missing required data;
// human-only states are honored because this route is always a human actor.
export const POST = withAccount<{ id: string }>(async ({ db, account, session, params, req }) => {
  const detail = await getPursuitDetail(db, params.id);
  if (!detail || detail.accountProfileId !== account.id) return jsonError(404, "pursuit not found");
  const body = (await req.json().catch(() => ({}))) as {
    to?: PursuitState;
    reason?: string;
    metadata?: Record<string, unknown>;
  };
  if (!body.to) return jsonError(400, "to (target state) required");
  try {
    await transitionPursuit(db, params.id, body.to, {
      actorType: "human",
      actorId: session.accountKey ?? "account",
      reason: body.reason ?? null,
      metadata: body.metadata ?? {},
    });
  } catch (err) {
    if (err instanceof PursuitError) return jsonError(422, `${err.code}: ${err.message}`);
    throw err;
  }
  return NextResponse.json(await getPursuitDetail(db, params.id));
});
