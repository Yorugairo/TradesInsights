import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SSO_TTL_MS, mintSsoToken, verifySsoToken } from "./sso.js";

/**
 * The handoff token is the only thing standing between an OTN session and an
 * Insights session, so every rejection path gets a test. A token that fails
 * OPEN here would hand one customer another customer's pipeline.
 */

const SECRET = "test-sso-secret-value";
const NOW = 1_785_000_000_000;

const claims = {
  accountKey: "solis_interiors",
  tenantId: "11111111-1111-1111-1111-111111111111",
  sub: "22222222-2222-2222-2222-222222222222",
  jti: "33333333-3333-3333-3333-333333333333",
};

const mint = (over: Partial<Parameters<typeof mintSsoToken>[0]> = {}, now = NOW): string =>
  mintSsoToken({ ...claims, ...over }, { secret: SECRET, now });

describe("verifySsoToken", () => {
  it("round-trips the claims a valid mint carries", () => {
    const result = verifySsoToken(mint(), { secret: SECRET, now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims.accountKey).toBe("solis_interiors");
    expect(result.claims.tenantId).toBe(claims.tenantId);
    expect(result.claims.sub).toBe(claims.sub);
    expect(result.claims.jti).toBe(claims.jti);
    expect(result.claims.v).toBe(1);
    expect(result.claims.exp).toBe(NOW + SSO_TTL_MS);
  });

  it("rejects a token signed with a different secret", () => {
    const foreign = mintSsoToken(claims, { secret: "not-the-secret", now: NOW });
    expect(verifySsoToken(foreign, { secret: SECRET, now: NOW })).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("rejects a tampered payload", () => {
    // Re-encode the claims with a DIFFERENT account and keep the old signature —
    // the attack the signature exists to stop.
    const token = mint();
    const [, mac] = token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...claims, v: 1, exp: NOW + SSO_TTL_MS, accountKey: "lacey_glass_commercial" }),
    ).toString("base64url");
    expect(verifySsoToken(`${forgedPayload}.${mac}`, { secret: SECRET, now: NOW })).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("rejects a flipped byte in the signature", () => {
    const token = mint();
    const flipped = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    expect(verifySsoToken(flipped, { secret: SECRET, now: NOW }).ok).toBe(false);
  });

  it("rejects a truncated signature without throwing", () => {
    // timingSafeEqual THROWS on a length mismatch; the guard must make this a
    // refusal rather than a 500 on hostile input.
    const token = mint();
    expect(() => verifySsoToken(token.slice(0, token.length - 5), { secret: SECRET, now: NOW })).not.toThrow();
    expect(verifySsoToken(token.slice(0, token.length - 5), { secret: SECRET, now: NOW }).ok).toBe(false);
  });

  it("rejects garbage, empty, and dotless input", () => {
    for (const bad of ["", "nonsense", ".", "no-dot-here", null, undefined]) {
      expect(verifySsoToken(bad, { secret: SECRET, now: NOW }).ok).toBe(false);
    }
  });

  it("reports expiry separately from invalidity", () => {
    const token = mint();
    expect(verifySsoToken(token, { secret: SECRET, now: NOW + SSO_TTL_MS + 1 })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("treats the exact expiry instant as expired", () => {
    expect(verifySsoToken(mint(), { secret: SECRET, now: NOW + SSO_TTL_MS })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  // A CORRECTLY signed token, so these prove the claim schema refuses on its
  // own merits rather than the signature doing the work.
  const signWith = (body: Record<string, unknown>): string => {
    const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
    return `${payload}.${createHmac("sha256", SECRET).update(payload).digest("base64url")}`;
  };

  it("rejects a correctly signed token carrying an unexpected claim", () => {
    // .strict() — an issuer that started sending `role` must not have it
    // silently ignored, because the next reader might start trusting it.
    const token = signWith({ ...claims, v: 1, exp: NOW + SSO_TTL_MS, role: "admin" });
    expect(verifySsoToken(token, { secret: SECRET, now: NOW })).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("rejects a correctly signed token from another format version", () => {
    const token = signWith({ ...claims, v: 2, exp: NOW + SSO_TTL_MS });
    expect(verifySsoToken(token, { secret: SECRET, now: NOW }).ok).toBe(false);
  });

  it("rejects a correctly signed token missing a required claim", () => {
    const { accountKey: _dropped, ...withoutAccount } = claims;
    const token = signWith({ ...withoutAccount, v: 1, exp: NOW + SSO_TTL_MS });
    expect(verifySsoToken(token, { secret: SECRET, now: NOW }).ok).toBe(false);
  });
});
