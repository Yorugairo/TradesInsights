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

/**
 * The street+zip5 match key shared by BOTH sides of the registry address match.
 * The registry publishes a street-only address plus a separate postal code; an
 * Insights org address identifier is a full mailing string with the zip inline.
 * This reduces either form to `<street key> <zip5>`: it takes the street line
 * (the text before the first comma — a full mailing string has one, a
 * street-only registry value does not), folds it through `normalizeAddressUS`,
 * and appends the 5-digit zip (from the explicit `zip` arg or found inline).
 * Null when there is no usable street key or no zip5 — never guessed.
 *
 *   addressMatchKey("1210 HOMANN DR SE, LACEY WA 98503")      → "1210 HOMANN DR SE 98503"
 *   addressMatchKey("1210 HOMANN DR SE", "98503")             → "1210 HOMANN DR SE 98503"
 *
 * So the registry's street-only row and an org's full mailing string collapse to
 * the same key. A PO-BOX / mailing-only registered address simply never matches
 * a permit SITE address — correct, not a bug.
 */
export function addressMatchKey(
  address: string | null | undefined,
  zip?: string | null | undefined,
): string | null {
  if (address == null) return null;
  const raw = String(address);
  // zip5 from the explicit arg, else the LAST 5-digit group inline — never the
  // first, because a street NUMBER can be 5 digits ("33820 WEYERHAEUSER WAY").
  const explicitZip = String(zip ?? "").match(/\b(\d{5})(?:-\d{4})?\b/)?.[1] ?? null;
  const inlineZips = raw.match(/\b\d{5}(?:-\d{4})?\b/g);
  const zip5 = explicitZip ?? (inlineZips ? inlineZips[inlineZips.length - 1]!.slice(0, 5) : null);
  if (!zip5) return null;
  // Street line = text before the first comma (registry street-only has none).
  let street = raw.split(",")[0]!;
  // No comma → strip a trailing inline "<STATE> <ZIP>" so "… OLYMPIA WA 98501"
  // still reduces toward the street (city, if inline and comma-less, is left —
  // our sources are comma/street-only, so this is a graceful degrade, not a hit).
  if (!raw.includes(",")) {
    street = street.replace(/\s+[A-Za-z]{2}\s+\d{5}(?:-\d{4})?\s*$/, "");
  }
  const streetKey = normalizeAddressUS(street);
  if (!streetKey) return null;
  return `${streetKey} ${zip5}`;
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

/**
 * WS-B.4 — resolve an incoming org to an existing REGISTRY-BOUND organization
 * that shares a strong identifier (UBI / contractor number), or null. Used as a
 * resolver tier ABOVE the exact-name match so name variants of one bound entity
 * collapse onto the registry-canonical org (accurate roles / velocity / league)
 * instead of spawning a duplicate. Gated to `registry_ref IS NOT NULL`: it never
 * CREATES a binding (that stays the registry-link's job) — it only reuses one the
 * registry already confirmed. Strong identifiers are unique per entity, so a
 * shared normalized key means the same entity. Normalizes the SAME way the
 * persist path does (`alnumUpper`, UBI ≥ 7) so keys line up with the store.
 */
export async function findBoundOrganizationByStrongKey(
  db: Db,
  rawUbi: string | null | undefined,
  rawLicense: string | null | undefined,
): Promise<string | null> {
  const ubi = alnumUpper(rawUbi ?? undefined);
  const license = alnumUpper(rawLicense ?? undefined);
  const hasUbi = !!ubi && ubi.length >= 7;
  const hasLicense = !!license;
  if (!hasUbi && !hasLicense) return null;
  const res = await db.execute(sql`
    SELECT oi.organization_id
    FROM organization_identifiers oi
    JOIN organizations o ON o.id = oi.organization_id
    WHERE o.registry_ref IS NOT NULL
      AND (
        (${hasUbi} AND oi.identifier_type = 'ubi' AND oi.value_normalized = ${ubi ?? ""})
        OR (${hasLicense} AND oi.identifier_type = 'contractor_number' AND oi.value_normalized = ${license ?? ""})
      )
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

/**
 * Evidence-backed registry-address match keys per organization (input to the
 * binding_address_match rule). Reads `value_raw` — the ORIGINAL mailing string
 * with its comma — because `addressMatchKey` needs the comma to split the street
 * line from the "CITY STATE ZIP" tail (the stored `value_normalized` has already
 * had punctuation flattened, so its city can't be dropped). Keys that don't
 * reduce to a street+zip5 are skipped, never guessed.
 */
export async function loadOrganizationAddresses(db: Db): Promise<Map<string, Set<string>>> {
  const res = await db.execute(sql`
    SELECT organization_id, value_raw FROM organization_identifiers
    WHERE identifier_type = 'address'`);
  const map = new Map<string, Set<string>>();
  for (const r of res.rows as { organization_id: string; value_raw: string }[]) {
    const key = addressMatchKey(r.value_raw);
    if (!key) continue;
    const set = map.get(r.organization_id) ?? new Set<string>();
    set.add(key);
    map.set(r.organization_id, set);
  }
  return map;
}
