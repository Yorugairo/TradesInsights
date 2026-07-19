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
}

/** Public identity snapshot cached on organizations.registry_identity_json. */
export function identitySnapshot(row: RegistryIdentityRow): Record<string, unknown> {
  return {
    entity_id: row.entityId,
    canonical_name: row.canonicalName,
    ubi: row.ubi,
    contractor_numbers: row.contractorNumbers ?? [],
    phone: row.phone,
    city: row.cityToken,
    state: row.stateCode,
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
  const res = await pool.query(
    `SELECT entity_id, ubi, contractor_numbers, canonical_name, canonical_name_normalized,
            phone, city_token, state_code, registered_address, registered_postal_code
       FROM registry_public.trades_identity_v1`,
  );
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
  }));
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
