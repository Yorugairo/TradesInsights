/**
 * Organization identifiers (migration 0023) — the supply side of
 * identifier-based registry matching. Parsers emit optional
 * phone/ubi/contractorLicense on `organizations[]` entries when a source
 * actually publishes them; this module persists them as evidence-carrying
 * rows and backfeeds strong keys (ubi / contractor number) onto the
 * organization so the existing strong-key registry link binds on its next
 * pass. Nothing here is guessed: absent fields stay absent.
 */
import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";

/** Normalize a US phone to bare 10 digits (strip punctuation and a leading 1).
 * Returns null when the result is not a plausible 10-digit US number. */
export function normalizePhoneUS(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let digits = String(raw).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits.length === 10 ? digits : null;
}

function alnumUpper(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const v = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
  return v.length ? v : null;
}

/** USPS-style street-word abbreviations so "STREET"/"ST", "AVENUE"/"AVE",
 * "SOUTH"/"S" fold to one token across sources. */
const ADDRESS_ABBR: Record<string, string> = {
  STREET: "ST", AVENUE: "AVE", ROAD: "RD", BOULEVARD: "BLVD", DRIVE: "DR",
  LANE: "LN", COURT: "CT", PLACE: "PL", CIRCLE: "CIR", TERRACE: "TER",
  HIGHWAY: "HWY", PARKWAY: "PKWY", TRAIL: "TRL",
  NORTH: "N", SOUTH: "S", EAST: "E", WEST: "W",
  NORTHEAST: "NE", NORTHWEST: "NW", SOUTHEAST: "SE", SOUTHWEST: "SW",
};
/** Secondary-unit designators dropped from the match key: a business is
 * identified by its building/street address; suite/unit values vary between
 * how two systems record the SAME business and would only lose matches. */
const UNIT_DESIGNATORS = new Set([
  "UNIT", "STE", "SUITE", "APT", "APARTMENT", "BLDG", "BUILDING",
  "FL", "FLOOR", "RM", "ROOM", "SPACE", "SPC",
]);
/** A token that looks like a unit VALUE — a short digit-bearing token ("210",
 * "B2") or a lone letter ("A") — dropped when it directly follows a
 * designator. Multi-letter tokens (e.g. a city name after a dangling empty
 * "UNIT ") are kept, so we never eat the locality. */
const looksLikeUnitValue = (t: string | undefined): boolean =>
  t != null && ((/\d/.test(t) && t.length <= 6) || t.length === 1);

/**
 * Normalize a US postal address to a stable, specific match key, or null when
 * it is too generic to match on. Uppercases, folds street/directional words to
 * one form, and drops secondary-unit designators. Requires a street number (or
 * zip) plus at least three tokens — a bare "AUBURN WA" is not a match key.
 * This is the identifier form; it is deliberately stricter than the fuzzy
 * project-address normalizer in normalize.ts.
 */
export function normalizeAddressUS(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const words = String(raw)
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => ADDRESS_ABBR[w] ?? w);

  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (UNIT_DESIGNATORS.has(w)) {
      // Drop the designator, and the following token only if it's a unit value.
      if (looksLikeUnitValue(words[i + 1])) i += 1;
      continue;
    }
    out.push(w);
  }
  if (out.length < 3) return null;
  const key = out.join(" ");
  // Must carry a street number or zip; otherwise it's a city/state fragment
  // that would collide across unrelated businesses.
  if (!/\d/.test(key) || key.length < 8) return null;
  return key;
}

/** Normalize a source-namespaced entity id. The adapter owns the namespace
 * prefix (e.g. "pierce_pals:462942"); here we only trim and require a
 * namespace separator so an unqualified bare id can never pollute the key
 * space and collide across sources. */
export function normalizeSourceEntityId(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const v = String(raw).trim().replace(/\s+/g, " ");
  if (!v.includes(":") || v.length < 3) return null;
  return v;
}

export interface OrgIdentifierInput {
  phone?: string | undefined;
  ubi?: string | undefined;
  contractorLicense?: string | undefined;
  address?: string | undefined;
  sourceEntityId?: string | undefined;
}

/**
 * Upsert the identifiers a record's organization entry carries, then backfeed
 * strong keys onto the organization row when it has none (never overwrite an
 * existing value — conflicts are the review queue's job, not a blind write).
 */
export async function persistOrganizationIdentifiers(
  db: Db,
  organizationId: string,
  sourceRecordId: string,
  input: OrgIdentifierInput,
): Promise<{ upserted: number }> {
  const rows: { type: string; raw: string; normalized: string }[] = [];
  const phone = normalizePhoneUS(input.phone);
  if (phone && input.phone) rows.push({ type: "phone", raw: input.phone, normalized: phone });
  const ubi = alnumUpper(input.ubi);
  if (ubi && ubi.length >= 7 && input.ubi) rows.push({ type: "ubi", raw: input.ubi, normalized: ubi });
  const license = alnumUpper(input.contractorLicense);
  if (license && input.contractorLicense) {
    rows.push({ type: "contractor_number", raw: input.contractorLicense, normalized: license });
  }
  const address = normalizeAddressUS(input.address);
  if (address && input.address) rows.push({ type: "address", raw: input.address, normalized: address });
  const sourceEntityId = normalizeSourceEntityId(input.sourceEntityId);
  if (sourceEntityId && input.sourceEntityId) {
    rows.push({ type: "source_entity_id", raw: input.sourceEntityId, normalized: sourceEntityId });
  }

  let upserted = 0;
  for (const row of rows) {
    await db.execute(sql`
      INSERT INTO organization_identifiers
        (organization_id, identifier_type, value_raw, value_normalized, source_record_id)
      VALUES (${organizationId}, ${row.type}, ${row.raw}, ${row.normalized}, ${sourceRecordId})
      ON CONFLICT (organization_id, identifier_type, value_normalized)
      DO UPDATE SET last_seen_at = now()`);
    upserted += 1;
  }

  // Strong-key backfeed: fill organizations.ubi / contractor_registration only
  // when currently NULL — the strong-key registry link picks them up nightly.
  if (ubi && ubi.length >= 7) {
    await db.execute(sql`
      UPDATE organizations SET ubi = ${ubi} WHERE id = ${organizationId} AND ubi IS NULL`);
  }
  if (license) {
    await db.execute(sql`
      UPDATE organizations SET contractor_registration = ${license}
      WHERE id = ${organizationId} AND contractor_registration IS NULL`);
  }
  return { upserted };
}

/**
 * Resolve an organization already tied to a source-namespaced entity id, or
 * null. Used at resolution time for exact same-source clustering: when a prior
 * record bound this `sourceEntityId` to an org, a new record carrying the same
 * id reuses that org instead of a fuzzy name match (the publisher's own entity
 * authority beats name-string equality). Returns null for an unqualified id.
 */
export async function findOrganizationBySourceEntityId(
  db: Db,
  rawSourceEntityId: string | null | undefined,
): Promise<string | null> {
  const normalized = normalizeSourceEntityId(rawSourceEntityId);
  if (!normalized) return null;
  const res = await db.execute(sql`
    SELECT organization_id FROM organization_identifiers
    WHERE identifier_type = 'source_entity_id' AND value_normalized = ${normalized}
    LIMIT 1`);
  const row = res.rows[0] as { organization_id?: string } | undefined;
  return row?.organization_id ?? null;
}

/** Evidence-backed phones per organization (input to the phone-match rules). */
export async function loadOrganizationPhones(db: Db): Promise<Map<string, Set<string>>> {
  const res = await db.execute(sql`
    SELECT organization_id, value_normalized FROM organization_identifiers
    WHERE identifier_type = 'phone'`);
  const map = new Map<string, Set<string>>();
  for (const r of res.rows as { organization_id: string; value_normalized: string }[]) {
    const set = map.get(r.organization_id) ?? new Set<string>();
    set.add(r.value_normalized);
    map.set(r.organization_id, set);
  }
  return map;
}
