import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { ingestInvitation } from "@otn/intelligence";
import { jsonError, withAccount } from "../../../../../lib/api.js";

// POST /api/app/invitations/upload — customer-authorized .eml upload (S3 §6).
// Ingest is idempotent on the message's own Message-ID, so a re-upload of the
// same email is not duplicated.
export const POST = withAccount(async ({ db, account, req }) => {
  const body = (await req.json().catch(() => ({}))) as { rawEml?: string; providerMessageId?: string };
  if (!body.rawEml?.trim()) return jsonError(400, "rawEml required");
  const result = await ingestInvitation(db, {
    accountProfileId: account.id,
    provider: "eml_upload",
    providerMessageId: body.providerMessageId ?? randomUUID(),
    rawEml: body.rawEml,
  });
  return NextResponse.json(result, { status: 201 });
});
