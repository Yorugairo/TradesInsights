import { NextResponse } from "next/server";
import { z } from "zod";
import { decideReviewCluster } from "@otn/resolution";
import { withAdmin } from "../../../../../../lib/api.js";

const BodySchema = z.object({
  matchedRule: z.string().min(1),
  reasonKey: z.string(),
  candidateProjectId: z.string().uuid().nullable(),
  decision: z.enum(["merge", "reject"]),
  note: z.string().max(500).optional(),
});

// POST /api/admin/review-queue/cluster/decision — decide every pending review
// in one triage cluster (Batch3 #1). Same per-row provenance as single
// decisions; merge requires a candidate project.
export const POST = withAdmin(async ({ db, session, req }) => {
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  }
  if (parsed.data.decision === "merge" && parsed.data.candidateProjectId === null) {
    return NextResponse.json(
      { error: "merge requires a candidate project; this cluster has none" },
      { status: 400 },
    );
  }
  const { note, ...cluster } = parsed.data;
  const summary = await decideReviewCluster(db, {
    ...cluster,
    ...(note ? { note } : {}),
    decidedBy: `admin:${session.role}`,
  });
  return NextResponse.json(summary);
});
