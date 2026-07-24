/**
 * Registry-link resolver — the identity seam between OTN Insights and the One
 * Trade Network registry (docs/integration-one-trade-network.md, Parts B & D).
 *
 * Insights owns the binding on ITS side: it reads the registry's stable contract
 * view (registry_public.trades_identity_v1) and stamps `organizations.registry_ref`
 * with the canonical `entity_id` when a STRONG identifier matches exactly. It never
 * mutates registry identity and never auto-binds on a weak signal (name/phone) —
 * that mirrors the registry's own never-auto-merge-on-weak invariant. Weak-only
 * candidates are left unbound for a future review path.
 *
 * The matcher is a pure function over rows (unit-testable, no network); the
 * orchestrator injects `fetchRows` so tests stub the registry entirely and the
 * worker supplies the live contract-view read.
 */
import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";

/** Minimal read surface of a pg.Pool — avoids a `pg` dependency in this package. */
export interface RegistryPoolLike {
  query(text: string): Promise<{ rows: Record<string, unknown>[] }>;
}

/** One row of registry_public.trades_identity_v1 (the contract shape). */
export interface RegistryIdentityRow {
  entityId: string;
  ubi: string | null;
  contractorNumbers: string[] | null;
  canonicalName: string | null;
  /** The registry's own normalized form (upper, suffix-stripped, &→AND). */
  canonicalNameNormalized: string | null;
  phone: string | null;
  cityToken: string | null;
  stateCode: string | null;
  /** L&I registered address, street-only + separate postal code (surfaced on
   * the contract view 2026-07-19). The match key for parties with no phone/UBI
   * whose name drifts — folded through `addressMatchKey` before comparison. */
  registeredAddress: string | null;
  registeredPostalCode: string | null;
  /** Normalized county of the entity's primary location. The COARSER locality
   * band: a city-token miss is not the same as being in a different part of the
   * state, and county is the only geography both systems hold (Insights projects
   * carry city/county and no coordinates). Optional: absent on hand-built test
   * rows and on a contract older than the geo columns. */
  registeredCountyName?: string | null;
  /** Entity lifecycle status. The contract view pre-filters to 'active'; we read
   * and guard on it (buildRegistryIndex) as defense-in-depth if the view ever
   * widens to expose merged/archived rows. Optional: absent on hand-built test
   * rows, always populated by the live fetch. */
  status?: string | null;
  /** Registry corroboration — source-record count backing this entity (a trust
   * signal folded into the observation-loop corroboration component). */
  recordCount?: number | null;
  /** Registered website root domain (identifier_type 'root_domain'). Surfaced for
   * a future match key; dormant until the registry website lane (Phase 4, Codex)
   * populates domains, so no binding rule reads it yet. */
  rootDomain?: string | null;
  /** When the registry first minted this entity — an age/stability trust signal. */
  firstMintedAt?: string | null;
  /** Secondary business phone from the entity's Google Business profile (gated by
   * the registry to accepted, publicly-surfaceable links). SECONDARY to the L&I
   * `phone`: surfaced/adopted only when L&I `phone` is absent — L&I stays
   * authoritative (`phone_write_policy = 'lni_phone_authoritative'`). Optional:
   * absent on hand-built test rows, populated by the live fetch. */
  googlePhone?: string | null;
  /** Google Business rating signal ∈ [0,5], and its review count. A score-neutral
   * GC-quality signal downstream (spec §12.3); never a match key. */
  googleRating?: number | null;
  googleReviewCount?: number | null;
  /** The entity's authoritative L&I trade codes, primary-first (e.g. ["drywall"]).
   * Drives the score-neutral `trade_match` signal + display; never a match key. */
  tradeCodes?: string[] | null;
  /** Other registered business names this entity operates under, from L&I
   * (`alias_type = 'dba'`): one UBI often holds several licences under different
   * names and mint kept only one. UNLIKE the signals above these ARE match keys —
   * a permit naming a DBA must be able to reach the entity. Optional/null-safe so
   * an older contract without the column degrades to canonical-only matching. */
  aliases?: string[] | null;
  /** The entity's full OPERATING-BRAND roster, canonical included and flagged.
   * WA L&I is two-level: the UBI is the legal entity (shared), the contractor
   * LICENCE is the operating brand (unique per brand) — so this is what makes a
   * brand addressable rather than merely matchable. Optional/null-safe: an older
   * contract without the column degrades to enterprise-only identity. */
  brands?: RegistryBrand[] | null;
  /** The entity's L&I principals (officers/owners), registered agents already
   * filtered out registry-side. This is the CORPORATE-FAMILY key: common control
   * sits above the UBI, so two entities sharing a principal are one buying
   * decision-maker even though L&I gives them separate UBIs.
   *
   * PRIVATE-INDIVIDUAL DATA. May be read and displayed only behind
   * `currentSession()` (every `/app/*` route); never on a public page, a pSEO
   * surface, or a digest to a non-customer.
   *
   * NEVER a name match key: a principal links ENTITIES to each other. It must not
   * enter `byNameKey`, become an org alias, or let a permit naming a person match
   * a business. Optional/null-safe so an older contract degrades to no families. */
  principals?: RegistryPrincipal[] | null;
}

/** One L&I principal of a registry entity (contract column `principals`). */
export interface RegistryPrincipal {
  /** The raw L&I spelling, for human review. */
  name: string;
  /** The registry's normalized `SURNAME, GIVEN M` key — what groups a family.
   * Produced by `registry_internal.normalize_principal()`, which is the
   * authoritative definition; never re-derive it from `name` here. */
  key: string;
}

/** One operating brand of a registry entity (contract column `brands`). */
export interface RegistryBrand {
  name: string;
  /** The brand's own contractor licence. Null when L&I published none — unknown,
   * never inferred from a sibling brand. */
  licence: string | null;
  /** The brand's OWN phone, from ITS OWN L&I record — NOT the entity's primary
   * phone (`RegistryIdentityRow.phone`). A multi-brand entity's canonical
   * record's phone belongs to that one brand, not the others; showing it as
   * evidence for a different brand is exactly the bug this field fixes (a
   * reviewer saw the parent's number displayed for a sibling brand that has
   * its own, different number on file). Null when that record carries none —
   * unknown, never inferred from a sibling. */
  phone: string | null;
  /** True for the entity's canonical name; false for a DBA. */
  isCanonical: boolean;
}

/**
 * Public identity snapshot cached on organizations.registry_identity_json.
 *
 * `brand` names the ONE operating brand this org was matched to (when known).
 * It is what the accept-side backfeed stamps: without it the accept would stamp
 * the entity's whole licence array and fuse distinct brands into one org.
 */
export function identitySnapshot(
  row: RegistryIdentityRow,
  brand?: RegistryBrand | null,
): Record<string, unknown> {
  return {
    // Unknown brand stays null — an enterprise-level bind (UBI strong key, no
    // name match) legitimately has no brand, and guessing one would fuse rows.
    brand_name: brand?.name ?? null,
    brand_licence: brand?.licence ?? null,
    entity_id: row.entityId,
    canonical_name: row.canonicalName,
    ubi: row.ubi,
    contractor_numbers: row.contractorNumbers ?? [],
    phone: row.phone,
    city: row.cityToken,
    state: row.stateCode,
    // Enriched contract columns (2026-07-20) cached for the digest/scorer to read
    // downstream (B.3/B.5) without a second registry round-trip. Google phone is a
    // SECONDARY channel — L&I `phone` above stays authoritative.
    google_phone: row.googlePhone ?? null,
    google_rating: row.googleRating ?? null,
    google_review_count: row.googleReviewCount ?? null,
    trade_codes: row.tradeCodes ?? null,
    snapshot_at: new Date().toISOString(),
  };
}

export type RegistryMatchMethod = "ubi_exact" | "contractor_number_exact";

export interface RegistryMatch {
  entityId: string;
  method: RegistryMatchMethod;
  /** 1.0 for a strong-identifier exact match (deterministic). */
  confidence: number;
  registryName: string | null;
}

/** Normalize an identifier the SAME way the registry does (alnum, upper). */
export function normalizeIdentifier(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const v = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
  return v.length ? v : null;
}

export interface RegistryIndex {
  byUbi: Map<string, RegistryIdentityRow>;
  byContractorNumber: Map<string, RegistryIdentityRow>;
}

/** Build strong-identifier lookup maps from contract-view rows. */
export function buildRegistryIndex(rows: RegistryIdentityRow[]): RegistryIndex {
  const byUbi = new Map<string, RegistryIdentityRow>();
  const byContractorNumber = new Map<string, RegistryIdentityRow>();
  for (const row of rows) {
    // Lineage safety (A.2): the contract view pre-filters to active entities, but
    // if it ever surfaces merged/archived rows, never index a superseded entity.
    // Only skip on an explicit non-active status; absent status ⇒ treat as active
    // (backward-compatible with hand-built rows and the pre-filtered view).
    if (row.status != null && row.status !== "active") continue;
    const ubi = normalizeIdentifier(row.ubi);
    if (ubi && !byUbi.has(ubi)) byUbi.set(ubi, row);
    for (const cn of row.contractorNumbers ?? []) {
      const n = normalizeIdentifier(cn);
      if (n && !byContractorNumber.has(n)) byContractorNumber.set(n, row);
    }
  }
  return { byUbi, byContractorNumber };
}

export interface OrgIdentity {
  ubi: string | null;
  contractorRegistration: string | null;
}

export type RegistryMatchOutcome =
  | { kind: "matched"; match: RegistryMatch }
  | { kind: "none" }
  /** Strong identifiers point at DIFFERENT entities — never auto-bind a conflict. */
  | { kind: "conflict"; ubiEntityId: string; contractorEntityId: string };

/**
 * Pure matcher: resolve one organization against the registry index by strong
 * identifier. UBI is the primary key (1:1 in the registry); contractor number is
 * the fallback. If both are present and disagree, it is a conflict (unbound).
 */
export function matchOrganizationToRegistry(org: OrgIdentity, index: RegistryIndex): RegistryMatchOutcome {
  const ubi = normalizeIdentifier(org.ubi);
  const cn = normalizeIdentifier(org.contractorRegistration);
  const ubiHit = ubi ? index.byUbi.get(ubi) : undefined;
  const cnHit = cn ? index.byContractorNumber.get(cn) : undefined;

  if (ubiHit && cnHit && ubiHit.entityId !== cnHit.entityId) {
    return { kind: "conflict", ubiEntityId: ubiHit.entityId, contractorEntityId: cnHit.entityId };
  }
  if (ubiHit) {
    return { kind: "matched", match: { entityId: ubiHit.entityId, method: "ubi_exact", confidence: 1, registryName: ubiHit.canonicalName } };
  }
  if (cnHit) {
    return {
      kind: "matched",
      match: { entityId: cnHit.entityId, method: "contractor_number_exact", confidence: 1, registryName: cnHit.canonicalName },
    };
  }
  return { kind: "none" };
}

export interface RegistryLinkSummary {
  /** True when no registry connection was available — visible skipped state. */
  skipped: boolean;
  registryRows: number;
  scanned: number;
  bound: number;
  alreadyLinked: number;
  conflicts: number;
  byMethod: Record<RegistryMatchMethod, number>;
}

interface OrgRow {
  id: string;
  ubi: string | null;
  contractor_registration: string | null;
  registry_ref: string | null;
}

export interface RegistryLinkOptions {
  /** Injected registry read — the worker supplies the live contract-view query;
   * tests supply a stub. Returning null means "no registry available" (skip). */
  fetchRows: () => Promise<RegistryIdentityRow[] | null>;
  /** Re-evaluate already-linked orgs too (e.g. to repair drift). Default false. */
  force?: boolean;
  logger?: { info: (obj: unknown, msg?: string) => void };
}

/**
 * Query the live contract view. Selects only the identity fields the matcher
 * needs; the reader role has SELECT on the view alone (contract boundary).
 */
export async function fetchRegistryIdentityRows(pool: RegistryPoolLike): Promise<RegistryIdentityRow[]> {
  const columns = (optional: string[]): string =>
    `SELECT entity_id, ubi, contractor_numbers, canonical_name, canonical_name_normalized,
            phone, city_token, state_code, registered_address, registered_postal_code,
            status, record_count, root_domain, first_minted_at,
            google_phone, google_rating, google_review_count, trade_codes${optional.map((c) => `, ${c}`).join("")}
       FROM registry_public.trades_identity_v1`;

  // `aliases`, `brands`, `principals` and `registered_county_name` are the
  // newest contract columns. If Insights deploys ahead of any of those registry
  // migrations, selecting a missing column throws 42703 and would take the WHOLE
  // registry read down (silently skipping binding). Degrade one column at a time
  // instead — newest first — so the newest lane goes quiet while everything else
  // keeps working. ONLY 42703 is swallowed; a connection or permission error
  // still propagates, because those must never look like "no registry data".
  //
  // `registered_county_name` is the LAST to be dropped even though it predates
  // the jsonb columns: losing it degrades locality to the old binary behaviour
  // for every row, whereas losing `principals` only quiets the family lane.
  const ladder = [
    ["aliases", "brands", "principals", "registered_county_name"],
    ["aliases", "brands", "registered_county_name"],
    ["aliases", "registered_county_name"],
    ["registered_county_name"],
    [],
  ];
  let res: { rows: Record<string, unknown>[] } | undefined;
  for (const [i, optional] of ladder.entries()) {
    try {
      res = await pool.query(columns(optional));
      break;
    } catch (err) {
      const isMissingColumn = (err as { code?: string } | null)?.code === "42703";
      if (!isMissingColumn || i === ladder.length - 1) throw err;
    }
  }
  if (!res) throw new Error("registry identity query produced no result");
  return res.rows.map((r: Record<string, unknown>) => ({
    entityId: r["entity_id"] as string,
    ubi: (r["ubi"] as string | null) ?? null,
    contractorNumbers: (r["contractor_numbers"] as string[] | null) ?? null,
    canonicalName: (r["canonical_name"] as string | null) ?? null,
    canonicalNameNormalized: (r["canonical_name_normalized"] as string | null) ?? null,
    phone: (r["phone"] as string | null) ?? null,
    cityToken: (r["city_token"] as string | null) ?? null,
    stateCode: (r["state_code"] as string | null) ?? null,
    registeredAddress: (r["registered_address"] as string | null) ?? null,
    registeredPostalCode: (r["registered_postal_code"] as string | null) ?? null,
    registeredCountyName: (r["registered_county_name"] as string | null) ?? null,
    status: (r["status"] as string | null) ?? null,
    recordCount: r["record_count"] == null ? null : Number(r["record_count"]),
    rootDomain: (r["root_domain"] as string | null) ?? null,
    firstMintedAt: (r["first_minted_at"] as string | null) ?? null,
    googlePhone: (r["google_phone"] as string | null) ?? null,
    googleRating: r["google_rating"] == null ? null : Number(r["google_rating"]),
    googleReviewCount: r["google_review_count"] == null ? null : Number(r["google_review_count"]),
    tradeCodes: (r["trade_codes"] as string[] | null) ?? null,
    aliases: (r["aliases"] as string[] | null) ?? null,
    brands: parseBrands(r["brands"]),
    principals: parsePrincipals(r["principals"]),
  }));
}

/** Defensive read of the `brands` jsonb column: keep only well-formed entries so
 * a malformed row can never fabricate a licence. Unknown licence stays null. */
function parseBrands(raw: unknown): RegistryBrand[] | null {
  if (!Array.isArray(raw)) return null;
  const brands: RegistryBrand[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const name = typeof rec["name"] === "string" ? rec["name"].trim() : "";
    if (!name) continue;
    brands.push({
      name,
      licence: typeof rec["licence"] === "string" && rec["licence"].length > 0 ? rec["licence"] : null,
      phone: typeof rec["phone"] === "string" && rec["phone"].length > 0 ? rec["phone"] : null,
      isCanonical: rec["is_canonical"] === true,
    });
  }
  return brands.length > 0 ? brands : null;
}

/** Defensive read of the `principals` jsonb column. BOTH fields are required:
 * a principal without its normalized key cannot group a family, and one without
 * a display name cannot be reviewed by a human — either way, dropping the entry
 * is correct. The key is never re-derived from the name; the registry's SQL
 * normalizer is the single definition. */
function parsePrincipals(raw: unknown): RegistryPrincipal[] | null {
  if (!Array.isArray(raw)) return null;
  const principals: RegistryPrincipal[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const name = typeof rec["name"] === "string" ? rec["name"].trim() : "";
    const key = typeof rec["key"] === "string" ? rec["key"].trim() : "";
    if (!name || !key) continue;
    principals.push({ name, key });
  }
  return principals.length > 0 ? principals : null;
}

/**
 * Bind organizations to canonical registry entities by strong identifier.
 * Idempotent: an org already bound to the same entity is left untouched; a
 * changed binding (force) is rewritten with fresh provenance.
 */
export async function linkRegistry(db: Db, opts: RegistryLinkOptions): Promise<RegistryLinkSummary> {
  const byMethod: Record<RegistryMatchMethod, number> = { ubi_exact: 0, contractor_number_exact: 0 };
  const summary: RegistryLinkSummary = {
    skipped: false, registryRows: 0, scanned: 0, bound: 0, alreadyLinked: 0, conflicts: 0, byMethod,
  };

  const rows = await opts.fetchRows();
  if (rows === null) {
    summary.skipped = true;
    opts.logger?.info({ skipped: true }, "registry-link skipped (no REGISTRY_DATABASE_URL)");
    return summary;
  }
  summary.registryRows = rows.length;
  const index = buildRegistryIndex(rows);
  const byEntity = new Map(rows.map((r) => [r.entityId, r]));

  const orgRes = await db.execute(sql`
    SELECT id, ubi, contractor_registration, registry_ref
    FROM organizations
    WHERE (ubi IS NOT NULL OR contractor_registration IS NOT NULL)
      ${opts.force ? sql`` : sql`AND registry_ref IS NULL`}`);
  const orgs = orgRes.rows as unknown as OrgRow[];
  summary.scanned = orgs.length;

  for (const org of orgs) {
    const outcome = matchOrganizationToRegistry(
      { ubi: org.ubi, contractorRegistration: org.contractor_registration },
      index,
    );
    if (outcome.kind === "conflict") {
      summary.conflicts += 1;
      continue;
    }
    if (outcome.kind === "none") continue;

    const { entityId, method } = outcome.match;
    if (org.registry_ref === entityId) {
      summary.alreadyLinked += 1;
      continue;
    }
    // IS DISTINCT FROM guards the no-op write; only a genuine (re)bind touches the row.
    const snapshot = byEntity.has(entityId) ? identitySnapshot(byEntity.get(entityId)!) : null;
    await db.execute(sql`
      UPDATE organizations
      SET registry_ref = ${entityId}, registry_ref_method = ${method}, registry_linked_at = now(),
          registry_identity_json = ${snapshot ? JSON.stringify(snapshot) : null}::jsonb
      WHERE id = ${org.id} AND registry_ref IS DISTINCT FROM ${entityId}`);
    summary.bound += 1;
    byMethod[method] += 1;
  }

  opts.logger?.info(
    { registryRows: summary.registryRows, scanned: summary.scanned, bound: summary.bound, alreadyLinked: summary.alreadyLinked, conflicts: summary.conflicts, byMethod },
    "registry-link complete",
  );
  return summary;
}
