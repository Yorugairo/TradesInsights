import { NextResponse } from "next/server";
import { ingestInvitation } from "@otn/intelligence";
import { db } from "../../../../../lib/db.js";
import { accountByKey } from "../../../../../lib/queries.js";
import { jsonError } from "../../../../../lib/api.js";

/**
 * POST /api/webhooks/inbound-email/{provider} — provider-agnostic inbound-email
 * intake (S3 §6). Authorized-only: guarded by a shared secret (INBOUND_EMAIL_SECRET)
 * and an explicit accountKey, so a forwarded invitation lands in exactly one
 * account. Never scrapes; the customer forwards to the configured address.
 */
export async function POST(req: Request, ctx: { params: Promise<{ provider: string }> }): Promise<NextResponse> {
  const secret = process.env["INBOUND_EMAIL_SECRET"];
  if (!secret) return jsonError(503, "inbound email intake not configured");
  if (req.headers.get("x-inbound-secret") !== secret) return jsonError(401, "invalid inbound secret");

  const { provider } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    accountKey?: string;
    rawEml?: string;
    providerMessageId?: string;
  };
  if (!body.accountKey || !body.rawEml || !body.providerMessageId) {
    return jsonError(400, "accountKey, rawEml, providerMessageId required");
  }
  const account = await accountByKey(db(), body.accountKey);
  if (!account) return jsonError(404, "unknown account");

  const result = await ingestInvitation(db(), {
    accountProfileId: account.id,
    provider,
    providerMessageId: body.providerMessageId,
    rawEml: body.rawEml,
  });
  return NextResponse.json(result, { status: 201 });
}
