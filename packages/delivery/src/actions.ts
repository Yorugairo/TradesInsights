import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";

/**
 * P2.3 — one-tap email actions. Design constraints:
 * - a token authorizes exactly ONE action on ONE opportunity for ONE account;
 * - single-use (atomic claim), expiring (default 14 days);
 * - only the SHA-256 lands in the database — a DB read never yields a link;
 * - the token grants NO session and reads nothing: consuming it returns the
 *   (account, opportunity, action) triple; the caller performs the effect
 *   through the same audited code paths as the logged-in UI.
 * - NO destructive/high-risk actions are issuable ("pursue" and "dismiss"
 *   only — both reversible in the app).
 */

export const ACTION_KINDS = ["pursue", "dismiss"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export interface ActionLinks {
  pursue: string;
  dismiss: string;
}

/** Issue one-tap tokens for a set of digest items. Returns per-opportunity URLs. */
export async function issueActionTokens(
  db: Db,
  input: {
    accountProfileId: string;
    deliveryId: string;
    opportunityIds: string[];
    baseUrl: string;
    ttlDays?: number;
  },
): Promise<Map<string, ActionLinks>> {
  const ttlDays = input.ttlDays ?? 14;
  const expiresAt = new Date(Date.now() + ttlDays * 86_400_000).toISOString();
  const out = new Map<string, ActionLinks>();
  for (const opportunityId of input.opportunityIds) {
    const links: Partial<Record<ActionKind, string>> = {};
    for (const action of ACTION_KINDS) {
      const raw = randomBytes(32).toString("base64url");
      await db.execute(sql`
        INSERT INTO action_tokens
          (token_hash, account_profile_id, opportunity_id, delivery_id, action, expires_at)
        VALUES (${hashToken(raw)}, ${input.accountProfileId}, ${opportunityId},
                ${input.deliveryId}, ${action}, ${expiresAt})`);
      links[action] = `${input.baseUrl.replace(/\/$/, "")}/api/action?t=${raw}`;
    }
    out.set(opportunityId, links as ActionLinks);
  }
  return out;
}

export type ConsumeResult =
  | { ok: true; action: ActionKind; accountProfileId: string; opportunityId: string }
  | { ok: false; reason: "invalid" | "expired" | "already_used" };

/**
 * Read a token WITHOUT consuming it (security review: mail-security gateways
 * prefetch every link in an email, so the GET that renders the confirmation
 * page must be safe and replayable — only the explicit POST consumes).
 */
export async function peekActionToken(db: Db, rawToken: string): Promise<ConsumeResult> {
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(rawToken)) return { ok: false, reason: "invalid" };
  const res = await db.execute(sql`
    SELECT action, account_profile_id, opportunity_id, used_at, expires_at
    FROM action_tokens WHERE token_hash = ${hashToken(rawToken)}`);
  const r = res.rows[0] as
    | {
        action: ActionKind;
        account_profile_id: string;
        opportunity_id: string;
        used_at: string | null;
        expires_at: string;
      }
    | undefined;
  if (!r) return { ok: false, reason: "invalid" };
  if (r.used_at) return { ok: false, reason: "already_used" };
  if (new Date(r.expires_at).getTime() <= Date.now()) return { ok: false, reason: "expired" };
  return {
    ok: true,
    action: r.action,
    accountProfileId: r.account_profile_id,
    opportunityId: r.opportunity_id,
  };
}

/**
 * Atomically claim a token (single UPDATE guarded on used_at IS NULL — two
 * concurrent taps cannot both succeed). The caller applies the effect.
 */
export async function consumeActionToken(db: Db, rawToken: string): Promise<ConsumeResult> {
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(rawToken)) return { ok: false, reason: "invalid" };
  const hash = hashToken(rawToken);
  const claimed = await db.execute(sql`
    UPDATE action_tokens SET used_at = now()
    WHERE token_hash = ${hash} AND used_at IS NULL AND expires_at > now()
    RETURNING action, account_profile_id, opportunity_id`);
  if (claimed.rows.length > 0) {
    const r = claimed.rows[0] as {
      action: ActionKind;
      account_profile_id: string;
      opportunity_id: string;
    };
    return {
      ok: true,
      action: r.action,
      accountProfileId: r.account_profile_id,
      opportunityId: r.opportunity_id,
    };
  }
  const existing = await db.execute(
    sql`SELECT used_at, expires_at FROM action_tokens WHERE token_hash = ${hash}`,
  );
  if (existing.rows.length === 0) return { ok: false, reason: "invalid" };
  const row = existing.rows[0] as { used_at: string | null; expires_at: string };
  if (row.used_at) return { ok: false, reason: "already_used" };
  return { ok: false, reason: "expired" };
}
