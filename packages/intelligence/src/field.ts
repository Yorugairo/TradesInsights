import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";

/**
 * Field communication (deck appendix A5, "fast to build"): tokenized crew
 * links carrying daily logs and change orders back into the pursuit — the
 * lever the deck names as recovering the 10–15% currently lost to verbal
 * agreements.
 *
 * Token contract vs. action_tokens (delivery/actions.ts): SAME hashing (only
 * SHA-256 lands in the DB; a DB read never yields a link), SAME "grants no
 * session" posture — but MULTI-USE. A crew member opens the same job page all
 * week, so validity is not-expired-and-not-revoked rather than a single
 * atomic claim. That difference is why this is its own table and module
 * instead of a third ACTION_KIND.
 */

export class FieldError extends Error {
  constructor(
    public code:
      | "not_found"
      | "invalid_entry_type"
      | "invalid_quantities"
      | "invalid_value"
      | "not_a_change_order"
      | "already_decided",
    message: string,
  ) {
    super(message);
    this.name = "FieldError";
  }
}

export const FIELD_ENTRY_TYPES = ["daily_log", "change_order", "note"] as const;
export type FieldEntryType = (typeof FIELD_ENTRY_TYPES)[number];

const DEFAULT_LINK_TTL_DAYS = 30;

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export interface FieldLinkSummary {
  id: string;
  label: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

/** Mint a crew link. The RAW token is returned exactly once — the caller
 * renders it into a URL and it is never recoverable afterwards. */
export async function mintFieldLink(
  db: Db,
  input: { pursuitId: string; accountProfileId: string; label: string; ttlDays?: number },
): Promise<{ id: string; rawToken: string }> {
  if (!input.label.trim()) throw new FieldError("invalid_value", "label required (who is this link for?)");
  const raw = randomBytes(32).toString("base64url");
  const expiresAt = new Date(
    Date.now() + (input.ttlDays ?? DEFAULT_LINK_TTL_DAYS) * 86_400_000,
  ).toISOString();
  const res = await db.execute(sql`
    INSERT INTO field_links (pursuit_id, account_profile_id, token_hash, label, expires_at)
    VALUES (${input.pursuitId}, ${input.accountProfileId}, ${hashToken(raw)},
            ${input.label.trim()}, ${expiresAt})
    RETURNING id`);
  return { id: (res.rows[0] as { id: string }).id, rawToken: raw };
}

export type FieldVerifyResult =
  | { ok: true; linkId: string; pursuitId: string; accountProfileId: string; label: string }
  | { ok: false };

/**
 * Verify a raw token. Deliberately CONSTANT-SHAPE on failure: never-existed,
 * revoked, and expired all return the same `{ ok: false }` so the public
 * surface renders one neutral "link unavailable" page — no oracle for
 * guessing which links once worked. Read-only: `last_used_at` is bumped by
 * the POST path only, keeping GET strictly safe (mail-gateway prefetch rule,
 * api/action/route.ts precedent).
 */
export async function verifyFieldToken(db: Db, rawToken: string): Promise<FieldVerifyResult> {
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(rawToken)) return { ok: false };
  const res = await db.execute(sql`
    SELECT id, pursuit_id, account_profile_id, label, expires_at, revoked_at
    FROM field_links WHERE token_hash = ${hashToken(rawToken)}`);
  const r = res.rows[0] as
    | { id: string; pursuit_id: string; account_profile_id: string; label: string; expires_at: string; revoked_at: string | null }
    | undefined;
  if (!r) return { ok: false };
  if (r.revoked_at) return { ok: false };
  if (new Date(r.expires_at).getTime() <= Date.now()) return { ok: false };
  return { ok: true, linkId: r.id, pursuitId: r.pursuit_id, accountProfileId: r.account_profile_id, label: r.label };
}

export async function touchFieldLink(db: Db, linkId: string): Promise<void> {
  await db.execute(sql`UPDATE field_links SET last_used_at = now() WHERE id = ${linkId}`);
}

export async function revokeFieldLink(db: Db, pursuitId: string, linkId: string): Promise<void> {
  const res = await db.execute(sql`
    UPDATE field_links SET revoked_at = now()
    WHERE id = ${linkId} AND pursuit_id = ${pursuitId} AND revoked_at IS NULL
    RETURNING id`);
  if (res.rows.length === 0) throw new FieldError("not_found", `link ${linkId} not found or already revoked`);
}

export async function listFieldLinks(db: Db, pursuitId: string): Promise<FieldLinkSummary[]> {
  const res = await db.execute(sql`
    SELECT id, label, expires_at, revoked_at, last_used_at, created_at
    FROM field_links WHERE pursuit_id = ${pursuitId} ORDER BY created_at DESC`);
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    id: r["id"] as string,
    label: r["label"] as string,
    expiresAt: r["expires_at"] as string,
    revokedAt: (r["revoked_at"] as string | null) ?? null,
    lastUsedAt: (r["last_used_at"] as string | null) ?? null,
    createdAt: r["created_at"] as string,
  }));
}

export interface DailyQuantities {
  boards: number | null;
  tapedLf: number | null;
  crewHours: number | null;
}

function parseQuantities(input: unknown): DailyQuantities | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== "object") throw new FieldError("invalid_quantities", "quantities must be an object");
  const q = input as Record<string, unknown>;
  const num = (k: string): number | null => {
    const v = q[k];
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 100_000) {
      throw new FieldError("invalid_quantities", `${k} must be a non-negative number`);
    }
    return n;
  };
  return { boards: num("boards"), tapedLf: num("tapedLf"), crewHours: num("crewHours") };
}

export interface FieldEntryRow {
  id: string;
  entryType: FieldEntryType;
  body: string;
  quantities: DailyQuantities | null;
  amount: number | null;
  submittedName: string | null;
  status: "submitted" | "approved" | "rejected";
  decidedAt: string | null;
  decidedBy: string | null;
  viaLabel: string | null;
  createdAt: string;
}

/** UUID as minted by `crypto.randomUUID()` on the device. Validated rather than
 * trusted: the value reaches a unique index, so an unbounded client string
 * would let one caller squat arbitrary keys. */
const CLIENT_ENTRY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function addFieldEntry(
  db: Db,
  input: {
    pursuitId: string;
    linkId: string | null;
    entryType: string;
    body: string;
    quantities?: unknown;
    amount?: number | null;
    submittedName?: string | null;
    /** Device-minted idempotency key. Present only from the offline outbox;
     * cockpit-authored entries omit it and behave exactly as before. */
    clientEntryId?: string | null;
  },
): Promise<{ id: string; deduped: boolean }> {
  if (!(FIELD_ENTRY_TYPES as readonly string[]).includes(input.entryType)) {
    throw new FieldError("invalid_entry_type", `unknown entry type ${input.entryType}`);
  }
  if (!input.body.trim()) throw new FieldError("invalid_value", "body required");
  const quantities = input.entryType === "daily_log" ? parseQuantities(input.quantities) : null;
  let amount: number | null = null;
  if (input.entryType === "change_order") {
    if (input.amount !== null && input.amount !== undefined) {
      const n = Number(input.amount);
      if (!Number.isFinite(n) || n < 0) throw new FieldError("invalid_value", "amount must be a non-negative number");
      amount = n;
    }
  }
  // Non-CO entries need no decision: they land approved so status queries mean
  // one thing ("what awaits a decision") instead of two.
  const status = input.entryType === "change_order" ? "submitted" : "approved";

  const clientEntryId = input.clientEntryId?.trim() || null;
  if (clientEntryId !== null && !CLIENT_ENTRY_ID_RE.test(clientEntryId)) {
    throw new FieldError("invalid_value", "clientEntryId must be a UUID");
  }

  // IDEMPOTENT WHEN THE CLIENT SUPPLIES A KEY (migration 0042).
  //
  // The offline outbox retries a queued entry on every reconnect trigger until
  // it observes a 2xx, so a response lost in transit MUST NOT create a second
  // row. `ON CONFLICT DO NOTHING` returns zero rows on a replay, which is why
  // the SELECT below exists: the caller needs the original id either way, and
  // an empty result here means "already stored", never "failed".
  //
  // The WHERE clause is repeated in the conflict target because the index is
  // PARTIAL — Postgres will not match a partial index for inference without it,
  // and the statement would fail rather than dedupe.
  const res = await db.execute(sql`
    INSERT INTO field_entries
      (pursuit_id, link_id, entry_type, body, quantities_json, amount, submitted_name, status,
       client_entry_id)
    VALUES (${input.pursuitId}, ${input.linkId}, ${input.entryType}, ${input.body.trim()},
            ${quantities ? JSON.stringify(quantities) : null}, ${amount},
            ${input.submittedName?.trim() || null}, ${status}, ${clientEntryId})
    ON CONFLICT (client_entry_id) WHERE client_entry_id IS NOT NULL DO NOTHING
    RETURNING id`);
  if (res.rows.length > 0) return { id: (res.rows[0] as { id: string }).id, deduped: false };

  // Only reachable with a key present — without one there is no conflict target.
  const existing = await db.execute(sql`
    SELECT id FROM field_entries WHERE client_entry_id = ${clientEntryId} LIMIT 1`);
  if (existing.rows.length === 0) {
    // Defensive: a conflict fired but the row is gone (deleted between the two
    // statements). Surfacing this beats returning a fabricated id.
    throw new FieldError("not_found", "entry conflicted but could not be read back");
  }
  return { id: (existing.rows[0] as { id: string }).id, deduped: true };
}

/**
 * Approve/reject a change order. Guarded on status='submitted' so two decisions
 * cannot both land — the second is a 409 at the route, mirroring the atomic
 * claim discipline of consumeActionToken. Decision appends a pursuit note so
 * the audit trail rides an existing, already-rendered surface.
 */
export async function decideChangeOrder(
  db: Db,
  pursuitId: string,
  entryId: string,
  decision: "approved" | "rejected",
  decidedBy: string,
): Promise<void> {
  const entry = await db.execute(sql`
    SELECT entry_type, status, amount, body FROM field_entries
    WHERE id = ${entryId} AND pursuit_id = ${pursuitId}`);
  const e = entry.rows[0] as
    | { entry_type: string; status: string; amount: number | null; body: string }
    | undefined;
  if (!e) throw new FieldError("not_found", `entry ${entryId} not found`);
  if (e.entry_type !== "change_order") throw new FieldError("not_a_change_order", "only change orders carry a decision");
  const res = await db.execute(sql`
    UPDATE field_entries SET status = ${decision}, decided_at = now(), decided_by = ${decidedBy}
    WHERE id = ${entryId} AND status = 'submitted'
    RETURNING id`);
  if (res.rows.length === 0) throw new FieldError("already_decided", `change order was already decided`);
  await db.execute(sql`
    INSERT INTO pursuit_notes (pursuit_id, author_user_id, body, visibility)
    VALUES (${pursuitId}, ${decidedBy},
      ${`change order ${decision}: "${e.body.slice(0, 120)}"${e.amount !== null ? ` (~$${Number(e.amount).toLocaleString("en-US")})` : ""}`},
      'account')`);
}

export async function listFieldEntries(
  db: Db,
  pursuitId: string,
  opts: { limit?: number } = {},
): Promise<FieldEntryRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const res = await db.execute(sql`
    SELECT e.id, e.entry_type, e.body, e.quantities_json, e.amount, e.submitted_name,
           e.status, e.decided_at, e.decided_by, e.created_at, l.label AS via_label
    FROM field_entries e
    LEFT JOIN field_links l ON l.id = e.link_id
    WHERE e.pursuit_id = ${pursuitId}
    ORDER BY e.created_at DESC
    LIMIT ${limit}`);
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    id: r["id"] as string,
    entryType: r["entry_type"] as FieldEntryType,
    body: r["body"] as string,
    quantities: (r["quantities_json"] as DailyQuantities | null) ?? null,
    amount: r["amount"] === null || r["amount"] === undefined ? null : Number(r["amount"]),
    submittedName: (r["submitted_name"] as string | null) ?? null,
    status: r["status"] as "submitted" | "approved" | "rejected",
    decidedAt: (r["decided_at"] as string | null) ?? null,
    decidedBy: (r["decided_by"] as string | null) ?? null,
    viaLabel: (r["via_label"] as string | null) ?? null,
    createdAt: r["created_at"] as string,
  }));
}

export interface FieldBrief {
  pursuitId: string;
  accountKey: string;
  accountProfileId: string;
  projectName: string;
  county: string | null;
  city: string | null;
  state: string;
  nextActionAt: string | null;
  bidDueAt: string | null;
}

/**
 * The job brief a crew link renders. Deliberately LEAN — this surface is
 * unauthenticated-by-token, so it carries what a crew member needs to know
 * which job they are on and nothing else: no contacts, no scores, no money
 * beyond what the crew themselves submit.
 */
export async function getFieldBrief(db: Db, pursuitId: string): Promise<FieldBrief | null> {
  const res = await db.execute(sql`
    SELECT pu.id, pu.state, pu.next_action_at, pu.account_profile_id,
           a.key AS account_key, p.canonical_name AS project_name, p.county, p.city,
           (SELECT min(bi.bid_due_at) FROM bid_invitations bi
             WHERE bi.project_id = p.id AND bi.account_profile_id = pu.account_profile_id
               AND bi.bid_due_at > now()) AS bid_due_at
    FROM pursuits pu
    JOIN account_profiles a ON a.id = pu.account_profile_id
    JOIN opportunities o ON o.id = pu.opportunity_id
    JOIN projects p ON p.id = o.project_id
    WHERE pu.id = ${pursuitId}`);
  const r = res.rows[0] as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    pursuitId: r["id"] as string,
    accountKey: r["account_key"] as string,
    accountProfileId: r["account_profile_id"] as string,
    projectName: r["project_name"] as string,
    county: (r["county"] as string | null) ?? null,
    city: (r["city"] as string | null) ?? null,
    state: r["state"] as string,
    nextActionAt: (r["next_action_at"] as string | null) ?? null,
    bidDueAt: (r["bid_due_at"] as string | null) ?? null,
  };
}

export interface FieldRollup {
  boards: number;
  tapedLf: number;
  crewHours: number;
  logCount: number;
  approvedExtras: number;
}

/** Production logged against the pursuit (approved entries only), the "measure
 * yourself against it" side of the A6 loop. */
export async function fieldRollup(db: Db, pursuitId: string): Promise<FieldRollup> {
  const res = await db.execute(sql`
    SELECT
      COALESCE(sum((quantities_json->>'boards')::numeric) FILTER (WHERE entry_type = 'daily_log'), 0)::float AS boards,
      COALESCE(sum((quantities_json->>'tapedLf')::numeric) FILTER (WHERE entry_type = 'daily_log'), 0)::float AS taped_lf,
      COALESCE(sum((quantities_json->>'crewHours')::numeric) FILTER (WHERE entry_type = 'daily_log'), 0)::float AS crew_hours,
      count(*) FILTER (WHERE entry_type = 'daily_log')::int AS log_count,
      COALESCE(sum(amount) FILTER (WHERE entry_type = 'change_order' AND status = 'approved'), 0)::float AS approved_extras
    FROM field_entries
    WHERE pursuit_id = ${pursuitId} AND status != 'rejected'`);
  const r = res.rows[0] as {
    boards: number; taped_lf: number; crew_hours: number; log_count: number; approved_extras: number;
  };
  return {
    boards: Number(r.boards),
    tapedLf: Number(r.taped_lf),
    crewHours: Number(r.crew_hours),
    logCount: Number(r.log_count),
    approvedExtras: Number(r.approved_extras),
  };
}
