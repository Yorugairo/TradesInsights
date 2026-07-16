import { NextResponse } from "next/server";
import {
  RELATIONSHIP_STATES, getOrganizationView, setRelationship, type RelationshipState,
} from "@otn/intelligence";
import { jsonError, withAccount } from "../../../../../../lib/api.js";

// GET /api/app/organizations/{id}/relationship — account-scoped GC view.
export const GET = withAccount<{ id: string }>(async ({ db, account, params }) => {
  const view = await getOrganizationView(db, params.id, account.id);
  if (!view) return jsonError(404, "organization not found");
  return NextResponse.json(view);
});

// POST /api/app/organizations/{id}/relationship — set account relationship state.
export const POST = withAccount<{ id: string }>(async ({ db, account, session, params, req }) => {
  const body = (await req.json().catch(() => ({}))) as {
    relationshipState?: RelationshipState;
    preferred?: boolean;
    blocked?: boolean;
    notes?: string;
  };
  if (!body.relationshipState || !(RELATIONSHIP_STATES as readonly string[]).includes(body.relationshipState)) {
    return jsonError(400, "valid relationshipState required");
  }
  await setRelationship(db, {
    accountProfileId: account.id,
    organizationId: params.id,
    relationshipState: body.relationshipState,
    ownerUserId: session.accountKey ?? "account",
    preferred: body.preferred ?? false,
    blocked: body.blocked ?? false,
    notes: body.notes ?? null,
  });
  return NextResponse.json(await getOrganizationView(db, params.id, account.id));
});
