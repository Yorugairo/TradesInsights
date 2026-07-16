import { NextResponse } from "next/server";
import {
  addInteraction, getOrganizationView, setRelationship, type RelationshipState,
} from "@otn/intelligence";
import { jsonError, withAccount } from "../../../../../../lib/api.js";

// POST /api/app/organizations/{id}/interactions — log a relationship interaction.
// Ensures an account relationship row exists first (so the interaction attaches).
export const POST = withAccount<{ id: string }>(async ({ db, account, session, params, req }) => {
  const view = await getOrganizationView(db, params.id, account.id);
  if (!view) return jsonError(404, "organization not found");
  const body = (await req.json().catch(() => ({}))) as {
    interactionType?: string;
    summary?: string;
    occurredAt?: string;
    projectId?: string;
    pursuitId?: string;
  };
  if (!body.interactionType) return jsonError(400, "interactionType required");
  const rel = await setRelationship(db, {
    accountProfileId: account.id,
    organizationId: params.id,
    relationshipState: (view.relationship?.relationshipState ?? "contacted") as RelationshipState,
    ownerUserId: session.accountKey ?? "account",
    preferred: view.relationship?.preferred ?? false,
    blocked: view.relationship?.blocked ?? false,
  });
  const { id } = await addInteraction(db, rel.id, {
    interactionType: body.interactionType,
    projectId: body.projectId ?? null,
    pursuitId: body.pursuitId ?? null,
    createdBy: session.accountKey ?? "account",
    ...(body.summary !== undefined ? { summary: body.summary } : {}),
    ...(body.occurredAt !== undefined ? { occurredAt: body.occurredAt } : {}),
  });
  return NextResponse.json({ id }, { status: 201 });
});
