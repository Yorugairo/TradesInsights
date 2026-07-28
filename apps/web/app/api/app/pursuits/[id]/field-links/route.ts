import { NextResponse } from "next/server";
import { FieldError, getPursuitDetail, listFieldLinks, mintFieldLink, revokeFieldLink } from "@otn/intelligence";
import { jsonError, withAccount } from "../../../../../../lib/api.js";

// GET /api/app/pursuits/{id}/field-links — links for this pursuit (never tokens).
export const GET = withAccount<{ id: string }>(async ({ db, account, params }) => {
  const p = await getPursuitDetail(db, params.id);
  if (!p || p.accountProfileId !== account.id) return jsonError(404, "pursuit not found");
  return NextResponse.json({ items: await listFieldLinks(db, p.id) });
});

// POST {label} — mint a crew link. THE ONLY RESPONSE THAT EVER CARRIES THE RAW
// URL: the token is not recoverable afterwards (only its hash is stored).
export const POST = withAccount<{ id: string }>(async ({ db, account, params, req }) => {
  const p = await getPursuitDetail(db, params.id);
  if (!p || p.accountProfileId !== account.id) return jsonError(404, "pursuit not found");
  const body = (await req.json().catch(() => ({}))) as { label?: string };
  if (!body.label?.trim()) return jsonError(400, "label required (who is this link for?)");
  try {
    const { id, rawToken } = await mintFieldLink(db, {
      pursuitId: p.id,
      accountProfileId: account.id,
      label: body.label,
    });
    // Same base-URL source the digest's one-tap links use (deliver.ts
    // actionBase): configured origin first, request origin as the dev fallback.
    const base = (process.env.APP_BASE_URL ?? new URL(req.url).origin).replace(/\/$/, "");
    return NextResponse.json({ id, url: `${base}/field/${rawToken}` }, { status: 201 });
  } catch (err) {
    if (err instanceof FieldError) return jsonError(400, err.message);
    throw err;
  }
});

// DELETE {linkId} — revoke.
export const DELETE = withAccount<{ id: string }>(async ({ db, account, params, req }) => {
  const p = await getPursuitDetail(db, params.id);
  if (!p || p.accountProfileId !== account.id) return jsonError(404, "pursuit not found");
  const body = (await req.json().catch(() => ({}))) as { linkId?: string };
  if (!body.linkId) return jsonError(400, "linkId required");
  try {
    await revokeFieldLink(db, p.id, body.linkId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof FieldError) return jsonError(404, err.message);
    throw err;
  }
});
