/**
 * Principal ↔ person matching — the DISCOVERY lane between a registry principal
 * (the officer/owner L&I has on file) and an Insights person: a sole-proprietor
 * "organization" that is really a human, or a named contact at a company.
 *
 * WHY: this is where new groupings come from. An Insights org called
 * `Darrin Erdahl` that we model as an unrelated one-person outfit may in fact be
 * the controlling principal of nine registry entities. Nothing else we hold can
 * see that, because control lives above the UBI.
 *
 * ── The two governance rules this module exists to keep ──────────────────────
 *
 * 1. **A principal is never a business-name match key.** `personCoreKey` returns
 *    null for anything business-shaped, so a permit naming a company can never
 *    reach the principal index — `Hathaway, Collin` must not match a company
 *    called "Collin Hathaway". The index here is entirely separate from
 *    `byNameKey`, which stays the business-name index.
 * 2. **Nothing here binds.** A match is a REVIEW ARTEFACT for an authenticated
 *    surface. It does not stamp `registry_ref`, does not create an identifier,
 *    and does not feed `evaluateStrictBind`.
 *
 * The key is deliberately COARSER than the registry's own `SURNAME, GIVEN M`:
 * permit data writes `First Last` with no middle name at all, so requiring the
 * middle initial would match almost nothing. Coarser means more collisions,
 * which is precisely why this lane is review-only — a human reads the corroborating
 * evidence (shared city, shared trade, project overlap) and decides.
 */

import type { RegistryIdentityRow } from "./registry-link.js";

/**
 * Tokens that mark a name as a BUSINESS rather than a person. Any hit rejects
 * the name outright — a false negative costs one missed discovery row; a false
 * positive would let a company name collide with a private individual, which is
 * the exact failure governance forbids.
 */
const BUSINESS_TOKENS = new Set([
  "LLC", "INC", "CORP", "CORPORATION", "CO", "COMPANY", "PLLC", "LTD", "LP", "LLP",
  "PS", "PC", "GROUP", "SERVICE", "SERVICES", "SVC", "SVCS", "CONSTRUCTION",
  "CONTRACTING", "CONTRACTOR", "CONTRACTORS", "PLUMBING", "ELECTRIC", "ELECTRICAL",
  "HEATING", "COOLING", "ROOFING", "HVAC", "MECHANICAL", "BUILDER", "BUILDERS",
  "BUILDING", "DEVELOPMENT", "DEVELOPERS", "ENTERPRISE", "ENTERPRISES", "HOLDING",
  "HOLDINGS", "PROPERTIES", "PROPERTY", "ASSOCIATES", "PARTNERS", "PARTNERSHIP",
  "SOLUTIONS", "SYSTEMS", "INDUSTRIES", "CONCRETE", "PAINTING", "LANDSCAPING",
  "REMODELING", "HOMES", "HOME", "TRUST", "BANK", "CHURCH", "CITY", "COUNTY",
  "SCHOOL", "DISTRICT", "AND", "THE", "OF", "DBA", "ESTATE", "FAMILY", "REVOCABLE",
  "LIVING", "INVESTMENTS", "MANAGEMENT", "CONSULTING", "DESIGN", "SUPPLY",
]);

/** Generational suffixes — dropped, never treated as a given or family name. */
const SUFFIXES = new Set(["JR", "SR", "II", "III", "IV"]);

/**
 * Coarse, order-insensitive person key: `SURNAME|GIVEN`, or null when the input
 * is not confidently a person's name.
 *
 * Two input conventions are accepted:
 * - `Last, First [Middle]` — L&I's convention, unambiguous thanks to the comma.
 * - `First [Middle] Last` — how permit data writes a person. Read in that order
 *   only; a comma-less `SMITH JOHN` is genuinely ambiguous and guessing both
 *   orders would double the collision rate of an already-coarse key for very
 *   little extra recall.
 *
 * Punctuation is deleted (not spaced) so `O'Brien` and `Smith-Jones` fold to one
 * token — the same treatment `registry_internal.normalize_principal` applies.
 */
/** Upper-case and keep only letters, commas and spaces — the SAME character
 * treatment `registry_internal.normalize_principal` applies, so a key derived
 * here and a key derived there can never disagree on punctuation. */
function cleanNameChars(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z, ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function personCoreKey(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const cleaned = cleanNameChars(String(raw));
  if (cleaned === "") return null;

  const commaAt = cleaned.indexOf(",");
  const hasComma = commaAt >= 0;
  const surnamePart = hasComma ? cleaned.slice(0, commaAt).trim() : "";
  const restPart = hasComma ? cleaned.slice(commaAt + 1).replace(/,/g, " ").trim() : cleaned;

  const tokens = [...surnamePart.split(" "), ...restPart.split(" ")]
    .map((t) => t.trim())
    .filter((t) => t !== "");
  if (tokens.some((t) => BUSINESS_TOKENS.has(t))) return null;

  const named = tokens.filter((t) => !SUFFIXES.has(t));
  // Two or three name tokens is a person. One is not enough to key on; four or
  // more is a business or a multi-party string, not a name we should guess at.
  if (named.length < 2 || named.length > 3) return null;

  if (hasComma) {
    const surname = surnamePart.split(" ").filter((t) => t !== "" && !SUFFIXES.has(t))[0];
    const given = restPart.split(" ").filter((t) => t !== "" && !SUFFIXES.has(t))[0];
    return surname && given ? `${surname}|${given}` : null;
  }
  // `First [Middle] Last` — surname trails.
  const given = named[0]!;
  const surname = named[named.length - 1]!;
  return `${surname}|${given}`;
}

/**
 * Reduce a registry principal key (`SURNAME, GIVEN M`) to the coarse core key.
 * The registry's format is fixed and authoritative, so this is a pure narrowing
 * — it never re-derives a key from a display name.
 */
export function corePrincipalKey(registryKey: string | null | undefined): string | null {
  if (registryKey == null) return null;
  // Re-run the character clean even though the registry already applied it: the
  // two sides must agree byte-for-byte, and paying for one regex here is cheaper
  // than a silent mismatch if the registry normalizer ever widens.
  const cleaned = cleanNameChars(registryKey);
  const commaAt = cleaned.indexOf(",");
  if (commaAt < 0) return null; // agent/org shaped — never grouped
  const surname = cleaned.slice(0, commaAt).trim();
  const given = cleaned.slice(commaAt + 1).trim().split(" ")[0] ?? "";
  return surname && given ? `${surname}|${given}` : null;
}

/** One registry entity a principal controls. */
export interface PrincipalEntityRef {
  entityId: string;
  entityName: string | null;
  /** The principal's raw L&I spelling on THIS entity (spellings differ). */
  principalName: string;
  /** The registry's full `SURNAME, GIVEN M` key. */
  principalKey: string;
  cityToken: string | null;
}

/** Coarse-key lookup from person name → the entities that person controls. */
export interface PrincipalPersonIndex {
  byCoreKey: Map<string, PrincipalEntityRef[]>;
}

/**
 * Build the principal lookup from contract rows. Kept structurally separate from
 * `buildRegistryIndex` / `byNameKey` so there is no path by which a business name
 * can probe it (governance §3).
 */
export function buildPrincipalPersonIndex(rows: RegistryIdentityRow[]): PrincipalPersonIndex {
  const byCoreKey = new Map<string, PrincipalEntityRef[]>();
  for (const row of rows) {
    if (row.status != null && row.status !== "active") continue;
    for (const p of row.principals ?? []) {
      const core = corePrincipalKey(p.key);
      if (!core) continue;
      const list = byCoreKey.get(core) ?? [];
      // One entity appears once per core key even if it files two spellings.
      if (list.some((e) => e.entityId === row.entityId)) continue;
      list.push({
        entityId: row.entityId,
        entityName: row.canonicalName,
        principalName: p.name,
        principalKey: p.key,
        cityToken: row.cityToken,
      });
      byCoreKey.set(core, list);
    }
  }
  return { byCoreKey };
}

/** An Insights-side person to test against the principal index. */
export interface PersonCandidate {
  /** Where the name came from — an org row that is really a human, or a named
   * contact at a company. Displayed in review; the two mean different things. */
  source: "organization" | "contact";
  /** The Insights organization this name belongs to (the org itself, or the
   * contact's employer). */
  organizationId: string;
  organizationName: string;
  /** The name being tested. */
  personName: string;
  /** The org's registry binding, when it has one. A contact matching a principal
   * of a DIFFERENT entity is the interesting case — that is cross-company control. */
  registryRef: string | null;
}

/** A person in Insights who matches a principal of one or more registry entities. */
export interface PrincipalPersonMatch {
  candidate: PersonCandidate;
  coreKey: string;
  /** Every registry entity that principal controls. */
  entities: PrincipalEntityRef[];
  /** True when the candidate's own org is already bound to one of those entities
   * — a confirmation of what we know, not a new grouping. False means the person
   * reaches entities we had no link to: the new learning. */
  alreadyBound: boolean;
}

/**
 * Match Insights people against registry principals.
 *
 * Pure and DB-free so the whole lane is unit-testable. Candidates whose name is
 * not confidently person-shaped are dropped by `personCoreKey`, which is the
 * only gate that matters here — everything downstream is display.
 */
export function matchPrincipalsToPeople(
  candidates: PersonCandidate[],
  index: PrincipalPersonIndex,
): PrincipalPersonMatch[] {
  const matches: PrincipalPersonMatch[] = [];
  for (const candidate of candidates) {
    const coreKey = personCoreKey(candidate.personName);
    if (!coreKey) continue;
    const entities = index.byCoreKey.get(coreKey);
    if (!entities || entities.length === 0) continue;
    matches.push({
      candidate,
      coreKey,
      entities,
      alreadyBound:
        candidate.registryRef != null && entities.some((e) => e.entityId === candidate.registryRef),
    });
  }
  // Most entities reached first — the widest new grouping is the most worth reading.
  return matches.sort(
    (a, b) => b.entities.length - a.entities.length || a.coreKey.localeCompare(b.coreKey),
  );
}
