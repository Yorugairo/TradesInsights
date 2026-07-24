/**
 * Claim typing for the evidence linker.
 *
 * 88,407 `evidence_items` exist and `opportunity_evidence` has never held a
 * single row, so every fact the digest shows is currently unsourced in the one
 * table the publication gate reads. Linking them is a deterministic join; the
 * only judgement in it is "what claim does this row support, and does its
 * authority let us call that claim CONFIRMED?". That judgement lives here, pure
 * and database-free, so it can be tested without a connection.
 *
 * NO MODEL CALLS. Claim typing is a lookup over `fact_path`, per the evidence
 * gate's §13 rule that scores stay deterministic calculations over stored
 * components.
 *
 * THE GRADE BRANCHES ARE NOT DEAD CODE. Every one of the 88,407 rows is grade
 * `A` today, which makes it tempting to collapse this to `confirmed = true`.
 * That would silently publish the first non-A source that ever lands — and the
 * C and D branches are precisely the safeguard against it, because C is never
 * sufficient alone and D is discovery-only and must never reach a customer.
 * They are tested for that reason, not for coverage.
 */
import { AUTHORITY_GRADES, type AuthorityGrade } from "@otn/domain";

/**
 * The claim vocabulary the digest and publication gate consume.
 *
 * `other` means "real evidence that does not support one of the gated claims" —
 * it is linked and kept, but it can never satisfy the gate's requirement for
 * A-grade support of the core event.
 */
export const CLAIM_TYPES = [
  "identity",
  "stage",
  "event_date",
  "geography",
  "value",
  "organization_role",
  "other",
] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

/** Why a row was refused. Enumerated so the audit never lumps refusals into "other". */
export type ClaimRefusal = "discovery_only_grade" | "unknown_grade";

export type ClaimClassification =
  | { linkable: true; claimType: ClaimType; confirmed: boolean; confidence: number }
  | { linkable: false; reason: ClaimRefusal };

/**
 * Confidence by authority. These are the authority's contribution only — the
 * linker does not blend them with anything, because a blended score that no
 * single stored component explains is exactly what the evidence gate forbids.
 */
export const GRADE_A_CONFIDENCE = 0.95;
export const GRADE_B_CONFIDENCE = 0.75;
export const GRADE_C_CONFIDENCE = 0.5;

/**
 * `fact_path` -> claim, covering all 25 distinct paths measured live on
 * 2026-07-24 (counts in comments, summing to the full 88,407).
 *
 * Two mappings are deliberate refusals to over-claim:
 *
 * `sourceUpdatedAt` is NOT an `event_date`. It records when the SOURCE last
 * republished the row, not when anything happened on the project. Typing it as
 * an event date would let a digest present a scrape timestamp as a permit date
 * or a deadline — a fabricated fact with a real evidence row behind it, which is
 * the worst possible failure of a citation system.
 *
 * `units` and `lots` are NOT `value`. They are counts, and `value` is money.
 * Mapping them there would let a 78-unit count stand as support for a dollar
 * figure the source never stated. The claim vocabulary has no slot for scale, so
 * they are typed `other` — kept and linked, but unable to confirm a value claim.
 */
const FACT_PATH_CLAIMS: Readonly<Record<string, ClaimType>> = {
  // Stage
  statusRaw: "stage", // 17,889

  // Identity — what record this is
  title: "identity", // 13,269
  externalRef: "identity", // 10,792
  externalId: "identity", // 7,745

  // Geography — where the work is. `parcelIds` is the most precise locator the
  // permit sources publish, so it types as geography rather than identity.
  parcelIds: "geography", // 13,312
  addressRaw: "geography", // 1,988
  geometry: "geography", // 301

  // Who
  organizations: "organization_role", // 7,957

  // Money
  valuationUsd: "value", // 7,627

  // When — project events only; see the note above on `sourceUpdatedAt`.
  issueDate: "event_date", // 5,487
  applicationDate: "event_date", // 856

  // Real evidence, no gated claim
  documentType: "other", // 947
  description: "other", // 81
  sourceUpdatedAt: "other", // 79 — record metadata, NOT a project event
  units: "other", // 50 — a count, not a value
  applicationType: "other", // 15
  lots: "other", // 4 — a count, not a value
};

/**
 * `links.*` paths (8 rows across 8 distinct paths) are portal and dataset URLs.
 * They are navigational, never evidence for a claim, so the whole namespace maps
 * to `other` without enumerating every variant — new portals appear routinely
 * and must not read as an unknown schema change.
 */
const LINK_PATH_PREFIX = "links.";

/**
 * Whether this `fact_path` is in the known vocabulary.
 *
 * Exported so the audit can distinguish "evidence that supports no gated claim"
 * from "a fact path we have never seen" — the second is how a source schema
 * change announces itself, and it must not hide inside the `other` bucket.
 */
export function isKnownFactPath(factPath: string): boolean {
  const path = factPath.trim();
  return path in FACT_PATH_CLAIMS || path.startsWith(LINK_PATH_PREFIX);
}

/** Map a `fact_path` onto the claim vocabulary. Unknown paths are `other`. */
export function claimTypeForFactPath(factPath: string): ClaimType {
  const path = factPath.trim();
  if (path.startsWith(LINK_PATH_PREFIX)) return "other";
  return FACT_PATH_CLAIMS[path] ?? "other";
}

/**
 * Grades come from `@otn/domain` (spec §11) rather than being redeclared here —
 * a second copy is how two modules silently stop agreeing on what `C` means.
 * Their semantics, for reference:
 *   A — official government record / solicitation / authorized invitation
 *   B — official company, project, architect, or GC page
 *   C — credible secondary corroboration; NEVER sufficient alone
 *   D — unverified aggregation; discovery only, NEVER customer-publishable
 */
function normalizeGrade(grade: string): AuthorityGrade | null {
  const g = grade.trim().toUpperCase();
  return (AUTHORITY_GRADES as readonly string[]).includes(g) ? (g as AuthorityGrade) : null;
}

/**
 * Classify one evidence row.
 *
 * FAILS CLOSED. An unrecognised grade is refused rather than defaulted, because
 * the only way to default it is to guess how much authority a source we do not
 * recognise deserves.
 */
export function classifyClaim(input: {
  factPath: string;
  authorityGrade: string;
}): ClaimClassification {
  const grade = normalizeGrade(input.authorityGrade);
  if (grade === null) return { linkable: false, reason: "unknown_grade" };

  // D is discovery-only and never customer-publishable, so it is refused at the
  // link step — not linked-but-unconfirmed. Anything in `opportunity_evidence`
  // is something we are prepared to show a source for.
  if (grade === "D") return { linkable: false, reason: "discovery_only_grade" };

  const claimType = claimTypeForFactPath(input.factPath);
  if (grade === "A") {
    return { linkable: true, claimType, confirmed: true, confidence: GRADE_A_CONFIDENCE };
  }
  if (grade === "B") {
    return { linkable: true, claimType, confirmed: false, confidence: GRADE_B_CONFIDENCE };
  }
  // C — credible, corroborating, never confirmed on its own.
  return { linkable: true, claimType, confirmed: false, confidence: GRADE_C_CONFIDENCE };
}
