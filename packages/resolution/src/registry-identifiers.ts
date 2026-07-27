/**
 * The registry identifier graph, read across the seam.
 *
 * `registry_public.trades_identifiers_v1` is one row per identifier of an active
 * trades entity, carrying `is_strong` (the value maps to exactly ONE entity —
 * enforced registry-side by a partial unique index) and `shared_entity_count`.
 *
 * WHY THIS EXISTS: the trust score's `identifier` component was a constant. On
 * the 254-row `binding_name_exact` bulk it sat at 0.500 for every single row, so
 * it ranked nothing. It could not do better, because the only identifier channel
 * the scorer consulted was the org's phone — and 252 of those 254 orgs carry no
 * identifier evidence at all (measured 2026-07-24).
 *
 * So this module supplies the OTHER half of the question. Direct agreement is the
 * strong answer when we have it; when we do not, the graph still tells us how
 * PINNED DOWN the matched entity is — whether its phone/address/domain are unique
 * to it, or shared with the companies a reviewer could confuse it for. That
 * varies across the bulk (12 distinct footprints) where agreement does not, and
 * it is honest evidence about the same question: could this org actually be some
 * OTHER entity?
 *
 * SKIP-SAFE: a missing view (42P01) degrades to an empty graph, because the
 * Insights deploy and the registry migration are not atomic. Every other error
 * rethrows — a permission failure must never masquerade as "no identifiers",
 * which would silently flatten every score back to the neutral fallback.
 */
import { crossNameKeyLoose, nameSimilarity } from "./normalize.js";
import type { RegistryPoolLike } from "./registry-link.js";

export const REGISTRY_IDENTIFIERS_VIEW = "registry_public.trades_identifiers_v1";

/** Postgres `undefined_table` — the only error this module swallows. */
const UNDEFINED_TABLE = "42P01";

/**
 * Identifier types whose VALUE SPACE is shared with Insights, so a value from an
 * organization can be looked up directly against the registry graph.
 *
 * `address` is deliberately absent. The registry keys addresses as
 * `STREET|POSTAL5` off the raw L&I line; Insights keys them through
 * `addressMatchKeyCandidates`, which applies USPS abbreviation folding and peels
 * unit noise. The two are both correct and NOT interchangeable — comparing them
 * would silently never match. Address agreement is therefore established the way
 * it always has been, through the Insights-side address index built over the
 * registry rows, and this module is consulted only for that value's STRENGTH.
 */
export const CROSS_SYSTEM_IDENTIFIER_TYPES = ["phone", "google_phone", "root_domain"] as const;

export type RegistryIdentifierType =
  | "contractor_number"
  | "ubi"
  | "root_domain"
  | "phone"
  | "google_phone"
  | "address"
  | "google_place_id";

export interface RegistryIdentifierRow {
  entityId: string;
  identifierType: string;
  valueNormalized: string;
  /** TRUE iff the value maps to exactly one entity — the flag to bind or score on. */
  isStrong: boolean;
  /** How many VISIBLE entities carry this value. 1 = unique; >1 = confusable set. */
  sharedEntityCount: number;
}

/**
 * Per-entity summary of identifier footprint. `strong` counts identifiers UNIQUE
 * to the entity; `weak` counts those it shares with someone else.
 *
 * `ubi` and `contractor_number` are excluded from both counts: every active
 * entity has them by construction (they are what minting an entity means), so
 * including them would add the same constant to every entity and discriminate
 * nothing. Only the Phase-1 promoted channels — the ones an entity may or may not
 * have — carry information here.
 */
export interface EntityIdentifierFootprint {
  strong: number;
  weak: number;
  /** Normalized values this entity carries under TWO OR MORE different source
   * types — e.g. the same 10 digits as both the L&I `phone` and the
   * `google_phone`. Two independent systems landing on one value is a different
   * claim from merely holding two identifiers, and until now nothing looked for
   * it: the graph was built on "independent sources meeting on a shared key" and
   * then never checked for that meeting INSIDE an entity. */
  crossSourceValues: number;
}

const FOOTPRINT_TYPES = new Set<string>([
  "phone",
  "google_phone",
  "address",
  "root_domain",
  "google_place_id",
]);

/**
 * Types whose values are directly comparable ACROSS sources, so the same value
 * appearing under two of them is one fact confirmed twice.
 *
 * `phone` and `google_phone` qualify: both normalize to 10 bare digits
 * (`normalizePhoneUS` ≡ the registry's `normalizePhoneDigits`). `address` does
 * NOT — the registry keys `STREET|POSTAL5` while Insights folds USPS
 * abbreviations, so a cross-type address comparison would silently never match
 * (see CROSS_SYSTEM_IDENTIFIER_TYPES). `google_place_id` has no counterpart.
 */
const CROSS_SOURCE_COMPARABLE = new Set<string>(["phone", "google_phone"]);

export interface RegistryIdentifierIndex {
  /** Identifier footprint per entity id. */
  footprintByEntity: Map<string, EntityIdentifierFootprint>;
  /** `${type}|${value}` → the rows carrying it (length > 1 ⇒ shared). */
  byTypedValue: Map<string, RegistryIdentifierRow[]>;
  /** Rows loaded. 0 means the graph is unavailable, NOT that it is empty. */
  size: number;
}

export const EMPTY_IDENTIFIER_INDEX: RegistryIdentifierIndex = {
  footprintByEntity: new Map(),
  byTypedValue: new Map(),
  size: 0,
};

export function typedValueKey(type: string, value: string): string {
  return `${type}|${value}`;
}

/** Pure over rows so the grading below is unit-testable without a database. */
export function buildRegistryIdentifierIndex(
  rows: RegistryIdentifierRow[],
): RegistryIdentifierIndex {
  const footprintByEntity = new Map<string, EntityIdentifierFootprint>();
  const byTypedValue = new Map<string, RegistryIdentifierRow[]>();
  // entityId → value → the comparable source types carrying it. A value seen
  // under 2+ types is one fact two independent systems agree on.
  const sourcesByEntityValue = new Map<string, Map<string, Set<string>>>();

  for (const row of rows) {
    const key = typedValueKey(row.identifierType, row.valueNormalized);
    const bucket = byTypedValue.get(key);
    if (bucket) bucket.push(row);
    else byTypedValue.set(key, [row]);

    if (!FOOTPRINT_TYPES.has(row.identifierType)) continue;
    const fp = footprintByEntity.get(row.entityId) ?? { strong: 0, weak: 0, crossSourceValues: 0 };
    if (row.isStrong) fp.strong += 1;
    else fp.weak += 1;
    footprintByEntity.set(row.entityId, fp);

    if (!CROSS_SOURCE_COMPARABLE.has(row.identifierType)) continue;
    let byValue = sourcesByEntityValue.get(row.entityId);
    if (!byValue) sourcesByEntityValue.set(row.entityId, (byValue = new Map()));
    let types = byValue.get(row.valueNormalized);
    if (!types) byValue.set(row.valueNormalized, (types = new Set()));
    types.add(row.identifierType);
  }

  for (const [entityId, byValue] of sourcesByEntityValue) {
    const fp = footprintByEntity.get(entityId);
    if (!fp) continue;
    for (const types of byValue.values()) if (types.size >= 2) fp.crossSourceValues += 1;
  }

  return { footprintByEntity, byTypedValue, size: rows.length };
}

/**
 * How a Google Business profile corroborates an L&I entity.
 *
 * WHY THIS IS NOT JUST THE PHONE (measured 2026-07-24): of 2,980 accepted links
 * whose phones agree, **2,962 were created by `match_method='hard_identifier'`,
 * which matched ON that phone**. The agreement restates how the link was made —
 * it is circular. The proof it cannot stand alone: **384 links have an agreeing
 * phone and a Google name unrelated to the L&I name** (shared switchboards,
 * answering services, franchise lines).
 *
 * The NAME is the independent axis — it was never used to make those links. So
 * only `phone_and_name` is real confirmation; `phone_only` is the circular case
 * and is deliberately reported separately rather than being scored as identity.
 *
 * Pure. Names are compared through `crossNameKey`, never raw equality: live data
 * has L&I `Smith Fire Systems Inc` against Google `Smith Fire Systems, INC`,
 * which differ by a comma and case and are plainly the same business.
 */
export type GoogleConfirmation = "phone_and_name" | "phone_only" | "name_only" | "none";

/** Name similarity at or above which two business names are "the same business"
 * without being key-identical (`Smith Fire Systems` vs `Smith Fire Systems Co`). */
export const GOOGLE_NAME_CLOSE_THRESHOLD = 0.85;

/**
 * HOW the two names agreed. The verdict above says whether to trust the pair;
 * this says on what basis, so the review queue can group a batch of one kind
 * together and judge them as a class rather than one at a time.
 */
export type NameAgreementBasis = "exact" | "close" | "contained" | "none";

/**
 * Minimum shared tokens for a CONTAINMENT match.
 *
 * Two is the whole safety margin. At one token the live data offers
 * `AECON TECHNICAL SERVICES` ↔ `AECON` and `SEAFAB` ↔ `SEAFAB CUSTOM METAL
 * FABRICATION` — probably right, but indistinguishable in form from a generic
 * first word shared by unrelated firms. Combined with the shared-switchboard
 * phones this lane already knows about (384 links agree on phone with an
 * unrelated name), one token plus a phone is exactly how a false bind is made.
 * Measured cost of the guard: it declines 161 of 1,027 candidates.
 */
export const GOOGLE_NAME_CONTAINMENT_MIN_TOKENS = 2;

/**
 * Whole-token containment: every token of the shorter name appears, in order,
 * in the longer one. Token-wise, never substring — a substring test matches
 * `AIR` inside `FAIRWAY` and would invent relationships out of spelling.
 *
 * Returns the shared-token count; 0 when not contained or when the names are
 * equal (equality is `exact`, reported separately so the two never double-count).
 */
export function nameContainmentTokens(a: string, b: string): number {
  if (a === b) return 0;
  const ta = a.split(" ").filter(Boolean);
  const tb = b.split(" ").filter(Boolean);
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (short.length === 0) return 0;
  let i = 0;
  for (const tok of long) if (i < short.length && tok === short[i]) i += 1;
  return i === short.length ? short.length : 0;
}

/**
 * On what basis (if any) an L&I name and a Google listing name are the same
 * business. Pure; exported so the scorer can record the basis alongside the
 * verdict.
 *
 * Both sides fold through `crossNameKeyLoose`, which additionally drops L&I's
 * TRUNCATED legal-suffix fragments (`LL`, `I`, `CRP`, `SERVS`). Without that,
 * `LIMITLESS HEATING COOLING LL` scores 0.75 against `LIMITLESS HEATING
 * COOLING` and is rejected as a different company.
 */
export function classifyNameAgreement(
  lniName: string | null | undefined,
  googleName: string | null | undefined,
): NameAgreementBasis {
  const lk = lniName ? crossNameKeyLoose(lniName) : "";
  const gk = googleName ? crossNameKeyLoose(googleName) : "";
  if (lk.length === 0 || gk.length === 0) return "none";
  if (lk === gk) return "exact";
  if (nameSimilarity(lk, gk) >= GOOGLE_NAME_CLOSE_THRESHOLD) return "close";
  if (nameContainmentTokens(lk, gk) >= GOOGLE_NAME_CONTAINMENT_MIN_TOKENS) return "contained";
  return "none";
}

/**
 * The 10-digit NANP form of a phone, or null when there is nothing comparable.
 *
 * Exported because "the phones disagree" and "there is no phone to compare" are
 * different facts and callers must be able to tell them apart — folding both
 * into a single false makes an absent number look like a contradiction.
 */
export const comparablePhone = (raw: string | null | undefined): string | null => {
  const d = String(raw ?? "").replace(/\D/g, "");
  const t = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  return t.length === 10 ? t : null;
};

const phoneDigits = comparablePhone;

export function classifyGoogleConfirmation(input: {
  lniPhone: string | null | undefined;
  googlePhone: string | null | undefined;
  lniName: string | null | undefined;
  googleName: string | null | undefined;
}): GoogleConfirmation {
  const lp = phoneDigits(input.lniPhone);
  const gp = phoneDigits(input.googlePhone);
  const phoneAgrees = lp !== null && lp === gp;

  const nameAgrees = classifyNameAgreement(input.lniName, input.googleName) !== "none";

  if (phoneAgrees && nameAgrees) return "phone_and_name";
  if (phoneAgrees) return "phone_only";
  if (nameAgrees) return "name_only";
  return "none";
}

/**
 * Look a value up in the graph. Returns null when the graph does not know it —
 * distinct from knowing it and finding it shared.
 */
export function lookupIdentifier(
  index: RegistryIdentifierIndex,
  type: string,
  value: string,
): { isStrong: boolean; sharedEntityCount: number; entityIds: string[] } | null {
  const rows = index.byTypedValue.get(typedValueKey(type, value));
  if (!rows || rows.length === 0) return null;
  return {
    isStrong: rows.some((r) => r.isStrong),
    sharedEntityCount: rows[0]!.sharedEntityCount,
    entityIds: rows.map((r) => r.entityId),
  };
}

/**
 * How the org's own identifier evidence relates to the matched entity.
 *   `strong`      — agrees, and the value is unique to this entity
 *   `weak`        — agrees, but the value is shared (an office building, a
 *                   switchboard): a real connection, never proof
 *   `contradicts` — the org has evidence on this channel and it points elsewhere
 *   `none`        — the org carries no evidence on any comparable channel
 */
export type IdentifierAgreement = "strong" | "weak" | "contradicts" | "none";

/** Agreement with a value unique to the matched entity: the strongest evidence. */
export const IDENTIFIER_AGREES_STRONG = 1;
/** Agreement with a SHARED value — real, but the sibling entities remain live
 * alternatives, so it must not score as proof. */
export const IDENTIFIER_AGREES_WEAK = 0.75;
/** Org evidence pointing at a different entity. */
export const IDENTIFIER_CONTRADICTS = 0;

/**
 * No org-side evidence — fall back to how separable the ENTITY is. These sit
 * around the 0.5 the component used to return unconditionally, so a
 * well-attested entity gains a little and a thinly-attested one loses a little,
 * rather than every row scoring identically.
 */
/**
 * Two INDEPENDENT systems — WA L&I registration and a Google Business profile —
 * agreeing on the same phone AND the same business name. The strongest statement
 * the registry can make about an entity without the org supplying anything.
 *
 * Sits ABOVE `WELL_PINNED` (three identifiers is not the same as one fact
 * confirmed twice) but BELOW `IDENTIFIER_AGREES_WEAK`, deliberately: this is
 * evidence the ENTITY is real and correctly identified, not evidence that THIS
 * org is that entity. Ranking it above an actual org-side identifier agreement
 * would overstate what it proves.
 */
export const IDENTIFIER_CROSS_SOURCE_CONFIRMED = 0.7;
export const IDENTIFIER_ENTITY_WELL_PINNED = 0.6;
export const IDENTIFIER_ENTITY_TYPICAL = 0.5;
export const IDENTIFIER_ENTITY_SHARED_ONLY = 0.35;
export const IDENTIFIER_ENTITY_UNKNOWN = 0.3;

/** At or above this many UNIQUE identifiers an entity is "well pinned". Three
 * independent channels (e.g. phone + address + domain) all resolving to this one
 * entity is a materially different situation from a lone licence number. */
export const WELL_PINNED_STRONG_IDS = 3;

/**
 * The `identifier` trust component: identifier evidence bearing on THIS match.
 *
 * Pure. `footprint` is null when the graph is unavailable or the entity carries
 * none of the promoted identifier types.
 */
export function gradeIdentifierComponent(input: {
  agreement: IdentifierAgreement;
  footprint: EntityIdentifierFootprint | null;
  /** Google corroboration of the ENTITY. Only `phone_and_name` counts — see
   * `classifyGoogleConfirmation` for why `phone_only` is circular. */
  googleConfirmation?: GoogleConfirmation;
}): number {
  switch (input.agreement) {
    case "strong":
      return IDENTIFIER_AGREES_STRONG;
    case "weak":
      return IDENTIFIER_AGREES_WEAK;
    case "contradicts":
      return IDENTIFIER_CONTRADICTS;
    case "none":
      break;
  }
  const fp = input.footprint;
  // Cross-source confirmation outranks every footprint band: the registry and
  // Google independently agree on this business's phone AND its name. Requires
  // BOTH the value-level evidence (two source types on one value) and the name
  // agreement — either alone is the circular case.
  if (
    input.googleConfirmation === "phone_and_name" &&
    fp !== null &&
    fp.crossSourceValues > 0
  ) {
    return IDENTIFIER_CROSS_SOURCE_CONFIRMED;
  }
  if (!fp || (fp.strong === 0 && fp.weak === 0)) return IDENTIFIER_ENTITY_UNKNOWN;
  if (fp.strong >= WELL_PINNED_STRONG_IDS) return IDENTIFIER_ENTITY_WELL_PINNED;
  if (fp.strong > 0) return IDENTIFIER_ENTITY_TYPICAL;
  return IDENTIFIER_ENTITY_SHARED_ONLY;
}

/**
 * Read the contract view. Selects only the five columns the scorer needs; the
 * reader role holds SELECT on the view alone (contract boundary).
 */
export async function fetchRegistryIdentifierRows(
  pool: RegistryPoolLike,
): Promise<RegistryIdentifierRow[]> {
  let res: { rows: Record<string, unknown>[] };
  try {
    res = await pool.query(
      `SELECT entity_id, identifier_type, value_normalized, is_strong, shared_entity_count
         FROM ${REGISTRY_IDENTIFIERS_VIEW}`,
    );
  } catch (err) {
    if ((err as { code?: string } | null)?.code === UNDEFINED_TABLE) return [];
    throw err;
  }
  return res.rows.map((r) => ({
    entityId: String(r["entity_id"]),
    identifierType: String(r["identifier_type"]),
    valueNormalized: String(r["value_normalized"]),
    isStrong: r["is_strong"] === true,
    sharedEntityCount: Number(r["shared_entity_count"] ?? 1),
  }));
}

/** Fetch + index in one step; an unavailable graph yields the empty index. */
export async function loadRegistryIdentifierIndex(
  pool: RegistryPoolLike | null,
): Promise<RegistryIdentifierIndex> {
  if (!pool) return EMPTY_IDENTIFIER_INDEX;
  return buildRegistryIdentifierIndex(await fetchRegistryIdentifierRows(pool));
}
