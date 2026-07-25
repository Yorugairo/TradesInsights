/**
 * Registry observations — the reviewed learning loop between Insights and the
 * One Trade Network registry (integration doc, Increment 3 + product layers).
 *
 * Everything that crosses the seam is an OBSERVATION with a deterministic trust
 * score and a review gate:
 *
 *   binding_name_match  registry entity ↔ Insights org by name+locality; accept
 *                       BINDS registry_ref (method 'name_review_confirmed') and
 *                       stamps the public identity snapshot. Identity binding is
 *                       ALWAYS human — never auto-accepted.
 *   phone_adoption      bound org: registry L&I phone → a GLOBAL public_business
 *                       contact (the paying accounts' bucket). Accept applies it.
 *                       The entity's Google Business phone is an INDEPENDENT lane
 *                       (not an else-branch): when it DIFFERS from L&I it is
 *                       surfaced under its own `phone_from_google_divergent` rule
 *                       key, adding a second contact rather than replacing the
 *                       L&I one. L&I stays authoritative; a consistently-accepted
 *                       divergence is the loop learning that the registered
 *                       number went stale.
 *   alias_export        bound org: Insights name variant → registry alias.
 *   trade_export        bound org: trade evidence from the SHARED registry trade
 *                       vocabulary (registry_public.trades_taxonomy_v1) matched
 *                       over each primary_contractor permit's type AND its
 *                       title/description. permitType matches are authoritative;
 *                       description-only matches are DE-RATED (role 0.5) so they
 *                       land in review, not auto-accept (a GC's building permit
 *                       describing "drywall" is not proof the GC self-performs
 *                       it). Skip-safe: no registry ⇒ the built-in fallback
 *                       vocabulary over permitType only (pre-taxonomy behavior).
 *                       Accepted export types are pushed to registry_partner
 *                       staging; the registry's own loader adjudicates from there.
 *
 * The learning loop is deterministic: every accept/reject updates the per-rule
 * accept history, `ruleHistory` (Laplace-smoothed accept rate) is a trust
 * component on the NEXT generation pass, and a non-binding rule whose reviewed
 * history clears AUTO_ACCEPT gates is auto-accepted with explicit provenance
 * (`decided_by = 'auto:rule-history'`). No model calls anywhere in this module.
 */
import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";
import {
  addressMatchKeyCandidates,
  backfeedAcceptedIdentity,
  loadOrganizationAddresses,
  loadOrganizationAliases,
  loadOrganizationDomains,
  loadOrganizationPhones,
  normalizePhoneUS,
  normalizeRootDomain,
} from "./identifiers.js";
import { crossNameKey, nameSimilarity } from "./normalize.js";
import { identitySnapshot, type RegistryBrand, type RegistryIdentityRow } from "./registry-link.js";
import {
  classifyGoogleConfirmation,
  EMPTY_IDENTIFIER_INDEX,
  gradeIdentifierComponent,
  IDENTIFIER_AGREES_STRONG,
  IDENTIFIER_AGREES_WEAK,
  IDENTIFIER_CONTRADICTS,
  IDENTIFIER_ENTITY_TYPICAL,
  lookupIdentifier,
  type IdentifierAgreement,
  type RegistryIdentifierIndex,
} from "./registry-identifiers.js";
import {
  buildTradeMatcher,
  FALLBACK_TRADE_MATCHER,
  type TradeMatcher,
  type TradeTaxonomyRow,
} from "./trade-taxonomy.js";
import type { EntityCorroboration } from "./entity-corroboration.js";

export const OBSERVATION_TYPES = [
  "binding_name_match", "phone_adoption", "alias_export", "trade_export",
  // Accept action on the corporate-family / principal-person lanes: an
  // entity↔entity `principal_shared` relationship, exported (as a 'relationship'
  // partner_observation) for the registry loader to adjudicate. Never binds
  // identity — it teaches the registry which companies share common control.
  "relationship_export",
] as const;
export type ObservationType = (typeof OBSERVATION_TYPES)[number];

/** Queue floor: candidates scoring below this are not worth operator time. */
export const MIN_QUEUE_TRUST = 0.55;

/** Exact, UNIQUE name match on a one-word company name ("MCKINSTRY", "ADT").
 * Its own rule so it is review-only by construction — `evaluateStrictBind`
 * matches the two multi-token rules and never this one — and so per-rule accept
 * rate scores one-word matches on their own evidence. */
export const SINGLE_TOKEN_NAME_RULE = "binding_name_exact_single_token";
/** A rule earns auto-accept (non-binding types only) at ≥N reviewed decisions… */
export const AUTO_ACCEPT_MIN_DECISIONS = 10;
/** …with an accept rate at or above this. */
export const AUTO_ACCEPT_MIN_RATE = 0.95;

/**
 * Strict binding auto-accept (owner-approved 2026-07-23) — the ONE tier that
 * binds an Insights org to a registry entity WITHOUT human review, relaxing this
 * module's default "identity binding is ALWAYS human". A candidate qualifies only
 * when ALL THREE hold (see `evaluateStrictBind`):
 *   1. exact name — a UNIQUE cross-key name match (rule binding_name_exact /
 *      binding_name_phone, name component 1) that also equals the registry's OWN
 *      normalized name (canonical_name_normalized) when the contract surfaces it;
 *   2. same city — locality corroboration === 1;
 *   3. shared trade — the org's AUTHORITATIVE permit-derived trade(s) (permitType
 *      matches only) intersect the registry entity's L&I trade_codes.
 * Anything softer stays in the human review queue. Provenance is explicit so an
 * auto-bind is always distinguishable from a human decision downstream.
 */
export const STRICT_BIND_METHOD = "name_strict_auto";
export const STRICT_BIND_DECIDED_BY = "auto:strict-bind";

export interface StrictBindGateInput {
  ruleKey: string;
  /** The name trust component (1.0 for a unique exact cross-key name match). */
  nameComponent: number;
  /** crossNameKey(org.canonical_name). */
  orgNameKey: string;
  /** crossNameKey(registry canonical_name_normalized), or null when the contract
   * did not surface a normalized name — then this extra equality is skipped. */
  registryNormalizedKey: string | null;
  /** Locality trust component (1 = registry city seen in the org's localities). */
  locality: number;
  /** The org's AUTHORITATIVE permit-derived trade codes (permitType only, lowercased). */
  orgTradeCodes: Set<string>;
  /** The registry entity's L&I trade codes (lowercased). */
  registryTradeCodes: Set<string>;
  /** True when the name hit came from one of the entity's registry ALIASES (a
   * DBA) rather than its canonical name. Such a match is review-only: trading
   * as a name is weaker evidence of identity than being registered under it,
   * and several unrelated firms can share a DBA. Defaults to false so existing
   * callers/tests are unaffected. */
  viaRegistryAlias?: boolean;
}

export interface StrictBindGateResult {
  strict: boolean;
  sharedTradeCodes: string[];
}

/**
 * The strict binding auto-accept gate — PURE so the governance-critical decision
 * is unit-tested without a database. Returns whether the candidate may auto-bind
 * and which trade codes it shares with the registry (for the audit payload).
 */
export function evaluateStrictBind(input: StrictBindGateInput): StrictBindGateResult {
  const sharedTradeCodes = [...input.orgTradeCodes].filter((c) => input.registryTradeCodes.has(c));
  const nameRule = input.ruleKey === "binding_name_exact" || input.ruleKey === "binding_name_phone";
  const nameIdentical =
    nameRule &&
    !input.viaRegistryAlias &&
    input.nameComponent === 1 &&
    (input.registryNormalizedKey === null || input.registryNormalizedKey === input.orgNameKey);
  const strict = nameIdentical && input.locality === 1 && sharedTradeCodes.length > 0;
  return { strict, sharedTradeCodes };
}

/** One strict-tier binding the pass auto-applied (or, in dryRun, WOULD apply). */
export interface StrictBindCandidate {
  organizationId: string;
  organizationName: string;
  registryEntityId: string;
  registryName: string | null;
  city: string | null;
  sharedTradeCodes: string[];
  trust: number;
}

export interface TrustComponents {
  /** Name agreement ∈ [0,1]: 1.0 for cross-system exact key equality. */
  name: number;
  /** Identifier agreement ∈ [0,1]: 1 = an evidence-backed identifier (phone)
   * matches the registry's L&I value; 0 = the org has identifier evidence and
   * it CONTRADICTS the registry; 0.5 = no identifier evidence (neutral). */
  identifier: number;
  /** Locality corroboration ∈ [0,1], graded by geography — see `gradeLocality`. */
  locality: number;
  /** Strongest role the org holds on projects (contractor > applicant > owner). */
  role: number;
  /** Independent corroboration: distinct source records naming the org (capped). */
  corroboration: number;
  /** Laplace-smoothed accept rate of this rule from reviewed HUMAN decisions, or
   * NULL when the rule has too few to say anything — see `MIN_HUMAN_DECISIONS`.
   * Null is excluded from the score rather than defaulted, because a default is
   * a claim about the rule that the evidence does not support. */
  ruleHistory: number | null;
}

export const TRUST_WEIGHTS: Record<keyof TrustComponents, number> = {
  name: 0.3, identifier: 0.15, locality: 0.1, role: 0.1, corroboration: 0.15, ruleHistory: 0.2,
};

/**
 * Human decisions a rule needs before its accept rate is allowed to move the
 * score. Below this the component is null and its weight redistributes.
 *
 * WHY (measured 2026-07-24): across the entire history of the queue there are 19
 * decisions and ALL of them are `auto:strict-bind` — zero human. `ruleHistory`
 * already excludes auto-decisions, so every rule sat on the untouched Laplace
 * prior of exactly 0.500, contributing a CONSTANT 0.5 × 0.2 = 0.1 to every row in
 * the queue. That is not a weak signal, it is no signal wearing 20% of the score:
 * it compressed every real difference between rows into the remaining 80%.
 *
 * Ten is a starting point, not a discovered constant — enough that one reviewer's
 * first afternoon cannot swing a rule's trust, low enough to start learning fast.
 */
export const MIN_HUMAN_DECISIONS = 10;

/**
 * Locality bands. The old component was binary — 1.0 for a city-token hit, 0.3
 * for everything else — which put "works in the next town over" in the same
 * bucket as "we have no idea where this entity is". Measured on the 254-row
 * bulk: 244 rows scored 0.3, and 61 of those were SAME-COUNTY matches while 68
 * had no county on the registry side at all.
 *
 * `DIFFERENT` sits BELOW `UNKNOWN` deliberately: knowing both counties and
 * finding them different is mild evidence against, whereas not knowing is not
 * evidence at all. It is only mild — trades contractors legitimately work
 * outside their home county — so it is a nudge, not a veto.
 */
export const LOCALITY_SAME_CITY = 1;
export const LOCALITY_SAME_COUNTY = 0.6;
/** The plan's floor: geography unknown on one side or the other. */
export const LOCALITY_UNKNOWN = 0.3;
export const LOCALITY_DIFFERENT_COUNTY = 0.15;

/**
 * Graded locality from the geography both systems actually hold.
 *
 * NOTE — this is NOT the metre-distance banding the plan sketched. That was
 * predicated on `geo_distance_meters`, which is the registry's INTERNAL
 * Google-listing-versus-L&I distance for one entity; it says nothing about how
 * far an org's projects are from an entity. Insights projects carry `city`,
 * `county` and `address_normalized` and no coordinates at all, so an org↔entity
 * distance in metres cannot be computed today. City/county agreement is the real
 * geography available on both sides.
 *
 * Pure — the org's localities are already lower-cased by `loadOrgFacts`.
 */
export function gradeLocality(input: {
  entityCity: string | null | undefined;
  entityCounty: string | null | undefined;
  /** Lower-cased city (or county, where the source gave no city) tokens. */
  orgLocalities: readonly string[];
  /** Lower-cased counties of the org's projects. */
  orgCounties: readonly string[];
}): number {
  const city = input.entityCity?.toLowerCase() ?? null;
  if (city && input.orgLocalities.some((l) => l.includes(city))) return LOCALITY_SAME_CITY;

  const county = input.entityCounty?.toLowerCase() ?? null;
  if (!county) return LOCALITY_UNKNOWN;
  const known = input.orgCounties.filter((c) => c.length > 0);
  if (known.length === 0) return LOCALITY_UNKNOWN;
  return known.some((c) => c === county) ? LOCALITY_SAME_COUNTY : LOCALITY_DIFFERENT_COUNTY;
}

/** Phone-only matches need at least this much name agreement to be reviewable
 * (phones get recycled and shared; a phone with a foreign name is noise). */
export const PHONE_MATCH_MIN_NAME_SIMILARITY = 0.3;

/** A SHARED registered address (2+ entities at one key — suite blocks, shared
 * buildings) can still disambiguate when ONE name clearly dominates: the best
 * name similarity must clear this floor AND beat the runner-up by the margin
 * below. Otherwise the bucket stays unmatchable (pre-Phase-4 behavior). */
export const ADDRESS_SHARED_MIN_NAME_SIMILARITY = 0.5;
export const ADDRESS_DOMINANCE_MARGIN = 0.2;

/** Identifier component for a google-phone match (4B.2): DE-RATED versus the
 * L&I registered phone's 1.0 — a Google Business profile phone is
 * account-entered, not L&I-verified (mirrors the phone_from_google adoption
 * precedent: distinct channel, own rule history, never inherits L&I trust). */
export const GOOGLE_PHONE_IDENTIFIER_COMPONENT = IDENTIFIER_AGREES_WEAK;

/**
 * Deterministic weighted trust ∈ [0,1]; stored beside its components.
 *
 * A NULL component is excluded and its weight redistributed across the
 * components that are present, so the score stays on [0,1] and remains a
 * weighted average of real evidence. The alternative — substituting a neutral
 * default — silently mixes an assumption into a number the operator reads as
 * measurement, and (with `ruleHistory` null on every rule today) would pin 20% of
 * every score to the same constant.
 */
export function computeTrust(c: TrustComponents): number {
  let score = 0;
  let weight = 0;
  for (const key of Object.keys(TRUST_WEIGHTS) as (keyof TrustComponents)[]) {
    const value = c[key];
    if (value === null || value === undefined || Number.isNaN(value)) continue;
    score += TRUST_WEIGHTS[key] * Math.max(0, Math.min(1, value));
    weight += TRUST_WEIGHTS[key];
  }
  if (weight === 0) return 0;
  return Math.round((score / weight) * 1000) / 1000;
}

/** Laplace-smoothed accept rate: unreviewed rules start at the 0.5 prior. */
export function laplaceAcceptRate(accepts: number, decisions: number): number {
  return (accepts + 1) / (decisions + 2);
}

/**
 * The rule's accept rate, or null when too few humans have ruled on it to say.
 * `decisions` must already exclude `auto:%` deciders (see `ruleHistory`) — a
 * rule grading its own auto-bindings is a self-reinforcing loop, not a track
 * record.
 */
export function ruleHistoryComponent(
  history: { accepts: number; decisions: number } | undefined,
): number | null {
  if (!history || history.decisions < MIN_HUMAN_DECISIONS) return null;
  return laplaceAcceptRate(history.accepts, history.decisions);
}

/**
 * A.4 — bounded corroboration bonus from the registry's OWN record count (a
 * distinct dataset independently substantiating the entity). Capped so a
 * well-established registry entity lifts a thin-Insights-evidence binding
 * candidate WITHOUT flattening the corroboration signal — registry counts are
 * large, so we add a small bounded term, never the raw count. Null/undefined
 * (hand-built rows, or an unpopulated contract view) ⇒ no bonus.
 */
export function registryCorroborationBonus(recordCount: number | null | undefined): number {
  if (recordCount == null) return 0;
  if (recordCount >= 3) return 0.5;
  if (recordCount >= 1) return 0.25;
  return 0;
}

/**
 * Cross-system name key — DEFINED IN `normalize.ts`, re-exported here because
 * this module has been its import site since it was introduced. It moved so the
 * alias lane (`loadOrganizationAliases` in identifiers.ts) can fold through the
 * same key without closing an import cycle.
 */
export { crossNameKey } from "./normalize.js";

/**
 * Registry address index: candidate match keys (primary + city/unit-noise
 * peels, 4B.3 — BOTH sides now generate candidates so suite-noise variants
 * meet) → ALL rows registered at that key. Shared keys keep their bucket
 * instead of dropping to null: `matchOrgByAddress` disambiguates by name
 * dominance. Pure over rows so the matcher is unit-testable with injected
 * `RegistryIdentityRow[]` (no DB), mirroring registry-link's pure matcher.
 */
/**
 * Google Business phone index (4B.2) — SECONDARY channel, unique-only, and
 * poisoned when the number collides with ANY L&I phone of a different entity
 * (call-tracking / recycled numbers must never cross-identify). Pure over rows.
 */
export function buildRegistryGooglePhoneIndex(
  rows: RegistryIdentityRow[],
  byPhone: Map<string, RegistryIdentityRow | null>,
): Map<string, RegistryIdentityRow | null> {
  const byGooglePhone = new Map<string, RegistryIdentityRow | null>();
  for (const row of rows) {
    const gp = normalizePhoneUS(row.googlePhone);
    if (!gp) continue;
    const lni = byPhone.get(gp);
    if (byPhone.has(gp) && (lni == null || lni.entityId !== row.entityId)) {
      byGooglePhone.set(gp, null);
      continue;
    }
    byGooglePhone.set(gp, byGooglePhone.has(gp) ? null : row);
  }
  return byGooglePhone;
}

/**
 * Root-domain index (Phase 4 enablement — the contract column was dormant
 * since registry-link.ts surfaced it): unique-only; both sides fold through
 * normalizeRootDomain (denylist included) so a drifting registry form can't
 * silently mismatch. Pure over rows.
 */
export function buildRegistryDomainIndex(
  rows: RegistryIdentityRow[],
): Map<string, RegistryIdentityRow | null> {
  const byDomain = new Map<string, RegistryIdentityRow | null>();
  for (const row of rows) {
    const domain = normalizeRootDomain(row.rootDomain);
    if (!domain) continue;
    byDomain.set(domain, byDomain.has(domain) ? null : row);
  }
  return byDomain;
}

export function buildRegistryAddressIndex(
  rows: RegistryIdentityRow[],
): Map<string, RegistryIdentityRow[]> {
  const byAddress = new Map<string, RegistryIdentityRow[]>();
  for (const row of rows) {
    for (const key of addressMatchKeyCandidates(row.registeredAddress, row.registeredPostalCode)) {
      const bucket = byAddress.get(key);
      if (!bucket) byAddress.set(key, [row]);
      else if (!bucket.some((r) => r.entityId === row.entityId)) bucket.push(row);
    }
  }
  return byAddress;
}

/**
 * Best address hit for an org, gated on name agreement. A single-entity key
 * keeps the original ≥0.3 gate; a SHARED key (2+ entities — suite blocks)
 * requires clear name dominance (best ≥ ADDRESS_SHARED_MIN_NAME_SIMILARITY and
 * ≥ ADDRESS_DOMINANCE_MARGIN above the runner-up) — a near-tie cannot say
 * WHICH suite-mate the org is, so it stays unmatched (fails closed). Returns
 * null when nothing clears its gate. Never binds on its own — the caller
 * queues it for human review.
 */
export function matchOrgByAddress(
  orgName: string,
  addressKeys: Set<string>,
  byAddress: Map<string, RegistryIdentityRow[]>,
): { row: RegistryIdentityRow; sim: number; bucketSize: number } | null {
  let best: { row: RegistryIdentityRow; sim: number; bucketSize: number } | null = null;
  for (const key of addressKeys) {
    const bucket = byAddress.get(key);
    if (!bucket || bucket.length === 0) continue;
    const ranked = bucket
      .map((row) => ({ row, sim: nameSimilarity(orgName, row.canonicalName ?? "") }))
      .sort((a, b) => b.sim - a.sim);
    const top = ranked[0]!;
    const clears =
      bucket.length === 1
        ? top.sim >= PHONE_MATCH_MIN_NAME_SIMILARITY
        : top.sim >= ADDRESS_SHARED_MIN_NAME_SIMILARITY &&
          top.sim - ranked[1]!.sim >= ADDRESS_DOMINANCE_MARGIN;
    if (clears && (best === null || top.sim > best.sim)) {
      best = { row: top.row, sim: top.sim, bucketSize: bucket.length };
    }
  }
  return best;
}

export interface RuleHistoryRow {
  ruleKey: string;
  decisions: number;
  accepts: number;
}

/** Reviewed accept-history per rule (the deterministic learning signal). */
export async function ruleHistory(db: Db): Promise<Map<string, RuleHistoryRow>> {
  const res = await db.execute(sql`
    SELECT rule_key,
      count(*)::int AS decisions,
      count(*) FILTER (WHERE status = 'accepted')::int AS accepts
    FROM registry_observations
    WHERE decided_at IS NOT NULL AND decided_by NOT LIKE 'auto:%'
    GROUP BY rule_key`);
  const map = new Map<string, RuleHistoryRow>();
  for (const r of res.rows as Record<string, unknown>[]) {
    map.set(r["rule_key"] as string, {
      ruleKey: r["rule_key"] as string,
      decisions: Number(r["decisions"]),
      accepts: Number(r["accepts"]),
    });
  }
  return map;
}

interface OrgFacts {
  id: string;
  canonical_name: string;
  registry_ref: string | null;
  role_weight: number;
  record_count: number;
  localities: string[];
  /** Counties of the org's projects — the coarser locality band (Task 2.2). Kept
   * SEPARATE from `localities`, which collapses city and county into one list and
   * so cannot tell "same county, different city" from "no match at all". */
  counties: string[];
}

/** Orgs holding roles on projects, with locality + corroboration facts. */
async function loadOrgFacts(db: Db, opts: { boundOnly?: boolean } = {}): Promise<OrgFacts[]> {
  const res = await db.execute(sql`
    SELECT o.id, o.canonical_name, o.registry_ref,
      max(CASE pr.role WHEN 'primary_contractor' THEN 1.0 WHEN 'applicant' THEN 0.6 ELSE 0.3 END) AS role_weight,
      count(DISTINCT pr.source_record_id)::int AS record_count,
      array_agg(DISTINCT lower(coalesce(sr.normalized_json->>'city', p.county))) AS localities,
      array_agg(DISTINCT lower(p.county)) FILTER (WHERE p.county IS NOT NULL) AS counties
    FROM organizations o
    JOIN project_roles pr ON pr.organization_id = o.id
    JOIN projects p ON p.id = pr.project_id
    LEFT JOIN source_records sr ON sr.id = pr.source_record_id
    WHERE o.canonical_name IS NOT NULL
      ${opts.boundOnly ? sql`AND o.registry_ref IS NOT NULL` : sql``}
    GROUP BY o.id`);
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    id: r["id"] as string,
    canonical_name: r["canonical_name"] as string,
    registry_ref: (r["registry_ref"] as string | null) ?? null,
    role_weight: Number(r["role_weight"] ?? 0.3),
    record_count: Number(r["record_count"] ?? 0),
    localities: ((r["localities"] as (string | null)[] | null) ?? []).filter(
      (x): x is string => typeof x === "string",
    ),
    counties: ((r["counties"] as (string | null)[] | null) ?? []).filter(
      (x): x is string => typeof x === "string" && x.length > 0,
    ),
  }));
}

export interface GenerateSummary {
  skipped: boolean;
  bindingCandidates: number;
  phoneAdoptions: number;
  aliasExports: number;
  tradeExports: number;
  autoAccepted: number;
  /** Binding candidates auto-bound this pass via the strict tier (0 in dryRun). */
  strictAutoBound: number;
  /** Every strict-qualifying candidate this pass — the read-only preview list.
   * Populated in dryRun (nothing written) and in a live run (what got bound). */
  strictCandidates: StrictBindCandidate[];
  /** 4B.5 telemetry: candidates computed but below MIN_QUEUE_TRUST (per rule),
   * and NEW rows actually queued per rule this pass. Feeds match:audit so
   * floor/weight tuning at the §12.3 calibration session is evidence-driven. */
  belowFloor: number;
  byRule: Record<string, number>;
  /** Existing PENDING rows whose score/payload this pass recomputed. Decided rows
   * are never rescored — their evidence is frozen at the decision. */
  rescored: number;
}

/**
 * Resolve the registry-side NAME STRING that actually produced a name-key
 * match, so `name_similarity` — and the reviewer-facing "vs" comparison —
 * reflects what was really matched instead of always the entity's canonical
 * name.
 *
 * Bug this closes (found in live review, 2026-07-23): a match reached through
 * a DBA/brand still always diffed the org against `hit.canonicalName`. "2 SONS
 * PLUMBING LLC" matched the alias "2 Sons Plumbing" (near-identical) but the
 * entity's canonical is "Fischer Services" (zero overlap) — the ONLY name ever
 * shown to a reviewer — so a near-perfect match displayed as `name_similarity:
 * 0`, reading as weak evidence when the underlying bind was exact
 * (`trustComponents.name` was already correctly 1; this is a display-layer fix
 * only, the trust score and tier were never wrong).
 *
 * `key` must be the EFFECTIVE key that produced the hit — the org's own
 * canonical key for `binding_name_exact`/`binding_name_phone` (matched via
 * `byNameKey`, which holds both the registry canonical and its aliases), or
 * the org's alias key for `binding_alias_exact`. Other rules (phone/address/
 * domain match) are not name-keyed — callers should skip this and keep
 * comparing to canonical, which is what those rules actually did.
 *
 * Resolution order: exact canonical match (cheap, common) → the brand
 * attribution already computed for this hit (fast path) → a linear scan of
 * `hit.aliases` for a string sharing the key (covers rollout skew where the
 * contract has `aliases` but not yet `brands`) → canonical as a last resort so
 * an attribution gap never throws, only degrades to the pre-fix behavior.
 */
export function resolveMatchedRegistryName(
  hit: RegistryIdentityRow,
  key: string,
  matchedBrand: RegistryBrand | null,
): string {
  if (hit.canonicalName && crossNameKey(hit.canonicalName) === key) return hit.canonicalName;
  if (matchedBrand) return matchedBrand.name;
  for (const alias of hit.aliases ?? []) {
    if (typeof alias === "string" && crossNameKey(alias) === key) return alias;
  }
  return hit.canonicalName ?? "";
}

interface PendingInsert {
  observationType: ObservationType;
  organizationId: string;
  registryEntityId: string;
  ruleKey: string;
  payload: Record<string, unknown>;
  components: TrustComponents;
  dedupeKey: string;
  /** Set only for a binding_name_match that cleared the strict auto-bind gate. */
  strictAutoBind?: boolean;
  /** Trade codes the candidate shares with the registry (strict-preview audit). */
  strictSharedTrades?: string[];
}

/**
 * Generate the observation queue from the registry contract rows and the live
 * Insights graph. Idempotent: dedupe keys make reruns no-ops; decided rows are
 * never resurrected. Auto-accept applies only to non-binding types whose rule
 * history clears the gates.
 */
export async function generateRegistryObservations(
  db: Db,
  registryRows: RegistryIdentityRow[] | null,
  opts: {
    logger?: { info: (obj: unknown, msg?: string) => void };
    /** The SHARED registry trade vocabulary (registry_public.trades_taxonomy_v1).
     * When present, Insights derives its trade matcher from it and scans permit
     * descriptions too; when null/absent, it falls back to the built-in
     * permitType-only vocabulary (pre-taxonomy behavior). */
    tradeTaxonomy?: TradeTaxonomyRow[] | null;
    /** Compute everything but write NOTHING — the read-only strict-bind preview. */
    dryRun?: boolean;
    /** The registry identifier graph (`registry_public.trades_identifiers_v1`),
     * loaded by the caller exactly as `registryRows` is. Absent/empty is safe:
     * the `identifier` component falls back to its unknown band rather than
     * inventing agreement it cannot see. */
    identifierIndex?: RegistryIdentifierIndex | null;
  } = {},
): Promise<GenerateSummary> {
  const summary: GenerateSummary = {
    skipped: false, bindingCandidates: 0, phoneAdoptions: 0, aliasExports: 0, tradeExports: 0, autoAccepted: 0,
    strictAutoBound: 0, strictCandidates: [], belowFloor: 0, byRule: {}, rescored: 0,
  };
  if (registryRows === null) {
    summary.skipped = true;
    opts.logger?.info({ skipped: true }, "registry-observations skipped (no registry rows)");
    return summary;
  }

  const history = await ruleHistory(db);
  const rate = (ruleKey: string): number | null => ruleHistoryComponent(history.get(ruleKey));

  // Registry name index (exact cross-key → rows; ambiguous keys are dropped —
  // one Insights name matching MULTIPLE registry entities is not reviewable
  // as a single suggestion and must wait for a stronger key).
  const byNameKey = new Map<string, RegistryIdentityRow[]>();
  // entityId → name key → the OPERATING BRAND that key belongs to. Built as the
  // name index is built, so a hit can say WHICH brand matched. That is what the
  // accept stamps: without it the accept backfeeds the entity's whole licence
  // array and fuses distinct brands (Apollo Sheet Metal / Apollo Mechanical)
  // into one org on the next record.
  const brandByEntityKey = new Map<string, Map<string, RegistryBrand>>();
  const addBrandKey = (key: string, row: RegistryIdentityRow, brand: RegistryBrand): void => {
    if (!key) return;
    const perEntity = brandByEntityKey.get(row.entityId) ?? new Map<string, RegistryBrand>();
    // First brand wins a key: a licence-bearing brand must not be replaced by a
    // later licence-less duplicate of the same name.
    if (!perEntity.has(key)) perEntity.set(key, brand);
    brandByEntityKey.set(row.entityId, perEntity);
  };
  const addNameKey = (key: string, row: RegistryIdentityRow): void => {
    if (!key) return;
    const bucket = byNameKey.get(key);
    if (!bucket) {
      byNameKey.set(key, [row]);
      return;
    }
    // Dedupe by ENTITY: one entity reaching a key by two routes (canonical and
    // its own alias, or two aliases folding together) is still one candidate.
    // Without this it would look like a 2-entity collision and be dropped.
    if (bucket.some((r) => r.entityId === row.entityId)) return;
    bucket.push(row);
  };
  for (const row of registryRows) {
    if (row.canonicalName) addNameKey(crossNameKey(row.canonicalName), row);
    // Registry DBAs (contract column `aliases`, L&I alias_type='dba') are match
    // keys in their own right: a permit naming "Fox Plumbing & Heating" must
    // reach the entity canonically named "Gene Johnsn Plb Htg Cl Elc LLC". They
    // enter the SAME index, so an alias colliding with another entity's
    // canonical name makes the key ambiguous and it is dropped — an alias never
    // silently outranks a canonical match.
    for (const alias of row.aliases ?? []) {
      if (typeof alias === "string" && alias.length > 0) addNameKey(crossNameKey(alias), row);
    }
    // `brands` carries the same names WITH their individual licences, so it maps
    // a matched key to a specific operating brand. Purely additive to the index
    // above: it introduces no new match keys, only attribution.
    for (const brand of row.brands ?? []) {
      addBrandKey(crossNameKey(brand.name), row, brand);
    }
  }
  const byEntity = new Map(registryRows.map((r) => [r.entityId, r]));

  const inserts: PendingInsert[] = [];

  // Registry phone index from L&I phones — UNIQUE phones only (a phone shared
  // by 2+ entities cannot disambiguate and is dropped as a match key).
  const byPhone = new Map<string, RegistryIdentityRow | null>();
  for (const row of registryRows) {
    if (!row.phone) continue;
    byPhone.set(row.phone, byPhone.has(row.phone) ? null : row);
  }
  // Secondary match-key indexes (4B.2 + Phase 4 domain enablement).
  const byGooglePhone = buildRegistryGooglePhoneIndex(registryRows, byPhone);
  const byDomain = buildRegistryDomainIndex(registryRows);
  // Evidence-backed phones per org (organization_identifiers, migration 0023).
  const orgPhones = await loadOrganizationPhones(db);
  // Registry address index (candidate street+zip5 keys, shared buckets kept)
  // + evidence-backed org addresses (migration 0024) — the no-phone/no-UBI
  // match path. Org root domains (migration 0030) feed the domain rule.
  const byAddress = buildRegistryAddressIndex(registryRows);
  const orgAddresses = await loadOrganizationAddresses(db);
  const orgDomains = await loadOrganizationDomains(db);
  // Name variants each org was published under (organization_aliases, migration
  // 0031) — already folded to cross-system keys, so they index straight into
  // `byNameKey` exactly as a canonical name does.
  const orgAliases = await loadOrganizationAliases(db);

  // Trade matcher (hoisted): the SHARED registry vocabulary drives both the
  // strict-bind trade gate in the binding loop and the trade_export section below.
  const taxonomyRows =
    opts.tradeTaxonomy && opts.tradeTaxonomy.length > 0 ? opts.tradeTaxonomy : null;
  const tradeMatcher: TradeMatcher = taxonomyRows
    ? buildTradeMatcher(taxonomyRows)
    : FALLBACK_TRADE_MATCHER;
  const scanDescription = taxonomyRows !== null;

  // Permit-derived trade codes per UNBOUND org — the strict-bind trade gate. In
  // the live corpus the contractor files as `applicant` on a generic
  // BUILDING/UTILITY permit and the trade lives in the title/description, so we
  // scan the SHARED-vocabulary matcher over permitType + title + description
  // (when the registry taxonomy is present) across BOTH applicant and
  // primary_contractor roles — matching how trade_export scans, and only ever
  // corroborating (never sole): the strict tier still requires exact name + same
  // city. SKIP-SAFE: no taxonomy ⇒ scan permitType only (pre-taxonomy behavior).
  const orgPermitTrades = new Map<string, Set<string>>();
  {
    const res = await db.execute(sql`
      SELECT pr.organization_id AS org_id,
             upper(coalesce(sr.normalized_json->>'permitType', '')) AS permit_type,
             upper(concat_ws(' ',
               sr.normalized_json->>'permitType',
               sr.normalized_json->>'title',
               left(sr.normalized_json->>'description', 800))) AS scan_text
      FROM organizations o
      JOIN project_roles pr ON pr.organization_id = o.id
        AND pr.role IN ('applicant', 'primary_contractor')
      JOIN source_records sr ON sr.id = pr.source_record_id
      WHERE o.registry_ref IS NULL
        AND (sr.normalized_json->>'permitType' IS NOT NULL
          OR sr.normalized_json->>'title' IS NOT NULL
          OR sr.normalized_json->>'description' IS NOT NULL)`);
    for (const r of res.rows as Record<string, unknown>[]) {
      const orgId = r["org_id"] as string;
      const permitType = (r["permit_type"] as string | null) ?? "";
      const text = scanDescription ? ((r["scan_text"] as string | null) ?? "") : permitType;
      for (const code of tradeMatcher.match(text)) {
        const set = orgPermitTrades.get(orgId) ?? new Set<string>();
        set.add(code.toLowerCase());
        orgPermitTrades.set(orgId, set);
      }
    }
  }

  // ── binding_name_match: unbound orgs vs registry (name key, phone-aware) ──
  const identifierIndex = opts.identifierIndex ?? EMPTY_IDENTIFIER_INDEX;
  /**
   * Is the value this match hinged on unique to the entity, or shared? A shared
   * phone/domain means the sibling entities carrying it remain live alternatives,
   * so the agreement is real evidence but not proof.
   */
  const agreementFor = (type: string, value: string): IdentifierAgreement => {
    const found = lookupIdentifier(identifierIndex, type, value);
    if (!found) return "weak"; // the graph cannot vouch for it — do not claim proof
    return found.isStrong ? "strong" : "weak";
  };

  const unbound = (await loadOrgFacts(db)).filter((o) => o.registry_ref === null);
  for (const org of unbound) {
    const phones = orgPhones.get(org.id) ?? new Set<string>();
    const addresses = orgAddresses.get(org.id) ?? new Set<string>();
    const domains = orgDomains.get(org.id) ?? new Set<string>();
    const key = crossNameKey(org.canonical_name);
    const keyTokens = key ? key.split(" ").filter(Boolean).length : 0;
    // SINGLE-TOKEN NAMES ARE LOOKED UP TOO. They used to be skipped outright
    // (`length >= 2`), which silently made every one-word company unbindable no
    // matter how clean the match: MCKINSTRY, RESICON, COCHRAN, ADT, TREEWALKER,
    // AIRX, ENTEK, GROUNDWORKS all key to a single token and all have an EXACT,
    // UNIQUE registry match that never became a candidate. McKinstry is one of
    // the largest mechanical contractors in the state.
    //
    // The original guard was guessing at ambiguity, but ambiguity is already
    // measured: `nameHits.length === 1` means the key reaches exactly one entity,
    // and a unique one-word key is strong, not weak. What stays different is the
    // RULE KEY — single-token matches get their own, so (a) `evaluateStrictBind`
    // cannot auto-bind them (its `nameRule` check lists only the two multi-token
    // rules) and (b) per-rule accept-rate learning scores them independently, so
    // if they do turn out noisy the queue floor corrects itself on evidence.
    const nameHits = keyTokens >= 1 ? byNameKey.get(key) : undefined;
    const singleTokenName = keyTokens === 1;

    let hit: RegistryIdentityRow | undefined;
    let ruleKey = "";
    let nameComponent = 1;
    // How the org's OWN identifier evidence relates to the matched entity. "none"
    // is the honest default — 252 of the 254 pending name-exact rows carry no org
    // identifier at all — and `gradeIdentifierComponent` turns that into a band
    // based on how pinned-down the entity is, rather than a flat neutral.
    let agreement: IdentifierAgreement = "none";
    if (nameHits && nameHits.length === 1) {
      // Unique name match; phone evidence corroborates or contradicts.
      hit = nameHits[0]!;
      const phoneAgrees = hit.phone !== null && phones.has(hit.phone);
      agreement =
        phones.size === 0 ? "none" : phoneAgrees ? agreementFor("phone", hit.phone!) : "contradicts";
      // Single-token routes to its own rule EVEN WHEN THE PHONE AGREES, so this
      // change cannot add a single auto-bind: `binding_name_phone` is strict-tier
      // eligible and this deliberately never becomes it.
      ruleKey = singleTokenName
        ? SINGLE_TOKEN_NAME_RULE
        : phoneAgrees
          ? "binding_name_phone"
          : "binding_name_exact";
    } else if (nameHits && nameHits.length > 1 && phones.size > 0) {
      // Ambiguous name key — the L&I phone may disambiguate to exactly one.
      const agreeing = nameHits.filter((h) => h.phone !== null && phones.has(h.phone));
      if (agreeing.length === 1) {
        hit = agreeing[0]!;
        agreement = agreementFor("phone", hit.phone!);
        ruleKey = "binding_name_phone";
      }
    } else if (phones.size > 0) {
      // No name match — phone-exact against a UNIQUE registry phone, gated on
      // a minimum of name agreement (phones get recycled between businesses).
      let best: { row: RegistryIdentityRow; sim: number } | null = null;
      for (const p of phones) {
        const row = byPhone.get(p);
        if (!row) continue;
        const sim = nameSimilarity(org.canonical_name, row.canonicalName ?? "");
        if (sim >= PHONE_MATCH_MIN_NAME_SIMILARITY && (best === null || sim > best.sim)) {
          best = { row, sim };
        }
      }
      if (best) {
        hit = best.row;
        nameComponent = best.sim;
        agreement = best.row.phone ? agreementFor("phone", best.row.phone) : "weak";
        ruleKey = "binding_phone_match";
      }
    }
    // No L&I name/phone hit — Google Business phone (4B.2). SECONDARY channel:
    // same name gate as the L&I phone path, DE-RATED identifier component,
    // distinct rule key so it earns its own reviewed accept history.
    let matchedGooglePhone: string | null = null;
    if (!hit && phones.size > 0) {
      let best: { row: RegistryIdentityRow; sim: number; phone: string } | null = null;
      for (const p of phones) {
        const row = byGooglePhone.get(p);
        if (!row) continue;
        const sim = nameSimilarity(org.canonical_name, row.canonicalName ?? "");
        if (sim >= PHONE_MATCH_MIN_NAME_SIMILARITY && (best === null || sim > best.sim)) {
          best = { row, sim, phone: p };
        }
      }
      if (best) {
        hit = best.row;
        nameComponent = best.sim;
        // Always the DE-RATED band, even when the number is unique to the entity:
        // a Google Business phone is account-entered, not L&I-verified, and that
        // channel-quality de-rating is independent of uniqueness (the same
        // reasoning as `phone_from_google`'s separate adoption lane).
        agreement = "weak";
        ruleKey = "binding_google_phone_match";
        matchedGooglePhone = best.phone;
      }
    }
    // Registered-address match (no-phone owners / developers whose name
    // drifts). Name-gated; shared buckets need name dominance (4B.3); NEVER
    // auto-binds (binding_name_match is excluded from auto-accept).
    let addressBucketSize: number | null = null;
    if (!hit && addresses.size > 0) {
      const addrHit = matchOrgByAddress(org.canonical_name, addresses, byAddress);
      if (addrHit) {
        hit = addrHit.row;
        nameComponent = addrHit.sim;
        // The registered address IS the matched L&I identifier — but a SHARED one
        // (suite block, office park) leaves every other tenant a live alternative.
        // Strength comes from the Insights-side bucket, not the registry graph:
        // the two key addresses differently (see CROSS_SYSTEM_IDENTIFIER_TYPES),
        // and this bucket is the one that actually produced the match.
        agreement = addrHit.bucketSize === 1 ? "strong" : "weak";
        ruleKey = "binding_address_match";
        addressBucketSize = addrHit.bucketSize;
      }
    }
    // Root-domain match (Phase 4 enablement): a UNIQUE, denylisted-clean
    // registered website root domain is entity-specific; still name-gated and
    // review-only like every binding rule.
    let matchedDomain: string | null = null;
    if (!hit && domains.size > 0) {
      let best: { row: RegistryIdentityRow; sim: number; domain: string } | null = null;
      for (const d of domains) {
        const row = byDomain.get(d);
        if (!row) continue;
        const sim = nameSimilarity(org.canonical_name, row.canonicalName ?? "");
        if (sim >= PHONE_MATCH_MIN_NAME_SIMILARITY && (best === null || sim > best.sim)) {
          best = { row, sim, domain: d };
        }
      }
      if (best) {
        hit = best.row;
        nameComponent = best.sim;
        agreement = agreementFor("root_domain", best.domain);
        ruleKey = "binding_domain_match";
        matchedDomain = best.domain;
      }
    }
    // Alias match (migration 0031): a name this org was ALSO published under.
    // An alias is a name, so it earns the name path's gates verbatim — ≥2
    // distinctive tokens and a UNIQUE registry hit — and phone evidence
    // corroborates or contradicts exactly as it does for the canonical. Two
    // aliases pointing at DIFFERENT entities is the same ambiguity a shared name
    // key is, and is dropped. Review-only: `evaluateStrictBind` admits just the
    // canonical-name rules, so an alias match can never auto-bind (owner decides
    // that after seeing real matches).
    let matchedAlias: string | null = null;
    if (!hit) {
      const aliasKeys = orgAliases.get(org.id);
      if (aliasKeys && aliasKeys.size > 0) {
        const byEntityHit = new Map<string, { row: RegistryIdentityRow; alias: string }>();
        for (const aliasKey of aliasKeys) {
          if (aliasKey === key || aliasKey.split(" ").length < 2) continue;
          const rows = byNameKey.get(aliasKey);
          if (!rows || rows.length !== 1) continue;
          const row = rows[0]!;
          if (!byEntityHit.has(row.entityId)) byEntityHit.set(row.entityId, { row, alias: aliasKey });
        }
        const only = byEntityHit.size === 1 ? [...byEntityHit.values()][0] : undefined;
        if (only) {
          hit = only.row;
          nameComponent = 1;
          const phoneAgrees = only.row.phone !== null && phones.has(only.row.phone);
          agreement =
            phones.size === 0
              ? "none"
              : phoneAgrees
                ? agreementFor("phone", only.row.phone!)
                : "contradicts";
          ruleKey = "binding_alias_exact";
          matchedAlias = only.alias;
        }
      }
    }
    if (!hit || !ruleKey) continue;

    // The EFFECTIVE key that produced this match. binding_name_exact/
    // binding_name_phone matched via `key` (byNameKey, which holds the
    // registry canonical AND its aliases); binding_alias_exact matched via the
    // ORG'S OWN alias key (`matchedAlias`) — NOT `key`, which is the org's
    // canonical and (by construction of the alias_exact branch above) never
    // matched anything on this entity. Every other rule (phone/address/domain
    // match) is a similarity match, not an exact-key one, so it has no single
    // "effective key" — left null, which correctly disables brand attribution
    // for those rules (a phone/address hit identifies the enterprise, not a
    // specific brand within it).
    const effectiveMatchKey =
      ruleKey === "binding_alias_exact"
        ? matchedAlias
        : ruleKey === "binding_name_exact" ||
            ruleKey === "binding_name_phone" ||
            // Matched through byNameKey by the same route, so brand attribution
            // works identically — only the auto-bind eligibility differs.
            ruleKey === SINGLE_TOKEN_NAME_RULE
          ? key
          : null;

    // Which operating brand did this match land on? Looked up by the EFFECTIVE
    // key (not always `key` — see above), so an alias_exact match can find its
    // brand too, not just the direct byNameKey path.
    const matchedBrand = effectiveMatchKey
      ? (brandByEntityKey.get(hit.entityId)?.get(effectiveMatchKey) ?? null)
      : null;
    // The registry-side NAME STRING that actually matched — what
    // name_similarity below compares against, instead of always the entity's
    // canonical name (see resolveMatchedRegistryName doc for the bug this
    // closes). Non-name-keyed rules keep comparing to canonical, matching
    // their pre-existing (correct) behavior.
    const matchedRegistryName = effectiveMatchKey
      ? resolveMatchedRegistryName(hit, effectiveMatchKey, matchedBrand)
      : (hit.canonicalName ?? "");
    const locality = gradeLocality({
      entityCity: hit.cityToken,
      entityCounty: hit.registeredCountyName,
      orgLocalities: org.localities,
      orgCounties: org.counties,
    });
    // Does Google independently corroborate this entity? Only phone AND name
    // counts — phone alone is how most of those links were made in the first
    // place (see classifyGoogleConfirmation).
    const googleConfirmation = classifyGoogleConfirmation({
      lniPhone: hit.phone,
      googlePhone: hit.googlePhone,
      lniName: hit.canonicalName,
      googleName: hit.googleName,
    });
    const identifier = gradeIdentifierComponent({
      agreement,
      footprint: identifierIndex.footprintByEntity.get(hit.entityId) ?? null,
      googleConfirmation,
    });
    const components: TrustComponents = {
      name: nameComponent,
      identifier,
      locality,
      role: org.role_weight,
      // A.4 — lift by the registry's own corroboration of the entity (bounded;
      // absent on hand-built rows / unpopulated view ⇒ unchanged).
      corroboration: Math.min(
        1,
        org.record_count / 3 + registryCorroborationBonus(hit.recordCount),
      ),
      ruleHistory: rate(ruleKey),
    };
    // Strict auto-bind gate — exact name + same city + shared authoritative trade.
    const registryTradeCodes = new Set((hit.tradeCodes ?? []).map((c) => c.toLowerCase()));
    const gate = evaluateStrictBind({
      ruleKey,
      nameComponent,
      orgNameKey: key,
      registryNormalizedKey: hit.canonicalNameNormalized ? crossNameKey(hit.canonicalNameNormalized) : null,
      // The org's key matched this entity, but NOT via its canonical name ⇒ it
      // came in through a registry DBA alias. Checked structurally rather than
      // relying on the canonical_name_normalized equality above, which is
      // skipped when the contract leaves that column null.
      viaRegistryAlias:
        hit.canonicalName !== null && hit.canonicalName !== undefined
          ? crossNameKey(hit.canonicalName) !== key
          : false,
      locality,
      orgTradeCodes: orgPermitTrades.get(org.id) ?? new Set<string>(),
      registryTradeCodes,
    });
    inserts.push({
      observationType: "binding_name_match",
      organizationId: org.id,
      registryEntityId: hit.entityId,
      ruleKey,
      payload: {
        org_name: org.canonical_name,
        registry_name: hit.canonicalName,
        // Compared against the name that ACTUALLY matched (matchedRegistryName)
        // — not always the canonical. See resolveMatchedRegistryName's doc for
        // the bug this closes: a near-perfect alias/brand match used to display
        // as a near-zero similarity because it was always diffed against the
        // entity's unrelated canonical name.
        name_similarity: nameSimilarity(org.canonical_name, matchedRegistryName),
        // Only populated when the matched name differs from the canonical —
        // null means "matched the canonical itself, nothing extra to show".
        matched_registry_name:
          matchedRegistryName.length > 0 && matchedRegistryName !== (hit.canonicalName ?? "")
            ? matchedRegistryName
            : null,
        phone_evidence: phones.size > 0 ? [...phones] : [],
        registry_phone: hit.phone,
        phone_agrees: hit.phone !== null && phones.has(hit.phone),
        address_evidence: addresses.size > 0 ? [...addresses] : [],
        registry_address:
          ruleKey === "binding_address_match"
            ? [hit.registeredAddress, hit.registeredPostalCode].filter(Boolean).join(" ")
            : null,
        // 4B.3: a shared-address match tells the reviewer HOW shared the key
        // was (1 = unique; ≥2 = dominance-disambiguated suite block).
        shared_address_bucket_size: addressBucketSize,
        // 4B.2 / Phase 4 domain rule: the matched secondary-channel value.
        registry_google_phone: matchedGooglePhone,
        domain_evidence: domains.size > 0 ? [...domains] : [],
        registry_root_domain: matchedDomain,
        // The org name-variant that matched (migration 0031); null for every
        // other rule, so a reviewer always sees WHICH name earned an alias hit.
        matched_alias: matchedAlias,
        // The operating brand this candidate binds to, and its own licence —
        // what the accept stamps instead of the entity's whole licence array.
        matched_brand_name: matchedBrand?.name ?? null,
        matched_brand_licence: matchedBrand?.licence ?? null,
        // The BRAND's own phone (its own L&I record) — distinct from
        // `registry_phone` above, which is always the ENTITY's primary-record
        // phone. Conflating the two is exactly the Rescue Rooter bug: a
        // reviewer saw the parent's number displayed for a sibling brand that
        // has its own, different number on file.
        matched_brand_phone: matchedBrand?.phone ?? null,
        registry_city: hit.cityToken,
        org_localities: org.localities.slice(0, 8),
        // The geography behind the graded `locality` component, so a reviewer can
        // check the band rather than trust the number.
        registry_county: hit.registeredCountyName ?? null,
        org_counties: org.counties.slice(0, 8),
        // Authoritative L&I trade codes the org's permits also point at. A
        // corroborating FACT for the tier, not a score input — the strict gate
        // already computed it, so tiering reuses it rather than re-deriving.
        trade_match: gate.sharedTradeCodes.length > 0,
        shared_trade_codes: gate.sharedTradeCodes,
        // How Google corroborates the ENTITY, and the values a reviewer checks it
        // against. `phone_only` is recorded but never scored as identity — it is
        // usually just how the Google link was made.
        google_confirmation: googleConfirmation,
        registry_google_name: hit.googleName ?? null,
        // What the `identifier` component is actually reporting: agreement on a
        // channel, or (when the org has no evidence) the entity's own footprint.
        identifier_agreement: agreement,
        role_records: org.record_count,
        snapshot: identitySnapshot(hit, matchedBrand),
      },
      components,
      // One suggestion per org+entity pair regardless of which rule found it.
      dedupeKey: `bind:${org.id}:${hit.entityId}`,
      strictAutoBind: gate.strict,
      strictSharedTrades: gate.sharedTradeCodes,
    });
  }

  // ── bound orgs: phone adoption + alias/trade export ──
  const bound = await loadOrgFacts(db, { boundOnly: true });
  for (const org of bound) {
    const row = org.registry_ref ? byEntity.get(org.registry_ref) : undefined;
    if (!row) continue;

    if (row.phone) {
      const components: TrustComponents = {
        name: 1, // binding already reviewed or strong-key exact
        identifier: 1, // the phone IS the L&I identifier for this entity
        locality: 1, // L&I is the phone authority for exactly this entity
        role: org.role_weight,
        corroboration: 1,
        ruleHistory: rate("phone_from_lni"),
      };
      inserts.push({
        observationType: "phone_adoption",
        organizationId: org.id,
        registryEntityId: row.entityId,
        ruleKey: "phone_from_lni",
        // `role` travels in the payload so the accept side-effect labels the
        // contact by its channel (L&I here, Google below).
        payload: { phone: row.phone, registry_name: row.canonicalName, role: "L&I registered phone" },
        components,
        dedupeKey: `phone:${org.id}:${row.phone}`,
      });
    }

    // Google Business phone — an INDEPENDENT lane, not an `else` of the L&I one.
    //
    // It was previously `else if (row.phone)`, which made it dead code: no entity
    // has a Google phone without also having an L&I phone (verified live
    // 2026-07-23: 0 of 25,545), so the branch could never be reached. Yet a
    // DIVERGENCE between the two is exactly the interesting signal — L&I
    // registrations go stale while the Google listing tracks the number the
    // business actually answers. Suppressing it hid ~800 such entities.
    //
    // Both numbers now surface as SEPARATE contacts: `organization_contacts` is
    // deduped by phone and the dedupeKey is phone-scoped, so this ADDS a contact
    // and never replaces the L&I one. L&I remains authoritative everywhere.
    //
    // The divergent case gets its OWN rule key so it builds an independent
    // reviewed accept history — operators consistently accepting it IS the
    // system learning "the Google number is the live one". It never inherits the
    // L&I rule's trust, and it stays review-gated until that history is earned.
    const googlePhoneNormalized = normalizePhoneUS(row.googlePhone);
    if (googlePhoneNormalized && googlePhoneNormalized !== normalizePhoneUS(row.phone)) {
      const divergesFromLni = row.phone !== null && row.phone !== undefined;
      const ruleKey = divergesFromLni ? "phone_from_google_divergent" : "phone_from_google";
      const components: TrustComponents = {
        name: 1, // binding already reviewed or strong-key exact
        identifier: 1, // an accepted Google Business profile phone for this entity
        locality: 1, // the phone belongs to exactly this bound entity
        role: org.role_weight,
        corroboration: 1,
        ruleHistory: rate(ruleKey),
      };
      inserts.push({
        observationType: "phone_adoption",
        organizationId: org.id,
        registryEntityId: row.entityId,
        ruleKey,
        payload: {
          phone: row.googlePhone,
          registry_name: row.canonicalName,
          role: divergesFromLni
            ? "Google Business phone (differs from L&I)"
            : "Google Business phone",
          source: "google_business",
          // The reviewer sees BOTH numbers, so "which is live?" is answerable
          // without leaving the queue. Null when L&I has no phone at all.
          lni_phone: row.phone ?? null,
          diverges_from_lni: divergesFromLni,
        },
        components,
        dedupeKey: `phone:${org.id}:${row.googlePhone}`,
      });
    }

    const orgKey = crossNameKey(org.canonical_name);
    const registryKey = row.canonicalName ? crossNameKey(row.canonicalName) : "";
    if (orgKey && registryKey && orgKey !== registryKey) {
      const components: TrustComponents = {
        name: nameSimilarity(org.canonical_name, row.canonicalName ?? ""),
        identifier: 1, // entity identity already reviewed/strong-key bound
        locality: 1,
        role: org.role_weight,
        corroboration: Math.min(1, org.record_count / 3),
        ruleHistory: rate("alias_name_variant"),
      };
      inserts.push({
        observationType: "alias_export",
        organizationId: org.id,
        registryEntityId: row.entityId,
        ruleKey: "alias_name_variant",
        payload: {
          alias_display: org.canonical_name,
          alias_normalized: orgKey,
          evidence: { role_count: org.record_count },
        },
        components,
        dedupeKey: `alias:${row.entityId}:${orgKey}`,
      });
    }
  }

  // ── trade_export: SHARED-vocabulary trade evidence for bound orgs ──
  // Match the registry trade taxonomy (single source of truth, seeded from L&I
  // license specialties) over each primary_contractor permit. permitType matches
  // are authoritative (the permit IS that trade); title/description matches are
  // DE-RATED and flagged `description`, so the registry loader's human/taxonomy
  // review gate filters GC-misattributions (a GC's building permit that mentions
  // "drywall" is not proof the GC self-performs drywall — the finish sub does).
  // SKIP-SAFE: with no registry taxonomy we use the built-in fallback vocabulary
  // over permitType ONLY, byte-identical to the pre-taxonomy behavior.
  // (tradeMatcher / taxonomyRows / scanDescription are built once, hoisted above
  // the binding loop.)

  const tradeRes = await db.execute(sql`
    SELECT o.id AS organization_id, o.registry_ref,
      upper(coalesce(sr.normalized_json->>'permitType', '')) AS permit_type,
      upper(concat_ws(' ',
        sr.normalized_json->>'permitType',
        sr.normalized_json->>'title',
        left(sr.normalized_json->>'description', 800))) AS scan_text,
      pr.source_record_id::text AS source_record_id
    FROM organizations o
    JOIN project_roles pr ON pr.organization_id = o.id AND pr.role = 'primary_contractor'
    JOIN source_records sr ON sr.id = pr.source_record_id
    WHERE o.registry_ref IS NOT NULL
      AND (sr.normalized_json->>'permitType' IS NOT NULL
        OR (${scanDescription} AND (sr.normalized_json->>'title' IS NOT NULL
                                    OR sr.normalized_json->>'description' IS NOT NULL)))`);

  interface TradeAgg {
    organizationId: string;
    entityId: string;
    tradeCode: string;
    permitRecords: Set<string>;
    descRecords: Set<string>;
    permitSamples: Set<string>;
    descSamples: Set<string>;
  }
  const tradeCounts = new Map<string, TradeAgg>();
  for (const r of tradeRes.rows as Record<string, unknown>[]) {
    const permitType = (r["permit_type"] as string | null) ?? "";
    // Fallback mode scans permitType only (pre-taxonomy behavior); with the
    // shared taxonomy we also scan the title/description text.
    const scanText = scanDescription ? ((r["scan_text"] as string | null) ?? "") : permitType;
    const orgId = r["organization_id"] as string;
    const entityId = r["registry_ref"] as string;
    const srId = r["source_record_id"] as string;
    const permitCodes = new Set(tradeMatcher.match(permitType));
    for (const tradeCode of tradeMatcher.match(scanText)) {
      const key = `${orgId}:${tradeCode}`;
      const entry = tradeCounts.get(key) ?? {
        organizationId: orgId, entityId, tradeCode,
        permitRecords: new Set<string>(), descRecords: new Set<string>(),
        permitSamples: new Set<string>(), descSamples: new Set<string>(),
      };
      if (permitCodes.has(tradeCode)) {
        entry.permitRecords.add(srId);
        if (entry.permitSamples.size < 5) entry.permitSamples.add(permitType);
      } else {
        entry.descRecords.add(srId);
        if (entry.descSamples.size < 5) entry.descSamples.add(scanText.slice(0, 120));
      }
      tradeCounts.set(key, entry);
    }
  }
  const boundById = new Map(bound.map((o) => [o.id, o]));
  for (const t of tradeCounts.values()) {
    const org = boundById.get(t.organizationId);
    const permitN = t.permitRecords.size;
    const descN = t.descRecords.size;
    const total = new Set([...t.permitRecords, ...t.descRecords]).size;
    const matchedOn: "permit_type" | "description" = permitN > 0 ? "permit_type" : "description";
    // permitType evidence is authoritative (role 1). Description-only evidence
    // corroborates but is DE-RATED (role 0.5) and tracked under a distinct rule
    // key, so it surfaces for review and only auto-accepts once reviewers build
    // an independent accept history for the description-derived signal.
    const role = matchedOn === "permit_type" ? 1 : 0.5;
    const ruleKey = matchedOn === "permit_type" ? `trade_${t.tradeCode}` : `trade_${t.tradeCode}_desc`;
    // Corroboration from the entity's AUTHORITATIVE L&I trade codes (contract
    // column `trade_codes`): flags for the reviewer when Insights' permit-derived
    // trade matches a trade the registry already licenses this entity for. This is
    // reviewer metadata ONLY — it does not touch the trust math (so queue/
    // auto-accept behavior is unchanged), and re-exporting the registry's own
    // codes back to the registry would be circular, so we never do that.
    const registryTradeCodes = new Set(
      (byEntity.get(t.entityId)?.tradeCodes ?? []).map((code) => code.toLowerCase()),
    );
    const registryConfirmed = registryTradeCodes.has(t.tradeCode.toLowerCase());
    const components: TrustComponents = {
      name: 1,
      identifier: 1, // entity identity already reviewed/strong-key bound
      locality: 1,
      role,
      corroboration: Math.min(1, total / 3),
      ruleHistory: rate(ruleKey),
    };
    inserts.push({
      observationType: "trade_export",
      organizationId: t.organizationId,
      registryEntityId: t.entityId,
      ruleKey,
      payload: {
        trade_code: t.tradeCode,
        matched_on: matchedOn,
        registry_confirmed: registryConfirmed,
        permit_type_samples: [...t.permitSamples],
        description_samples: matchedOn === "description" ? [...t.descSamples] : [],
        role_count: total,
        evidence: {
          role: "primary_contractor",
          matched_on: matchedOn,
          registry_confirmed: registryConfirmed,
          permit_matches: permitN,
          description_matches: descN,
          org_records: org?.record_count ?? total,
        },
      },
      components,
      dedupeKey: `trade:${t.entityId}:${t.tradeCode}`,
    });
  }

  // ── persist (dedupe; decided rows never resurrected) + auto-accept ──
  // A dry run writes nothing, so it cannot learn from INSERT ... RETURNING which
  // candidates are new. Without this the preview reported 0 for every counter and
  // read as "nothing to queue" when the truth was "counting is skipped" — load the
  // existing keys up front so the preview's numbers mean the same thing an apply's
  // do: rows that WOULD be inserted.
  const existingDedupeKeys = new Set<string>();
  if (opts.dryRun) {
    const res = await db.execute(sql`SELECT dedupe_key FROM registry_observations`);
    for (const r of res.rows as { dedupe_key: string }[]) existingDedupeKeys.add(r.dedupe_key);
  }

  for (const ins of inserts) {
    const trust = computeTrust(ins.components);
    if (trust < MIN_QUEUE_TRUST) {
      summary.belowFloor += 1;
      continue;
    }
    const h = history.get(ins.ruleKey);
    // Non-binding types earn auto-accept from a proven reviewed accept history.
    const historyAutoAccept =
      ins.observationType !== "binding_name_match" &&
      (h?.decisions ?? 0) >= AUTO_ACCEPT_MIN_DECISIONS &&
      (h ? h.accepts / h.decisions : 0) >= AUTO_ACCEPT_MIN_RATE;
    // Binding auto-accept is ONLY the strict tier (exact name + same city +
    // shared trade); everything else stays human-reviewed.
    const strictBind = ins.observationType === "binding_name_match" && ins.strictAutoBind === true;

    // Every strict-qualifying candidate is recorded (the read-only preview list),
    // whether or not this pass writes.
    if (strictBind) {
      summary.strictCandidates.push({
        organizationId: ins.organizationId,
        organizationName: String(ins.payload["org_name"] ?? ""),
        registryEntityId: ins.registryEntityId,
        registryName: (ins.payload["registry_name"] as string | null) ?? null,
        city: (ins.payload["registry_city"] as string | null) ?? null,
        sharedTradeCodes: ins.strictSharedTrades ?? [],
        trust,
      });
    }

    if (opts.dryRun) {
      // Preview: write nothing, but report what an apply WOULD queue. An
      // already-present dedupe key is not new work, so it is not counted.
      // `strictAutoBound` stays 0 by definition — nothing is bound here; the
      // strict candidates are listed in `strictCandidates` above.
      if (existingDedupeKeys.has(ins.dedupeKey)) continue;
      summary.byRule[ins.ruleKey] = (summary.byRule[ins.ruleKey] ?? 0) + 1;
      if (ins.observationType === "binding_name_match") summary.bindingCandidates += 1;
      else if (ins.observationType === "phone_adoption") summary.phoneAdoptions += 1;
      else if (ins.observationType === "alias_export") summary.aliasExports += 1;
      else summary.tradeExports += 1;
      continue;
    }

    if (strictBind) {
      // Bind whether the candidate row is NEW or an already-pending row from a
      // pre-strict pass. ON CONFLICT promotes pending→accepted; a human-REJECTED
      // row is never resurrected (WHERE status='pending'); an already-accepted
      // row is a no-op. RETURNING a row ⇒ this call moved it to accepted, so the
      // org must be bound now.
      const snapshot = (ins.payload["snapshot"] as Record<string, unknown> | null) ?? null;
      const up = await db.execute(sql`
        INSERT INTO registry_observations
          (observation_type, organization_id, registry_entity_id, rule_key, payload_json,
           trust_score, trust_components_json, dedupe_key, status, decided_by, decided_at, applied_at)
        VALUES
          (${ins.observationType}, ${ins.organizationId}, ${ins.registryEntityId}, ${ins.ruleKey},
           ${JSON.stringify(ins.payload)}::jsonb, ${trust}, ${JSON.stringify(ins.components)}::jsonb,
           ${ins.dedupeKey}, 'accepted', ${STRICT_BIND_DECIDED_BY}, now(), now())
        ON CONFLICT (dedupe_key) DO UPDATE
          SET status = 'accepted', decided_by = ${STRICT_BIND_DECIDED_BY}, decided_at = now(),
              applied_at = now(), updated_at = now()
          WHERE registry_observations.status = 'pending'
        RETURNING id`);
      if (up.rows.length === 0) continue; // rejected or already-accepted → no bind
      await applyBindingAccept(db, ins.organizationId, ins.registryEntityId, snapshot, STRICT_BIND_METHOD);
      summary.byRule[ins.ruleKey] = (summary.byRule[ins.ruleKey] ?? 0) + 1;
      summary.strictAutoBound += 1;
      continue;
    }

    // RESCORE-ON-CONFLICT. This used to be DO NOTHING, which meant a row scored
    // once kept that score forever: the 254 pending binding candidates were all
    // computed before locality was graded and before the identifier graph
    // existed, so a scoring improvement could never reach the rows an operator
    // is actually looking at. A queue that cannot be re-ranked is not a ranked
    // queue.
    //
    // The WHERE clause is the safety: only rows still PENDING and never decided
    // are touched. A human (or auto) decision freezes the row's score and payload
    // as the evidence the decision was made on — re-writing that would falsify
    // the audit trail, and `applied_at`/`exported_at` downstream depend on it.
    //
    // `xmax = 0` distinguishes a genuine INSERT from an UPDATE, so the summary
    // keeps meaning "new candidates" rather than counting every rescore as new.
    const res = await db.execute(sql`
      INSERT INTO registry_observations
        (observation_type, organization_id, registry_entity_id, rule_key, payload_json,
         trust_score, trust_components_json, dedupe_key, status, decided_by, decided_at)
      VALUES
        (${ins.observationType}, ${ins.organizationId}, ${ins.registryEntityId}, ${ins.ruleKey},
         ${JSON.stringify(ins.payload)}::jsonb, ${trust}, ${JSON.stringify(ins.components)}::jsonb,
         ${ins.dedupeKey},
         ${historyAutoAccept ? "accepted" : "pending"},
         ${historyAutoAccept ? "auto:rule-history" : null},
         ${historyAutoAccept ? new Date().toISOString() : null})
      ON CONFLICT (dedupe_key) DO UPDATE
        SET rule_key = EXCLUDED.rule_key,
            payload_json = EXCLUDED.payload_json,
            trust_score = EXCLUDED.trust_score,
            trust_components_json = EXCLUDED.trust_components_json,
            updated_at = now()
        WHERE registry_observations.status = 'pending'
          AND registry_observations.decided_at IS NULL
      RETURNING id, (xmax = 0) AS inserted`);
    if (res.rows.length === 0) continue;
    if ((res.rows[0] as { inserted?: boolean }).inserted !== true) {
      summary.rescored += 1;
      continue;
    }
    summary.byRule[ins.ruleKey] = (summary.byRule[ins.ruleKey] ?? 0) + 1;
    if (historyAutoAccept) summary.autoAccepted += 1;
    if (ins.observationType === "binding_name_match") summary.bindingCandidates += 1;
    else if (ins.observationType === "phone_adoption") summary.phoneAdoptions += 1;
    else if (ins.observationType === "alias_export") summary.aliasExports += 1;
    else summary.tradeExports += 1;
  }

  opts.logger?.info(
    {
      bindingCandidates: summary.bindingCandidates,
      phoneAdoptions: summary.phoneAdoptions,
      aliasExports: summary.aliasExports,
      tradeExports: summary.tradeExports,
      autoAccepted: summary.autoAccepted,
      strictAutoBound: summary.strictAutoBound,
      dryRun: opts.dryRun === true,
      belowFloor: summary.belowFloor,
      byRule: summary.byRule,
      rescored: summary.rescored,
    },
    "registry-observations generated",
  );
  return summary;
}

export type ReviewTier = "tier1" | "tier2" | "tier3";

export interface ReviewTierInfo {
  tier: ReviewTier;
  /** Short badge label. */
  label: string;
  /** One-line reason a reviewer can trust the grouping. */
  reason: string;
}

/** Human labels for the confidence tiers (highest → lowest). */
export const REVIEW_TIER_LABELS: Record<ReviewTier, string> = {
  tier1: "High confidence",
  tier2: "Medium",
  tier3: "Low · inspect",
};

/**
 * Deterministic confidence tier for a pending observation — the grouping the
 * operator batch-approves by. Binding candidates are tiered by how much
 * INDEPENDENT evidence corroborates the match, counted in points (below):
 *   tier1 — exact name + 2 points: one step from the auto-bound strict tier;
 *   tier2 — exact name + 1 point, or a unique phone/address/domain identifier
 *           with a plausible name;
 *   tier3 — exact name and NOTHING else, a contradicted identifier, or a weak /
 *           secondary channel only (google phone, low-similarity name).
 *
 * A name alone is tier3 by design. It reads as a demotion but is the honest
 * reading: an exact name match with no corroborating fact is precisely the case
 * a reviewer must actually look at, and the queue's own shape says so — 254 of
 * the 278 pending rows are exact-name matches, so "exact name" is the baseline,
 * not evidence.
 * Non-binding types (phone/alias/trade — always for an already-bound org, so
 * lower identity risk) tier by trust band. Pure — unit-tested, reused by the
 * review page.
 */
export function classifyReviewTier(o: {
  observationType: string;
  ruleKey: string;
  trustScore: number;
  trustComponents: Record<string, number>;
  payload: Record<string, unknown>;
}): ReviewTierInfo {
  const info = (tier: ReviewTier, reason: string): ReviewTierInfo => ({
    tier,
    label: REVIEW_TIER_LABELS[tier],
    reason,
  });

  if (o.observationType !== "binding_name_match") {
    // Enrichment of an already-bound org — identity is settled; band by trust.
    if (o.trustScore >= 0.8) return info("tier1", "high trust · org already bound");
    if (o.trustScore >= 0.65) return info("tier2", "medium trust · org already bound");
    return info("tier3", "low trust");
  }

  const c = o.trustComponents;
  // An alias hit is an exact name hit on a name the org was also published
  // under — same gates, same evidence quality, so it tiers the same way. (It
  // still can't auto-bind: that gate is `evaluateStrictBind`, not this.)
  const nameExact =
    (o.ruleKey === "binding_name_exact" ||
      o.ruleKey === "binding_name_phone" ||
      o.ruleKey === "binding_alias_exact" ||
      // A UNIQUE one-word key is an exact name hit and tiers as one. The reason
      // it is a separate rule is auto-bind eligibility, not evidence quality,
      // and a reviewer still reads the name before accepting.
      o.ruleKey === SINGLE_TOKEN_NAME_RULE) &&
    (c["name"] ?? 0) >= 1;
  const nameSim =
    typeof o.payload["name_similarity"] === "number"
      ? (o.payload["name_similarity"] as number)
      : (c["name"] ?? 0);

  // ── The corroborators, each an independently checkable FACT ──────────────
  const locality = c["locality"] ?? LOCALITY_UNKNOWN;
  const sameCity = locality >= LOCALITY_SAME_CITY;
  const sameCounty = locality >= LOCALITY_SAME_COUNTY;
  const contradictedLocality = locality <= LOCALITY_DIFFERENT_COUNTY;
  const identifier = c["identifier"] ?? IDENTIFIER_ENTITY_TYPICAL;
  // A DE-RATED channel: a Google Business phone is account-entered, not
  // L&I-verified, so it has never been allowed to carry a row on its own. That
  // predates this rewrite and is preserved verbatim.
  const derated = o.ruleKey === "binding_google_phone_match";
  const channel = derated
    ? "Google phone"
    : o.ruleKey === "binding_domain_match"
      ? "root domain"
      : o.ruleKey === "binding_address_match"
        ? "registered address"
        : "L&I phone";

  // An agreeing identifier — strong (unique to the entity) or weak (shared).
  // Below the weak band the component is reporting the entity's own footprint,
  // not agreement, so it is NOT a corroborator. `phone_agrees` is read from the
  // payload too: it is an independently checkable fact, and rows generated
  // before the component was graded carry it when the component does not.
  const identifierAgrees =
    o.payload["phone_agrees"] === true || (!derated && identifier >= IDENTIFIER_AGREES_WEAK);
  const identifierStrong =
    o.payload["phone_agrees"] === true || (!derated && identifier >= IDENTIFIER_AGREES_STRONG);
  const identifierContradicts = identifier <= IDENTIFIER_CONTRADICTS;
  const sharedTrade = o.payload["trade_match"] === true;

  // Contradicted identity is never promoted, whatever else agrees: the org has
  // evidence on this channel and it points at somebody else.
  if (identifierContradicts) return info("tier3", `${channel} CONTRADICTS · inspect`);

  // Corroboration POINTS, weighted by how much each fact narrows identity
  // rather than merely being consistent with it. Two points is the tier1 bar:
  // two independent things beyond the name.
  //
  // The weights are the whole argument, so they are stated plainly:
  //   * a unique identifier is 2 — it maps to exactly one entity, by definition;
  //   * the registered city is 2 — this specific business is registered HERE;
  //   * the county is 1 — right region, but a county holds thousands of firms;
  //   * a shared identifier is 1 — real, but its bucket-mates are live
  //     alternatives;
  //   * a shared trade is 1, and NOT more. It is a plausibility check, not an
  //     identity signal: 61% of the pending queue has it, and "both are
  //     electricians" does not distinguish this entity from the other
  //     electrician with the same name. Scoring it like a city match is what
  //     made 67% of the queue tier1 in the first cut of this function.
  // WA L&I and Google independently agreeing on this business's phone AND its
  // name is worth the full tier1 bar on its own: two systems that never consulted
  // each other landed on the same company. Only `phone_and_name` qualifies —
  // `phone_only` is usually just how the Google link was created.
  const googleConfirmed = o.payload["google_confirmation"] === "phone_and_name";

  let points = 0;
  const corroborators: string[] = [];
  if (googleConfirmed) {
    points += 2;
    corroborators.push("L&I + Google phone agree · Google name matches");
  }
  if (sameCity) {
    points += 2;
    corroborators.push("same city");
  } else if (sameCounty) {
    points += 1;
    corroborators.push("same county");
  }
  if (identifierAgrees) {
    points += identifierStrong ? 2 : 1;
    corroborators.push(`${identifierStrong ? "unique" : "shared"} ${channel}`);
  }
  if (sharedTrade) {
    points += 1;
    corroborators.push("shared trade");
  }

  if (nameExact) {
    const facts = corroborators.join(" + ");
    if (points >= 2) return info("tier1", `exact name + ${facts}`);
    if (points === 1) return info("tier2", `exact name + ${facts}`);
    if (contradictedLocality) {
      return info("tier3", "exact name only, and registered in a different county");
    }
    return info("tier3", "exact name only (nothing corroborates it)");
  }

  // Not an exact name — an identifier channel produced the match, so the name is
  // the thing that has to hold up.
  if (identifierAgrees && nameSim >= 0.5) {
    const extra = corroborators.filter((x) => !x.endsWith(channel));
    const reason = `${identifierStrong ? "unique" : "shared"} ${channel} · name ${nameSim.toFixed(2)}`;
    return info("tier2", extra.length ? `${reason} + ${extra.join(" + ")}` : reason);
  }
  return info("tier3", `${o.ruleKey.replace(/^binding_/, "")} · name ${nameSim.toFixed(2)}`);
}

export interface ObservationListItem {
  id: string;
  observationType: string;
  organizationId: string;
  organizationName: string;
  registryEntityId: string;
  ruleKey: string;
  trustScore: number;
  trustComponents: Record<string, number>;
  payload: Record<string, unknown>;
  status: string;
  decidedBy: string | null;
  createdAt: string;
}

/** The operator's review list: pending observations, highest trust first. */
export async function listRegistryObservations(
  db: Db,
  opts: { status?: string; limit?: number } = {},
): Promise<ObservationListItem[]> {
  const status = opts.status ?? "pending";
  // Cap raised to 500 so the tiered review page can load the whole pending queue
  // in one window (accurate per-tier counts + full-tier batch selection).
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 500);
  const res = await db.execute(sql`
    SELECT ro.id, ro.observation_type, ro.organization_id, o.canonical_name AS organization_name,
      ro.registry_entity_id, ro.rule_key, ro.trust_score, ro.trust_components_json,
      ro.payload_json, ro.status, ro.decided_by, ro.created_at
    FROM registry_observations ro
    JOIN organizations o ON o.id = ro.organization_id
    WHERE ro.status = ${status}
    ORDER BY ro.trust_score DESC, ro.created_at ASC
    LIMIT ${limit}`);
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    id: r["id"] as string,
    observationType: r["observation_type"] as string,
    organizationId: r["organization_id"] as string,
    organizationName: r["organization_name"] as string,
    registryEntityId: r["registry_entity_id"] as string,
    ruleKey: r["rule_key"] as string,
    trustScore: Number(r["trust_score"]),
    trustComponents: (r["trust_components_json"] as Record<string, number>) ?? {},
    payload: (r["payload_json"] as Record<string, unknown>) ?? {},
    status: r["status"] as string,
    decidedBy: (r["decided_by"] as string | null) ?? null,
    createdAt: String(r["created_at"]),
  }));
}

/**
 * Org IDs holding a `primary_contractor` role on any project.
 *
 * These are the organizations whose identity is worth the most: the party that
 * actually holds the permit, rather than an applicant or an incidental mention.
 * Binding one is worth more than binding several peripheral orgs, so the review
 * queue groups them for one-click batch review.
 *
 * READ AT RENDER TIME, DELIBERATELY NOT STAMPED INTO THE PAYLOAD. A role is
 * assigned when a permit is parsed, which can happen long after an observation
 * was generated — a copy frozen into `payload_json` would silently go stale,
 * while this query cannot. The payload's `role_records` count is a different
 * thing (how many role rows the org has), not a primary-contractor flag.
 */
export async function loadPrimaryContractorOrgIds(db: Db): Promise<Set<string>> {
  const res = await db.execute(sql`
    SELECT DISTINCT organization_id FROM project_roles WHERE role = 'primary_contractor'`);
  return new Set((res.rows as Record<string, unknown>[]).map((r) => r["organization_id"] as string));
}

export interface DecisionOutcome {
  status: "accepted" | "rejected";
  /** What the accept applied locally, if anything. */
  applied: "bound_organization" | "contact_created" | "queued_for_export" | null;
}

/**
 * Apply the local side effect of accepting a binding observation: stamp the org
 * with registry_ref (+ provenance + cached identity snapshot) and backfeed the
 * entity's strong keys (UBI / contractor numbers) so the nightly strong-key
 * resolver fires for this contractor's future records. Guarded so it NEVER
 * overwrites an already-bound org (observations are only generated for unbound
 * orgs; failing closed here keeps a strict auto-bind and a human accept from ever
 * clobbering an existing binding). Shared by the human accept path
 * (decideRegistryObservation) and the strict auto-bind path (generate loop).
 */
async function applyBindingAccept(
  db: Db,
  organizationId: string,
  registryEntityId: string,
  snapshot: Record<string, unknown> | null,
  method: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE organizations
    SET registry_ref = ${registryEntityId}, registry_ref_method = ${method},
        registry_linked_at = now(),
        registry_identity_json = ${snapshot ? JSON.stringify(snapshot) : null}::jsonb
    WHERE id = ${organizationId} AND registry_ref IS NULL`);
  await backfeedAcceptedIdentity(db, organizationId, snapshot);
}

/**
 * Decide one observation. Accepting applies the local side effect immediately
 * (bind / global contact); export types wait for the export step. Every
 * decision updates the rule's accept history for the next generation pass.
 */
export async function decideRegistryObservation(
  db: Db,
  id: string,
  decision: "accept" | "reject",
  opts: { decidedBy: string; note?: string },
): Promise<DecisionOutcome> {
  const res = await db.execute(sql`
    SELECT id, observation_type, organization_id, registry_entity_id, payload_json, status
    FROM registry_observations WHERE id = ${id}`);
  const row = res.rows[0] as
    | { id: string; observation_type: ObservationType; organization_id: string; registry_entity_id: string; payload_json: Record<string, unknown>; status: string }
    | undefined;
  if (!row) throw new Error("observation not found");
  if (row.status !== "pending") throw new Error(`observation already ${row.status}`);

  if (decision === "reject") {
    await db.execute(sql`
      UPDATE registry_observations
      SET status = 'rejected', decided_by = ${opts.decidedBy}, decided_at = now(),
          decision_note = ${opts.note ?? null}, updated_at = now()
      WHERE id = ${id}`);
    return { status: "rejected", applied: null };
  }

  let applied: DecisionOutcome["applied"] = "queued_for_export";
  if (row.observation_type === "binding_name_match") {
    // 4B.4 — applyBindingAccept stamps registry_ref (+ snapshot) and backfeeds the
    // entity's strong keys (UBI / contractor numbers), NULL-only with provenance
    // 'registry_accept', so the nightly strong-key link fires for this
    // contractor's subsequent records. Provenance 'name_review_confirmed' marks a
    // HUMAN accept (the strict auto-bind path uses 'name_strict_auto').
    const snapshot = (row.payload_json["snapshot"] as Record<string, unknown> | null) ?? null;
    await applyBindingAccept(db, row.organization_id, row.registry_entity_id, snapshot, "name_review_confirmed");
    applied = "bound_organization";
  } else if (row.observation_type === "phone_adoption") {
    const phone = String(row.payload_json["phone"] ?? "");
    const registryName = String(row.payload_json["registry_name"] ?? "Registry listing");
    // The channel label ('L&I registered phone' | 'Google Business phone') rides
    // in the payload; default to L&I for observations generated before the field
    // existed (back-compat) so no legacy accept changes behavior.
    const role = String(row.payload_json["role"] ?? "L&I registered phone");
    // GLOBAL public-business contact (migration 0020): NULL account ⇒ visible
    // to every paying account — this IS the reviewed bucket entry.
    await db.execute(sql`
      INSERT INTO organization_contacts (organization_id, account_profile_id, name, role, phone, source_type)
      SELECT ${row.organization_id}, NULL, ${registryName}, ${role}, ${phone}, 'public_business'
      WHERE NOT EXISTS (
        SELECT 1 FROM organization_contacts
        WHERE organization_id = ${row.organization_id} AND account_profile_id IS NULL AND phone = ${phone})`);
    applied = "contact_created";
  }

  await db.execute(sql`
    UPDATE registry_observations
    SET status = 'accepted', decided_by = ${opts.decidedBy}, decided_at = now(),
        decision_note = ${opts.note ?? null},
        applied_at = ${applied === "queued_for_export" ? null : new Date().toISOString()},
        updated_at = now()
    WHERE id = ${id}`);
  return { status: "accepted", applied };
}

/**
 * Canonical dedupe key for an entity↔entity relationship. The pair is ordered
 * (A < B) so the key is identical whichever company the reviewer clicked from,
 * and it matches the registry table's `entity_id_a < entity_id_b` CHECK (Task B1).
 */
export function relationshipDedupeKey(entityIdA: string, entityIdB: string): string {
  const [a, b] = entityIdA < entityIdB ? [entityIdA, entityIdB] : [entityIdB, entityIdA];
  return `relationship:${a}:${b}`;
}

export interface RecordRelationshipInput {
  /** PROVENANCE anchor — "who confirmed it". registry_observations.organization_id
   * is NOT NULL; the CLAIM is the payload's entity_id_a/entity_id_b, not this org. */
  organizationId: string;
  entityIdA: string;
  entityIdB: string;
  /** The shared L&I principal key, when known (nullable — provenance, not the key). */
  principalKey?: string | null;
  /** Entity↔entity corroboration (points + signals) — confidence and evidence. */
  corroboration: EntityCorroboration;
  decidedBy: string;
}

/**
 * Record an ACCEPTED entity↔entity relationship for export — the write path for
 * the corporate-family / principal-person accept action (Phase B).
 *
 * Unlike generated observations there is no prior `pending` row: the human click
 * and the observation's creation are the same event, so this inserts a row that
 * is already `accepted` with `applied_at` NULL, and the nightly
 * `exportRegistryObservations` drains it to `registry_partner.partner_observations`
 * as a `relationship` row for the registry loader (Task B3) to adjudicate into
 * `registry_entity_relationships`. Nothing here binds identity or writes the
 * registry directly — it is review-gated, one click per claim.
 */
export async function recordRelationshipAcceptance(
  db: Db,
  args: RecordRelationshipInput,
): Promise<{ id: string | null; alreadyExisted: boolean }> {
  if (args.entityIdA === args.entityIdB) {
    throw new Error("relationship requires two distinct entities");
  }
  const [entityA, entityB] =
    args.entityIdA < args.entityIdB ? [args.entityIdA, args.entityIdB] : [args.entityIdB, args.entityIdA];
  const dedupeKey = relationshipDedupeKey(entityA, entityB);
  const points = args.corroboration.points;
  const payload = {
    entity_id_a: entityA,
    entity_id_b: entityB,
    relationship_type: "principal_shared",
    principal_key: args.principalKey ?? null,
    confidence: points,
    evidence: args.corroboration,
  };
  // registry_entity_id anchors on entity A (the canonically smaller); the loader
  // reads the pair from the payload and re-sorts, so it never assumes A here.
  const res = await db.execute(sql`
    INSERT INTO registry_observations
      (observation_type, organization_id, registry_entity_id, rule_key, payload_json,
       trust_score, trust_components_json, dedupe_key, status, decided_by, decided_at)
    VALUES
      ('relationship_export', ${args.organizationId}, ${entityA}, 'relationship_principal_shared',
       ${JSON.stringify(payload)}::jsonb, ${Math.min(1, points / 3)},
       ${JSON.stringify({ points })}::jsonb, ${dedupeKey}, 'accepted', ${args.decidedBy}, now())
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING id`);
  if (res.rows.length > 0) {
    return { id: String((res.rows[0] as { id: string }).id), alreadyExisted: false };
  }
  // Already recorded (a prior click, either direction) — no duplicate written.
  const existing = await db.execute(sql`SELECT id FROM registry_observations WHERE dedupe_key = ${dedupeKey}`);
  const id = existing.rows[0] ? String((existing.rows[0] as { id: string }).id) : null;
  return { id, alreadyExisted: true };
}

export interface ExportSummary {
  skipped: boolean;
  observationsExported: number;
  projectFactsExported: number;
}

/** Minimal write surface of a pg.Pool for the registry_partner staging. */
export interface RegistryWriterLike {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const SOURCE_SYSTEM = "otn_insights";

/**
 * Insights export observation_type → registry_partner.partner_observations
 * observation_type. The partner CHECK is `IN ('alias','trade_evidence',
 * 'relationship')` (Task B2); an unmapped type is skipped rather than exported
 * under a wrong label.
 */
const PARTNER_OBSERVATION_TYPE: Record<string, string> = {
  alias_export: "alias",
  trade_export: "trade_evidence",
  relationship_export: "relationship",
};

/**
 * Push accepted export-type observations into registry_partner staging, and
 * refresh per-entity public project-fact rollups (the thin trades link). The
 * writer is injected; null ⇒ visible skip (no REGISTRY_DATABASE_URL).
 */
export async function exportRegistryObservations(
  db: Db,
  writer: RegistryWriterLike | null,
  opts: { logger?: { info: (obj: unknown, msg?: string) => void } } = {},
): Promise<ExportSummary> {
  const summary: ExportSummary = { skipped: false, observationsExported: 0, projectFactsExported: 0 };
  if (writer === null) {
    summary.skipped = true;
    opts.logger?.info({ skipped: true }, "registry export skipped (no REGISTRY_DATABASE_URL)");
    return summary;
  }

  // ── accepted alias/trade observations → partner_observations ──
  const pendingExport = await db.execute(sql`
    SELECT id, observation_type, registry_entity_id, rule_key, payload_json, trust_score, decided_by, decided_at, dedupe_key
    FROM registry_observations
    WHERE status = 'accepted' AND exported_at IS NULL
      AND observation_type IN ('alias_export', 'trade_export', 'relationship_export')
    ORDER BY decided_at ASC`);
  for (const r of pendingExport.rows as Record<string, unknown>[]) {
    const observationType = PARTNER_OBSERVATION_TYPE[String(r["observation_type"])];
    if (!observationType) continue;
    await writer.query(
      `INSERT INTO registry_partner.partner_observations
         (source_system, entity_id, observation_type, payload, trust_score, reviewed_by, reviewed_at, dedupe_key)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        SOURCE_SYSTEM,
        r["registry_entity_id"],
        observationType,
        JSON.stringify(r["payload_json"] ?? {}),
        Number(r["trust_score"]),
        r["decided_by"],
        r["decided_at"],
        `${SOURCE_SYSTEM}:${r["dedupe_key"]}`,
      ],
    );
    await db.execute(sql`
      UPDATE registry_observations SET exported_at = now(), updated_at = now() WHERE id = ${r["id"]}`);
    summary.observationsExported += 1;
  }

  // ── per-entity public project facts (replace-on-export rollup) ──
  const facts = await db.execute(sql`
    SELECT o.registry_ref AS entity_id,
      count(DISTINCT p.id)::int AS project_count,
      count(DISTINCT p.id) FILTER (WHERE p.last_seen_at >= now() - interval '12 months')::int AS project_count_12m,
      array_agg(DISTINCT p.county) AS counties,
      min(p.first_seen_at) AS first_seen,
      max(p.last_seen_at) AS last_seen,
      jsonb_object_agg(DISTINCT pr.role, TRUE) AS roles,
      (
        SELECT jsonb_agg(recent) FROM (
          SELECT jsonb_build_object(
            'name', p2.canonical_name, 'county', p2.county, 'stage', p2.current_stage,
            'role', pr2.role, 'last_seen', p2.last_seen_at,
            'source_url', sr2.normalized_json->>'sourceUrl') AS recent
          FROM project_roles pr2
          JOIN projects p2 ON p2.id = pr2.project_id
          LEFT JOIN source_records sr2 ON sr2.id = pr2.source_record_id
          WHERE pr2.organization_id = o.id
          ORDER BY p2.last_seen_at DESC LIMIT 5
        ) t
      ) AS recent
    FROM organizations o
    JOIN project_roles pr ON pr.organization_id = o.id
    JOIN projects p ON p.id = pr.project_id
    WHERE o.registry_ref IS NOT NULL
    GROUP BY o.id, o.registry_ref`);
  for (const f of facts.rows as Record<string, unknown>[]) {
    await writer.query(
      `INSERT INTO registry_partner.partner_project_facts (entity_id, source_system, facts, exported_at)
       VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (entity_id, source_system) DO UPDATE SET facts = EXCLUDED.facts, exported_at = now()`,
      [
        f["entity_id"],
        SOURCE_SYSTEM,
        JSON.stringify({
          project_count: Number(f["project_count"]),
          // 12-month window for the registry's profile activity badge
          // ("N permits in the last 12 months (via OTN Insights)").
          project_count_12m: Number(f["project_count_12m"] ?? 0),
          counties: f["counties"],
          first_seen: f["first_seen"],
          last_seen: f["last_seen"],
          roles: Object.keys((f["roles"] as Record<string, unknown>) ?? {}),
          recent: f["recent"] ?? [],
        }),
      ],
    );
    summary.projectFactsExported += 1;
  }

  opts.logger?.info(
    { observationsExported: summary.observationsExported, projectFactsExported: summary.projectFactsExported },
    "registry export complete",
  );
  return summary;
}
