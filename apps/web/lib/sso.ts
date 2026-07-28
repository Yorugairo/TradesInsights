import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * The OTN → Insights sign-in handoff token.
 *
 * OTN authenticates its own users (Supabase + `tenant_memberships`) and already
 * knows which Insights account a tenant maps to — that mapping lives in
 * `public.tenant_insights_accounts` on the registry side and is resolved by
 * `resolveInsightsAccountKey()`. So the handoff does NOT re-derive identity: a
 * signed token asserts "OTN says this authenticated user may open Insights as
 * account X", and Insights re-validates that the account exists and is active
 * before minting its own session.
 *
 * ENVELOPE. Identical in shape to the session cookie in `lib/auth.ts`
 * (base64url payload + "." + HMAC-SHA256), deliberately: one envelope to
 * reason about, and a reader of either file recognises the other.
 *
 * DIFFERENT SECRET, on purpose. `INSIGHTS_SSO_SECRET` is not `AUTH_SECRET`.
 * OTN must never hold the pilot passphrase, and the two rotate independently —
 * rotating the handoff must not sign every logged-in user out.
 *
 * SIXTY SECONDS. The token is a redirect hop, not a credential: it is minted
 * and immediately spent. A short life plus the single-use `sso_consumed`
 * ledger means an intercepted URL is worthless almost immediately, and worth
 * nothing at all once used.
 *
 * NEVER PUT THIS IN AN EMAIL. Mail-security gateways prefetch every link they
 * see — the reason `delivery/src/actions.ts` splits peek from consume. A
 * prefetched handoff would be burned before the human clicked it. This token
 * only ever travels as a dashboard redirect.
 */

/** Claims the issuer asserts. `v` lets a future format change fail closed. */
export const SsoClaimsSchema = z
  .object({
    v: z.literal(1),
    /** Insights `account_profiles.key`, resolved by OTN. */
    accountKey: z.string().min(1),
    /** OTN tenant — carried for the audit log ONLY, never used for lookup. */
    tenantId: z.string().min(1),
    /** Supabase user id — the input to the admin allowlist. */
    sub: z.string().min(1),
    /** Random per mint; consumed exactly once. */
    jti: z.string().min(8),
    /** Expiry, ms since epoch. */
    exp: z.number().int().positive(),
  })
  .strict();

export type SsoClaims = z.infer<typeof SsoClaimsSchema>;

/** How long a freshly minted token stays valid. */
export const SSO_TTL_MS = 60_000;

export type SsoVerifyResult =
  | { ok: true; claims: SsoClaims }
  | { ok: false; reason: "invalid" | "expired" };

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/**
 * Mint a token. Lives here so the shape is defined once and the tests below
 * exercise the real signer; the OTN side mints with an equivalent function
 * against the same secret (two repos, one envelope — the tests here are what
 * pin it).
 */
export function mintSsoToken(
  claims: Omit<SsoClaims, "v" | "exp"> & { exp?: number },
  opts: { secret: string; now?: number },
): string {
  const now = opts.now ?? Date.now();
  const full: SsoClaims = {
    v: 1,
    accountKey: claims.accountKey,
    tenantId: claims.tenantId,
    sub: claims.sub,
    jti: claims.jti,
    exp: claims.exp ?? now + SSO_TTL_MS,
  };
  const payload = Buffer.from(JSON.stringify(full)).toString("base64url");
  return `${payload}.${sign(payload, opts.secret)}`;
}

/**
 * Verify a token.
 *
 * ORDER IS THE SECURITY: signature first, then parse, then expiry. Parsing
 * attacker-supplied JSON before the signature check would run the parser on
 * unauthenticated input, and checking expiry first would leak whether a forged
 * token's timestamp was plausible.
 *
 * `.strict()` claim validation means an unexpected field is a rejection, not
 * an ignored extra — a token minted by a future format cannot be replayed
 * against this one.
 */
export function verifySsoToken(
  raw: string | null | undefined,
  opts: { secret: string; now?: number },
): SsoVerifyResult {
  if (!raw) return { ok: false, reason: "invalid" };
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return { ok: false, reason: "invalid" };

  const payload = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  const expected = sign(payload, opts.secret);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  // Length check first: timingSafeEqual THROWS on a length mismatch, and an
  // exception here would be a 500 on hostile input rather than a refusal.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "invalid" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const claims = SsoClaimsSchema.safeParse(parsed);
  if (!claims.success) return { ok: false, reason: "invalid" };
  if (claims.data.exp <= (opts.now ?? Date.now())) return { ok: false, reason: "expired" };
  return { ok: true, claims: claims.data };
}
