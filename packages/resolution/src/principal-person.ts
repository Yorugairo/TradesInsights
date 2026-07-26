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
 *    null for anything business-shaped, and — the load-bearing half — requires
 *    the surname to be one L&I actually records for a real principal. The index
 *    here is entirely separate from `byNameKey`, which stays the business index.
 * 2. **Nothing here binds.** A match is a REVIEW ARTEFACT for an authenticated
 *    surface. It does not stamp `registry_ref`, create an identifier, or feed
 *    `evaluateStrictBind`.
 *
 * ── Why the key is coarse, and what pays for it ──────────────────────────────
 *
 * The registry key is `SURNAME, GIVEN M`. Permit data writes `First Last` with
 * no middle name at all, so matching on the full key would find almost nothing.
 * The coarse `SURNAME|GIVEN` key finds matches — and pays for it in collisions.
 *
 * The collisions are not hypothetical: L&I records three different people named
 * `STEWART, JAMES *`. So every pair carries explicit evidence — how many
 * namesakes L&I knows, whether a middle initial agrees or CONFLICTS, whether the
 * surname echoes the company, whether the geography lines up — and the reviewer
 * reads that, not a bare name match.
 */

import type { CorroborationSignal, CorroborationVerdict } from "./entity-corroboration.js";
import { middleInitial } from "./entity-corroboration.js";
import type { RegistryIdentityRow } from "./registry-link.js";

/**
 * Tokens that mark a name as a BUSINESS rather than a person.
 *
 * A denylist can never be finished — live data caught `CHEHALIS SHEET METAL`,
 * `SOUTH SOUND SOLAR`, `COLUMBIA POOLS` and `BUTLER SURVEYING` slipping an
 * earlier version of this list. It is kept as a cheap first pass, but the
 * SURNAME ALLOWLIST below is what actually makes the gate sound.
 */
const BUSINESS_TOKENS = new Set([
  "LLC", "INC", "CORP", "CORPORATION", "CO", "COMPANY", "PLLC", "LTD", "LP", "LLP",
  "PS", "PC", "GROUP", "SERVICE", "SERVICES", "SVC", "SVCS", "CONSTRUCTION",
  "CONTRACTING", "CONTRACTOR", "CONTRACTORS", "PLUMBING", "ELECTRIC", "ELECTRICAL",
  "HEATING", "COOLING", "ROOFING", "HVAC", "MECHANICAL", "BUILDER", "BUILDERS",
  "BUILDING", "DEVELOPMENT", "DEVELOPERS", "ENTERPRISE", "ENTERPRISES", "HOLDING",
  "HOLDINGS", "PROPERTIES", "PROPERTY", "ASSOCIATES", "PARTNERS", "PARTNERSHIP",
  "SOLUTIONS", "SYSTEMS", "INDUSTRIES", "CONCRETE", "PAINTING", "LANDSCAPING",
  "REMODELING", "REMODEL", "HOMES", "HOME", "TRUST", "BANK", "CHURCH", "CITY",
  "COUNTY", "SCHOOL", "DISTRICT", "AND", "THE", "OF", "DBA", "ESTATE", "FAMILY",
  "REVOCABLE", "LIVING", "INVESTMENTS", "MANAGEMENT", "CONSULTING", "DESIGN",
  "SUPPLY", "METAL", "SIGNS", "SOLAR", "STEEL", "POOLS", "SURVEYING", "WAREHOUSE",
  "RESTORATION", "RECREATION", "ENERGY", "WATER", "SHEET", "CLEANING",
]);

/** Generational suffixes — dropped, never treated as a given or family name. */
const SUFFIXES = new Set(["JR", "SR", "II", "III", "IV"]);

/** Upper-case and keep only letters, commas and spaces — the SAME character
 * treatment `registry_internal.normalize_principal` applies, so a key derived
 * here and a key derived there can never disagree on punctuation. */
function cleanNameChars(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z, ]/g, "").replace(/\s+/g, " ").trim();
}

/** Name parts pulled out of either convention, or null when not person-shaped. */
interface NameParts {
  surname: string;
  given: string;
  /** Middle initial when the name carries one, else null. */
  middle: string | null;
}

function parsePersonName(raw: string | null | undefined): NameParts | null {
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
  // Two or three name tokens is a person. One cannot be keyed on; four or more
  // is a business or a multi-party string, not a name to guess at.
  if (named.length < 2 || named.length > 3) return null;

  if (hasComma) {
    // `Last, First [Middle]` — L&I's convention, unambiguous thanks to the comma.
    const sur = surnamePart.split(" ").filter((t) => t !== "" && !SUFFIXES.has(t));
    const giv = restPart.split(" ").filter((t) => t !== "" && !SUFFIXES.has(t));
    if (!sur[0] || !giv[0]) return null;
    return { surname: sur[0], given: giv[0], middle: giv[1]?.[0] ?? null };
  }
  // `First [Middle] Last` — how permit data writes a person. Read in that order
  // only; a comma-less `SMITH JOHN` is genuinely ambiguous and guessing both
  // orders would double the collision rate of an already-coarse key.
  return {
    surname: named[named.length - 1]!,
    given: named[0]!,
    middle: named.length === 3 ? named[1]![0]! : null,
  };
}

/**
 * Coarse, order-insensitive person key: `SURNAME|GIVEN`, or null when the input
 * is not confidently a person's name.
 *
 * `knownSurnames`, when supplied, is the decisive gate: the surname must be one
 * L&I records for a real principal. That turns an unbounded "is this not a
 * business?" denylist into a bounded "is this a real person's family name?"
 * allowlist over ~26k values. Callers holding the index should always pass it.
 */
export function personCoreKey(
  raw: string | null | undefined,
  knownSurnames?: ReadonlySet<string>,
): string | null {
  const parts = parsePersonName(raw);
  if (!parts) return null;
  if (knownSurnames && !knownSurnames.has(parts.surname)) return null;
  return `${parts.surname}|${parts.given}`;
}

/**
 * Is this "organization" name actually a person?
 *
 * THE BINDING PATH NOW CONSULTS THIS (roadmap P6, enabled 2026-07-25). It gates
 * the IDENTIFIER-COINCIDENCE rules only — phone, Google phone, address, domain —
 * and never a name rule. See `generateRegistryObservations`.
 *
 * IT WAS REJECTED ONCE, ON TWO GROUNDS THAT HAVE BOTH EXPIRED. The original
 * measurement found that of 3,777 unbound orgs, 2,376 were person-shaped and 33
 * of those nonetheless matched a registry entity by name (`JOHNSON CONTROLS`,
 * `CINTAS FIRE PROTECTION`, `JH KELLY`, `RESCUE ROOTER`) — 12.9% of the 256
 * available matches, nearly all real companies. And the safeguard that rescues
 * them ("a registry name match proves it is a business, so never refuse it")
 * could not be trusted while L&I sat at 26,934 of 75,364 records (35.7%): an
 * absent business looks exactly like a homeowner.
 *
 * Both inputs changed:
 *   - the L&I load is COMPLETE — 75,845 licences, 72,952 entities — so the
 *     safeguard vouches against a registry that actually holds the trade;
 *   - that 12.9% was measured WITHOUT `knownSurnames`, so it counted CAPITOL FIRE
 *     PROTECTION and WSP USA as people. Re-measured with the allowlist:
 *     person-shaped 2,376 -> 1,346, person-shaped WITH a registry match 33 -> 10,
 *     total matchable 256 -> 514, cost of refusing 12.9% -> 1.9%.
 *
 * Those last 10 are not lost either — a name match IS the safeguard, so they are
 * never refused. What the refusal blocks is the case it was always aimed at: a
 * person's name with no registry name behind it, bound to a contractor by a
 * shared phone or address. A homeowner shares an address with whoever re-roofed
 * their house.
 *
 * `knownSurnames` should be passed whenever the caller holds it: requiring a real
 * L&I principal surname is strictly stricter, and for a refusal that is the safe
 * direction. It rescues `HYDRO HEROES`, `NW SIGN CREW`, `GENESIS BUILDINGS` — but
 * not `PROJECTS BY PIPER`, because Piper is a genuine surname. It narrows the
 * tail; it does not remove it.
 */
export function isPersonShapedOrgName(
  raw: string | null | undefined,
  knownSurnames?: ReadonlySet<string>,
): boolean {
  return personCoreKey(raw, knownSurnames) !== null;
}

/**
 * The registry's FULL principal key, character-cleaned — `SURNAME, GIVEN M`.
 *
 * This, NOT the coarse key, is what groups a corporate family: both sides of a
 * family are L&I records, so both carry the middle initial when it is known.
 * Grouping families on the coarse key merged `MOORE, MICHAEL L` (Crofton MD)
 * with `MOORE, MICHAEL F` (Ephrata WA) — 463 of 912 entity pairs turned out to
 * carry a middle-initial conflict. Null when the key is not person-shaped.
 */
export function fullPrincipalKey(registryKey: string | null | undefined): string | null {
  if (registryKey == null) return null;
  const cleaned = cleanNameChars(registryKey);
  return cleaned.includes(",") ? cleaned : null;
}

/** The middle initial an Insights-side name carries, if any. */
export function personMiddleInitial(raw: string | null | undefined): string | null {
  return parsePersonName(raw)?.middle ?? null;
}

/**
 * Reduce a registry principal key (`SURNAME, GIVEN M`) to the coarse core key.
 * The registry's format is fixed and authoritative, so this is a pure narrowing
 * — it never re-derives a key from a display name.
 */
export function corePrincipalKey(registryKey: string | null | undefined): string | null {
  if (registryKey == null) return null;
  // Re-run the character clean even though the registry already applied it: the
  // two sides must agree byte-for-byte, and one regex here is cheaper than a
  // silent mismatch if the registry normalizer ever widens.
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
  /** The registry's full `SURNAME, GIVEN M` key — carries the middle initial. */
  principalKey: string;
  cityToken: string | null;
  /** The contract row, so the caller can cite it and compare entity to entity. */
  row: RegistryIdentityRow;
}

/** Coarse-key lookup from person name → the entities that person controls. */
export interface PrincipalPersonIndex {
  byCoreKey: Map<string, PrincipalEntityRef[]>;
  /** Surnames L&I records for real principals — the person-shape allowlist. */
  surnames: Set<string>;
  /** coreKey → the distinct FULL registry keys behind it. Size > 1 means L&I
   * knows more than one person by that name, which is the collision measure. */
  spellingsByCoreKey: Map<string, Set<string>>;
}

/**
 * Build the principal lookup from contract rows. Kept structurally separate from
 * `buildRegistryIndex` / `byNameKey` so there is no path by which a business name
 * can probe it (governance §1).
 */
export function buildPrincipalPersonIndex(rows: RegistryIdentityRow[]): PrincipalPersonIndex {
  const byCoreKey = new Map<string, PrincipalEntityRef[]>();
  const surnames = new Set<string>();
  const spellingsByCoreKey = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.status != null && row.status !== "active") continue;
    for (const p of row.principals ?? []) {
      const core = corePrincipalKey(p.key);
      if (!core) continue;
      surnames.add(core.slice(0, core.indexOf("|")));
      const spellings = spellingsByCoreKey.get(core) ?? new Set<string>();
      spellings.add(cleanNameChars(p.key));
      spellingsByCoreKey.set(core, spellings);

      const list = byCoreKey.get(core) ?? [];
      // One entity appears once per core key even if it files two spellings.
      if (list.some((e) => e.entityId === row.entityId)) continue;
      list.push({
        entityId: row.entityId,
        entityName: row.canonicalName,
        principalName: p.name,
        principalKey: p.key,
        cityToken: row.cityToken,
        row,
      });
      byCoreKey.set(core, list);
    }
  }
  return { byCoreKey, surnames, spellingsByCoreKey };
}

/** An Insights-side person to test against the principal index. */
export interface PersonCandidate {
  /** Where the name came from — an org row that is really a human, or a named
   * contact at a company. The two mean different things in review. */
  source: "organization" | "contact";
  /** The Insights organization this name belongs to (the org itself, or the
   * contact's employer). */
  organizationId: string;
  organizationName: string;
  personName: string;
  /** The org's registry binding, when it has one. */
  registryRef: string | null;
  /** Permitting jurisdictions this person appears in — the geo corroboration. */
  jurisdictions?: string[];
  /** Distinct projects they appear on, and the role they hold. */
  projectCount?: number;
  role?: string | null;
  /** A permit URL, so the Insights side of the claim is citable too. */
  sourceUrl?: string | null;
}

/**
 * ONE (person, registry entity) pair — the unit of review.
 *
 * Person-level rows were unreadable: `Michael Moore` listed Moore Furniture
 * (plausible) beside Gill Group (noise) in a single cell, so the good half and
 * the bad half shared one verdict. Pairs let each be judged on its own evidence.
 */
export interface PrincipalPersonPair {
  candidate: PersonCandidate;
  coreKey: string;
  entity: PrincipalEntityRef;
  /** How many distinct people L&I records under this coarse name. 1 = unique. */
  namesakes: number;
  signals: CorroborationSignal[];
  points: number;
  verdict: CorroborationVerdict;
  explanation: string;
  /** True when the candidate's own org is already bound to this entity — a
   * confirmation of what we know, not a new grouping. */
  alreadyBound: boolean;
}

/** Rank order: strongest evidence first, contradicted last. */
const VERDICT_RANK: Record<CorroborationVerdict, number> = {
  strong: 0,
  corroborated: 1,
  name_only: 2,
  contradicted: 3,
};

/**
 * Match Insights people against registry principals, one row per (person,
 * entity) pair, each carrying its own evidence.
 *
 * Pure and DB-free so the whole lane is unit-testable. Candidates whose name is
 * not confidently person-shaped are dropped by `personCoreKey` — the only gate
 * that matters for governance; everything else is ranking.
 */
export function matchPrincipalsToPeople(
  candidates: PersonCandidate[],
  index: PrincipalPersonIndex,
): PrincipalPersonPair[] {
  const pairs: PrincipalPersonPair[] = [];
  for (const candidate of candidates) {
    const coreKey = personCoreKey(candidate.personName, index.surnames);
    if (!coreKey) continue;
    const entities = index.byCoreKey.get(coreKey);
    if (!entities || entities.length === 0) continue;
    const namesakes = index.spellingsByCoreKey.get(coreKey)?.size ?? 1;

    for (const entity of entities) {
      const signals: CorroborationSignal[] = [];
      const agree = (key: string, label: string) => signals.push({ key, label, agrees: true });
      const against = (key: string, label: string) => signals.push({ key, label, agrees: false });

      // The decisive one, when both sides spell a middle initial.
      const candMid = personMiddleInitial(candidate.personName);
      const regMid = middleInitial(entity.principalKey);
      if (candMid && regMid) {
        if (candMid === regMid) agree("middle_initial", `middle initial agrees (${candMid})`);
        else against("middle_initial", `middle initial differs — permit says ${candMid}, L&I says ${regMid}`);
      }

      if (namesakes === 1) agree("unique_name", "L&I records exactly one person by this name");
      else if (namesakes >= 3) against("common_name", `L&I records ${namesakes} different people by this name`);

      const surname = coreKey.slice(0, coreKey.indexOf("|"));
      if (entity.entityName && entity.entityName.toUpperCase().includes(surname)) {
        agree("surname_echo", `the company name contains "${surname}"`);
      }

      const city = entity.cityToken?.toUpperCase();
      if (city && (candidate.jurisdictions ?? []).some((j) => j.toUpperCase().includes(city))) {
        agree("city", `permits in the company's registered city (${city.toLowerCase()})`);
      }

      if (candidate.role === "primary_contractor") {
        agree("role", "named as the CONTRACTOR on the permit, not merely the applicant");
      }

      const points = signals.filter((s) => s.agrees).length;
      const contradicted = signals.some((s) => !s.agrees && s.key === "middle_initial");
      const verdict: CorroborationVerdict = contradicted
        ? "contradicted"
        : points === 0
          ? "name_only"
          : points >= 3
            ? "strong"
            : "corroborated";

      pairs.push({
        candidate,
        coreKey,
        entity,
        namesakes,
        signals,
        points,
        verdict,
        explanation: explainPair(verdict, points, signals),
        alreadyBound: candidate.registryRef === entity.entityId,
      });
    }
  }

  return pairs.sort(
    (a, b) =>
      VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict] ||
      b.points - a.points ||
      a.namesakes - b.namesakes ||
      a.coreKey.localeCompare(b.coreKey),
  );
}

function explainPair(
  verdict: CorroborationVerdict,
  points: number,
  signals: CorroborationSignal[],
): string {
  const agreed = signals.filter((s) => s.agrees).map((s) => s.label);
  const against = signals.filter((s) => !s.agrees).map((s) => s.label);
  if (verdict === "contradicted") {
    return `Probably a different person of the same name: ${against.join("; ")}.`;
  }
  if (verdict === "name_only") {
    const tail = against.length > 0 ? ` Worse: ${against.join("; ")}.` : "";
    return `Only the name matches — nothing else corroborates it.${tail}`;
  }
  const head = verdict === "strong" ? "Well corroborated" : "Partly corroborated";
  return `${head} — ${points} signal(s): ${agreed.join("; ")}.` +
    (against.length > 0 ? ` Against: ${against.join("; ")}.` : "");
}
