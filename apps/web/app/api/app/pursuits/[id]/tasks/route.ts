import { NextResponse } from "next/server";
import { PursuitError, addPursuitTask, getPursuitDetail } from "@otn/intelligence";
import { jsonError, withAccount } from "../../../../../../lib/api.js";

// POST /api/app/pursuits/{id}/tasks — add a workflow task (validated task type).
export const POST = withAccount<{ id: string }>(async ({ db, account, params, req }) => {
  const detail = await getPursuitDetail(db, params.id);
  if (!detail || detail.accountProfileId !== account.id) return jsonError(404, "pursuit not found");
  const body = (await req.json().catch(() => ({}))) as {
    title?: string;
    taskType?: string;
    ownerUserId?: string;
    dueAt?: string;
  };
  if (!body.title || !body.taskType) return jsonError(400, "title and taskType required");
  try {
    const { id } = await addPursuitTask(db, params.id, {
      title: body.title,
      taskType: body.taskType,
      ownerUserId: body.ownerUserId ?? null,
      dueAt: body.dueAt ?? null,
    });
    return NextResponse.json({ id }, { status: 201 });
  } catch (err) {
    if (err instanceof PursuitError) return jsonError(422, `${err.code}: ${err.message}`);
    throw err;
  }
});
