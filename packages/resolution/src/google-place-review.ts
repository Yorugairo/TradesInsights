/**
 * Google Place review queue — the Insights read side of a REGISTRY-owned queue.
 *
 * The queue itself lives in `registry_internal`, which Insights must never read.
 * The seam is two `registry_public` contract views granted to
 * `otn_insights_reader` alone. Insights reads them and writes decisions to
 * `registry_partner.partner_queue_decisions`; the registry's own applier performs
 * the guarded UPDATE, so the registry keeps the last word on its own queue.
 *
 * SKIP-SAFE: a missing view (42P01) degrades to an empty result, because the
 * Insights deploy and the registry migration are not atomic — a page that 500s
 * during a deploy window is worse than one that shows an empty queue. EVERY other
 * error rethrows: a permission failure or a column drift is a real defect and must
 * not masquerade as "no rows".
 */
import type { RegistryPoolLike } from "./registry-link.js";

export const GOOGLE_PLACE_REVIEW_VIEW = "registry_public.google_place_review_v1";
export const GOOGLE_PLACE_BLOCKED_VIEW = "registry_public.google_place_review_blocked_summary_v1";

/** Postgres `undefined_table` — the only error this module swallows. */
const UNDEFINED_TABLE = "42P01";

/**
 * Why a pending row is or is not human-decidable. The registry view computes this;
 * `awaiting_evidence` is its fail-closed default, so an unrecognised reason never
 * reaches an operator as if it were actionable.
 */
export type GooglePlaceReviewState = "actionable" | "awaiting_auto_resolver" | "awaiting_evidence";

export const GOOGLE_PLACE_REVIEW_STATES: readonly GooglePlaceReviewState[] = [
  "actionable",
  "awaiting_auto_resolver",
  "awaiting_evidence",
];

export function isGooglePlaceReviewState(v: unknown): v is GooglePlaceReviewState {
  return typeof v === "string" && (GOOGLE_PLACE_REVIEW_STATES as readonly string[]).includes(v);
}

export interface GooglePlaceReviewRow {
  reviewId: number;
  reviewState: GooglePlaceReviewState;
  reason: string;
  priority: number | null;
  entityId: string | null;
  entityName: string | null;
  ubi: string | null;
  lni: {
    businessName: string | null;
    licenseNumber: string | null;
    licenseType: string | null;
    address: string | null;
    city: string | null;
    stateCode: string | null;
    zip: string | null;
    phone: string | null;
  };
  google: {
    placeId: string | null;
    name: string | null;
    phone: string | null;
    address: string | null;
    website: string | null;
    category: string | null;
    mapsUrl: string | null;
    /** Text in the view (an unparseable scrape must not break it) — coerced here. */
    rating: number | null;
    reviewCount: number | null;
  };
  match: {
    status: string | null;
    method: string | null;
    confidence: number | null;
    conflictFlags: string[];
  };
  createdAt: string | null;
}

export interface GooglePlaceBlockedSummaryRow {
  reviewState: string;
  reason: string;
  count: number;
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);

function isMissingRelation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === UNDEFINED_TABLE;
}

function toRow(r: Record<string, unknown>): GooglePlaceReviewRow {
  const state = r["review_state"];
  return {
    reviewId: Number(r["review_id"]),
    // The view's CASE only emits the three known states; anything else means the
    // contract changed, and the safe reading is "not actionable".
    reviewState: isGooglePlaceReviewState(state) ? state : "awaiting_evidence",
    reason: String(r["reason"] ?? ""),
    priority: num(r["priority"]),
    entityId: str(r["entity_id"]),
    entityName: str(r["entity_name"]),
    ubi: str(r["ubi"]),
    lni: {
      businessName: str(r["lni_business_name"]),
      licenseNumber: str(r["lni_license_number"]),
      licenseType: str(r["lni_license_type"]),
      address: str(r["lni_address"]),
      city: str(r["lni_city"]),
      stateCode: str(r["lni_state_code"]),
      zip: str(r["lni_zip"]),
      phone: str(r["lni_phone"]),
    },
    google: {
      placeId: str(r["google_place_id"]),
      name: str(r["google_name"]),
      phone: str(r["google_phone"]),
      address: str(r["google_address"]),
      website: str(r["google_website"]),
      category: str(r["google_category"]),
      mapsUrl: str(r["google_maps_url"]),
      rating: num(r["google_rating"]),
      reviewCount: num(r["google_review_count"]),
    },
    match: {
      status: str(r["match_status"]),
      method: str(r["match_method"]),
      confidence: num(r["match_confidence"]),
      conflictFlags: strArray(r["match_conflict_flags"]),
    },
    createdAt: r["created_at"] ? String(r["created_at"]) : null,
  };
}

/**
 * Rows from the contract view, newest-highest-priority first.
 *
 * `state` is whitelisted against the known union before it reaches SQL —
 * `RegistryPoolLike.query` takes no bind parameters, so an unvalidated value would
 * be string-interpolated. `limit` is coerced to a bounded integer for the same reason.
 */
export async function fetchGooglePlaceReviewRows(
  pool: RegistryPoolLike,
  opts: { state?: GooglePlaceReviewState; limit?: number } = {},
): Promise<GooglePlaceReviewRow[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100), 1), 500);
  const where = opts.state && isGooglePlaceReviewState(opts.state)
    ? `WHERE review_state = '${opts.state}'`
    : "";
  try {
    const res = await pool.query(
      `SELECT * FROM ${GOOGLE_PLACE_REVIEW_VIEW} ${where}
       ORDER BY priority DESC NULLS LAST, review_id ASC
       LIMIT ${limit}`,
    );
    return res.rows.map(toRow);
  } catch (err) {
    if (isMissingRelation(err)) return [];
    throw err;
  }
}

/**
 * Per-reason counts of everything NOT actionable — the drift canary. If a reason
 * string changes registry-side, its rows land here rather than silently becoming
 * human work.
 */
export async function fetchGooglePlaceBlockedSummary(
  pool: RegistryPoolLike,
): Promise<GooglePlaceBlockedSummaryRow[]> {
  try {
    const res = await pool.query(
      `SELECT review_state, reason, n FROM ${GOOGLE_PLACE_BLOCKED_VIEW} ORDER BY n DESC`,
    );
    return res.rows.map((r) => ({
      reviewState: String(r["review_state"] ?? ""),
      reason: String(r["reason"] ?? ""),
      count: Number(r["n"] ?? 0),
    }));
  } catch (err) {
    if (isMissingRelation(err)) return [];
    throw err;
  }
}
