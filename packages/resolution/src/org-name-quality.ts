/**
 * Organization name quality — ONE definition of "is this string a company".
 *
 * The rules below are not new. They were written into a view predicate in
 * migration 0025 and then copy-pasted, character for character, into 0026, 0027
 * and 0028, plus a TypeScript transcription in
 * `packages/intelligence/src/org-activity.ts`. Five copies of a business rule is
 * five places for it to drift, and four of them are inside views that nothing
 * type-checks. This module is the definition; `organizations.name_quality`
 * (migration 0039) is that definition stamped as data so SQL can read it without
 * re-implementing it.
 *
 * THE REGEXES ARE LIFTED VERBATIM from 0026:69-71 — same alternations, same
 * anchoring, same case sensitivity (`~*` → /i, `~` → no flag). Do not "clean
 * them up": the whole point is that a row classified here and a row filtered by
 * the old predicate are the same row.
 *
 * THREE TIERS, AND THE MIDDLE ONE IS THE IMPORTANT ONE:
 *
 *   junk               placeholder text or an id masquerading as a name
 *                      ("SAME AS OWNER", "TBD", "PER PLANS", "PERMIT 20260190")
 *   business           carries a legal/trade/civic entity token
 *   person_or_unknown  neither — overwhelmingly a sole proprietor or an owner
 *                      who pulled their own permit
 *
 * Measured 2026-07-28 on production: 6,220 organizations → ~57 junk, ~3,528
 * person_or_unknown, the rest business. `person_or_unknown` is NOT a quality
 * problem — "JOHN SMITH" is a real contractor with a real licence. It is
 * excluded from the GC-name lateral because a GC lead needs a company to call,
 * not because the row is bad. Anything that treats this tier like `junk` is a
 * bug: it would discard 3,528 legitimate organizations.
 */

export type OrgNameQuality = "business" | "person_or_unknown" | "junk";

export const ORG_NAME_QUALITIES: readonly OrgNameQuality[] = [
  "business",
  "person_or_unknown",
  "junk",
];

/**
 * Placeholder prefixes. VERBATIM from 0026:70 (`!~*`). The `$` anchors inside
 * the alternation are deliberate and load-bearing: `NA$` matches the whole
 * string "NA" but not "NAVARRO CONSTRUCTION"; likewise `OWNER$`, `APPLICANT$`.
 * JavaScript and POSIX agree on `$` here (no multiline flag either side).
 */
const PLACEHOLDER_RE =
  /^(NO |NOT |N\/A|NA$|UNKNOWN|NONE|OWNER$|SAME AS|TBD|SEE |APPLICANT$|PER PLANS)/i;

/**
 * Three or more consecutive digits. VERBATIM from 0026:71 (`!~`, case-blind by
 * nature). This is what catches permit numbers and parcel ids that were parsed
 * into a name slot.
 */
const DIGIT_RUN_RE = /[0-9]{3,}/;

/** Business-entity tokens. VERBATIM from 0026:69 (`~*`), unanchored substring. */
const ENTITY_TOKEN_RE =
  /(LLC|INC|CORP|COMPANY|CO\.|LP|LLP|PLLC|LTD|GROUP|CONSTRUCTION|BUILDERS|HOMES|DEVELOPMENT|ELECTRIC|PLUMBING|MECHANICAL|ROOFING|SERVICES|ENTERPRISES|ASSOCIATES|PARTNERS|CITY OF|COUNTY|DISTRICT|AUTHORITY|CHURCH|SCHOOL)/i;

/**
 * Junk is tested FIRST, and that ordering IS the specification.
 *
 * "SAME AS OWNER LLC" carries `LLC` and would read as a business under a
 * positive-first reading; it is a placeholder that happens to quote a suffix.
 * The old predicate reached the same conclusion by ANDing all three conditions,
 * so a name failing any one of them was dropped — negative-first is the faithful
 * translation of that AND, not a new opinion.
 *
 * A missing or blank name is `junk`: it is the absence of a name, and the old
 * predicate excluded it too (the positive gate cannot match nothing).
 */
export function classifyOrgNameQuality(name: string | null | undefined): OrgNameQuality {
  if (name === null || name === undefined || name.trim() === "") return "junk";
  if (PLACEHOLDER_RE.test(name) || DIGIT_RUN_RE.test(name)) return "junk";
  return ENTITY_TOKEN_RE.test(name) ? "business" : "person_or_unknown";
}

/** Type guard for values read back out of the database or a CLI flag. */
export function isOrgNameQuality(value: string): value is OrgNameQuality {
  return (ORG_NAME_QUALITIES as readonly string[]).includes(value);
}
