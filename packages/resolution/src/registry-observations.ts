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
import { identitySnapshot, type RegistryIdentityRow } from "./registry-link.js";
import {
  buildTradeMatcher,
  FALLBACK_TRADE_MATCHER,
  type TradeMatcher,
  type TradeTaxonomyRow,
} from "./trade-taxonomy.js";

export const OBSERVATION_TYPES = [
  "binding_name_match", "phone_adoption", "alias_export", "trade_export",
] as const;
export type ObservationType = (typeof OBSERVATION_TYPES)[number];

/** Queue floor: candidates scoring below this are not worth operator time. */
export const MIN_QUEUE_TRUST = 0.55;
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
  /** Locality corroboration ∈ [0,1]: registry city seen in the org's project counties/cities. */
  locality: number;
  /** Strongest role the org holds on projects (contractor > applicant > owner). */
  role: number;
  /** Independent corroboration: distinct source records naming the org (capped). */
  corroboration: number;
  /** Laplace-smoothed accept rate of this rule from reviewed decisions. */
  ruleHistory: number;
}

export const TRUST_WEIGHTS: Record<keyof TrustComponents, number> = {
  name: 0.3, identifier: 0.15, locality: 0.1, role: 0.1, corroboration: 0.15, ruleHistory: 0.2,
};

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
export const GOOGLE_PHONE_IDENTIFIER_COMPONENT = 0.75;

/** Deterministic weighted trust ∈ [0,1]; stored beside its components. */
export function computeTrust(c: TrustComponents): number {
  let score = 0;
  for (const key of Object.keys(TRUST_WEIGHTS) as (keyof TrustComponents)[]) {
    score += TRUST_WEIGHTS[key] * Math.max(0, Math.min(1, c[key]));
  }
  return Math.round(score * 1000) / 1000;
}

/** Laplace-smoothed accept rate: unreviewed rules start at the 0.5 prior. */
export function laplaceAcceptRate(accepts: number, decisions: number): number {
  return (accepts + 1) / (decisions + 2);
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
}

/** Orgs holding roles on projects, with locality + corroboration facts. */
async function loadOrgFacts(db: Db, opts: { boundOnly?: boolean } = {}): Promise<OrgFacts[]> {
  const res = await db.execute(sql`
    SELECT o.id, o.canonical_name, o.registry_ref,
      max(CASE pr.role WHEN 'primary_contractor' THEN 1.0 WHEN 'applicant' THEN 0.6 ELSE 0.3 END) AS role_weight,
      count(DISTINCT pr.source_record_id)::int AS record_count,
      array_agg(DISTINCT lower(coalesce(sr.normalized_json->>'city', p.county))) AS localities
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
  } = {},
): Promise<GenerateSummary> {
  const summary: GenerateSummary = {
    skipped: false, bindingCandidates: 0, phoneAdoptions: 0, aliasExports: 0, tradeExports: 0, autoAccepted: 0,
    strictAutoBound: 0, strictCandidates: [], belowFloor: 0, byRule: {},
  };
  if (registryRows === null) {
    summary.skipped = true;
    opts.logger?.info({ skipped: true }, "registry-observations skipped (no registry rows)");
    return summary;
  }

  const history = await ruleHistory(db);
  const rate = (ruleKey: string): number => {
    const h = history.get(ruleKey);
    return laplaceAcceptRate(h?.accepts ?? 0, h?.decisions ?? 0);
  };

  // Registry name index (exact cross-key → rows; ambiguous keys are dropped —
  // one Insights name matching MULTIPLE registry entities is not reviewable
  // as a single suggestion and must wait for a stronger key).
  const byNameKey = new Map<string, RegistryIdentityRow[]>();
  for (const row of registryRows) {
    if (!row.canonicalName) continue;
    const key = crossNameKey(row.canonicalName);
    if (!key) continue;
    const bucket = byNameKey.get(key);
    if (bucket) bucket.push(row);
    else byNameKey.set(key, [row]);
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
  const unbound = (await loadOrgFacts(db)).filter((o) => o.registry_ref === null);
  for (const org of unbound) {
    const phones = orgPhones.get(org.id) ?? new Set<string>();
    const addresses = orgAddresses.get(org.id) ?? new Set<string>();
    const domains = orgDomains.get(org.id) ?? new Set<string>();
    const key = crossNameKey(org.canonical_name);
    const nameHits = key && key.split(" ").length >= 2 ? byNameKey.get(key) : undefined;

    let hit: RegistryIdentityRow | undefined;
    let ruleKey = "";
    let nameComponent = 1;
    let identifier = 0.5;
    if (nameHits && nameHits.length === 1) {
      // Unique name match; phone evidence corroborates (1) or contradicts (0).
      hit = nameHits[0]!;
      const phoneAgrees = hit.phone !== null && phones.has(hit.phone);
      identifier = phones.size === 0 ? 0.5 : phoneAgrees ? 1 : 0;
      ruleKey = phoneAgrees ? "binding_name_phone" : "binding_name_exact";
    } else if (nameHits && nameHits.length > 1 && phones.size > 0) {
      // Ambiguous name key — the L&I phone may disambiguate to exactly one.
      const agreeing = nameHits.filter((h) => h.phone !== null && phones.has(h.phone));
      if (agreeing.length === 1) {
        hit = agreeing[0]!;
        identifier = 1;
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
        identifier = 1;
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
        identifier = GOOGLE_PHONE_IDENTIFIER_COMPONENT;
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
        identifier = 1; // the registered address IS the matched L&I identifier
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
        identifier = 1; // the registered website root domain IS the matched identifier
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
          identifier = phones.size === 0 ? 0.5 : phoneAgrees ? 1 : 0;
          ruleKey = "binding_alias_exact";
          matchedAlias = only.alias;
        }
      }
    }
    if (!hit || !ruleKey) continue;

    const locality = hit.cityToken && org.localities.some((l) => l.includes(hit.cityToken!)) ? 1 : 0.3;
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
        name_similarity: nameSimilarity(org.canonical_name, hit.canonicalName ?? ""),
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
        registry_city: hit.cityToken,
        org_localities: org.localities.slice(0, 8),
        role_records: org.record_count,
        snapshot: identitySnapshot(hit),
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
    } else if (row.googlePhone) {
      // L&I phone is ABSENT — surface the entity's SECONDARY Google Business phone
      // (the registry gates it to accepted, publicly-surfaceable links). L&I stays
      // authoritative, so this path only runs when there is no L&I phone to adopt;
      // Google phone NEVER overwrites an L&I phone. A DISTINCT rule key means
      // Google adoptions build their OWN reviewed accept history before any
      // auto-accept — they never inherit the L&I rule's trust.
      const components: TrustComponents = {
        name: 1, // binding already reviewed or strong-key exact
        identifier: 1, // an accepted Google Business profile phone for this entity
        locality: 1, // the phone belongs to exactly this bound entity
        role: org.role_weight,
        corroboration: 1,
        ruleHistory: rate("phone_from_google"),
      };
      inserts.push({
        observationType: "phone_adoption",
        organizationId: org.id,
        registryEntityId: row.entityId,
        ruleKey: "phone_from_google",
        payload: {
          phone: row.googlePhone,
          registry_name: row.canonicalName,
          role: "Google Business phone",
          source: "google_business",
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

    if (opts.dryRun) continue; // preview: compute everything, write nothing

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
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING id`);
    if (res.rows.length === 0) continue;
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
 * operator batch-approves by. Binding candidates are tiered by how many
 * INDEPENDENT strong signals corroborate the match:
 *   tier1 — exact name AND a second strong signal (same city / agreeing L&I
 *           phone / unique root domain): one step from the auto-bound strict tier;
 *   tier2 — exactly one strong signal (exact name alone, or a unique
 *           phone/address/domain identifier with a plausible name);
 *   tier3 — weak or secondary-channel only (google phone, shared-address
 *           dominance, low-similarity name).
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
      o.ruleKey === "binding_alias_exact") &&
    (c["name"] ?? 0) >= 1;
  const sameCity = (c["locality"] ?? 0) >= 1;
  const phoneAgrees =
    o.payload["phone_agrees"] === true ||
    (o.ruleKey === "binding_phone_match" && (c["identifier"] ?? 0) >= 1);
  const domainMatch = o.ruleKey === "binding_domain_match";
  const addressMatch = o.ruleKey === "binding_address_match";
  const nameSim =
    typeof o.payload["name_similarity"] === "number"
      ? (o.payload["name_similarity"] as number)
      : (c["name"] ?? 0);

  if (nameExact && (sameCity || phoneAgrees || domainMatch)) {
    const second = sameCity ? "same city" : phoneAgrees ? "agreeing L&I phone" : "unique domain";
    return info("tier1", `exact name + ${second}`);
  }
  if (nameExact) return info("tier2", "exact name (no city/phone corroboration)");
  if ((phoneAgrees || domainMatch || addressMatch) && nameSim >= 0.5) {
    const kind = phoneAgrees ? "L&I phone" : domainMatch ? "root domain" : "registered address";
    return info("tier2", `${kind} match · name ${nameSim.toFixed(2)}`);
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
      AND observation_type IN ('alias_export', 'trade_export')
    ORDER BY decided_at ASC`);
  for (const r of pendingExport.rows as Record<string, unknown>[]) {
    const observationType = r["observation_type"] === "alias_export" ? "alias" : "trade_evidence";
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
