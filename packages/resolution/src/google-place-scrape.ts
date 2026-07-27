/**
 * Google Place scrape observations, read across the seam and judged here.
 *
 * WHY: 3,755 candidate listings were rejected by the registry's July match
 * scorer. A listing rejected for ONE licence can be the right answer for a
 * DIFFERENT licence bridged to the same place — measured live, 20,385 of 31,179
 * observations sit on a place id shared by more than one licence, and one place
 * id bridges 77. Re-judging them is not a re-scrape; the observations already
 * exist. What was missing was a way to ask the question from this side.
 *
 * THE VIEW SHIPS RAW STRINGS AND NO VERDICT, ON PURPOSE. Every judgement runs
 * through `classifyGoogleConfirmation`, which is the one authority on whether an
 * L&I name and a Google name are the same business. A comparison implemented in
 * SQL would be a second normalizer, and a second normalizer that drifts is
 * exactly how match keys silently stop matching. That is not hypothetical here:
 * the first triage of these rejects WAS done in ad-hoc SQL that re-implemented
 * `crossNameKey`, and this module exists so that never decides a binding.
 *
 * PHONE AGREEMENT IS LARGELY CIRCULAR. 2,962 of 2,980 existing links were created
 * BY matching that phone, so `phone_only` re-confirms the decision that made the
 * link rather than testing it. The NAME is the independent axis. Only
 * `phone_and_name` is treated as real confirmation; `phone_only` is counted and
 * reported separately, never promoted.
 *
 * OBSERVATIONS, NOT PROFILES. `scraped_*` means "what Google showed at
 * `fetchedAt`". Nothing here asserts that a listing IS a business; it produces
 * REVIEW CANDIDATES. No auto-binding, per standing governance.
 *
 * SKIP-SAFE: a missing view (42P01) degrades to an empty result, because the
 * Insights deploy and the registry migration are not atomic. EVERY other error
 * rethrows — a permission failure must never masquerade as "no observations",
 * which would silently report zero confirmations and read as "nothing matched".
 */
import {
  classifyGoogleConfirmation,
  classifyNameAgreement,
  comparablePhone,
  type GoogleConfirmation,
  type NameAgreementBasis,
} from "./registry-identifiers.js";
import type { RegistryIdentityRow, RegistryPoolLike } from "./registry-link.js";

export const GOOGLE_PLACE_SCRAPE_VIEW = "registry_public.google_place_scrape_v1";

/** Postgres `undefined_table` — the only error this module swallows. */
const UNDEFINED_TABLE = "42P01";

/** Scrape verdicts that carry a usable observation. `blocked` means Google pushed
 * back and the row's fields are not evidence of anything. */
const USABLE_SCRAPE_STATUS = "ok";

export interface GooglePlaceScrapeRow {
  entityId: string;
  googlePlaceId: string;
  lniLicenseNumber: string | null;
  scrapedName: string | null;
  scrapedPhone: string | null;
  scrapedAddress: string | null;
  scrapeStatus: string | null;
  fetchedAt: string | null;
  /** How many DISTINCT licences share this place id. >1 means the listing is
   * contested and at most one of those contractors actually owns it. */
  sharedLicenceCount: number;
}

function isMissingRelation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === UNDEFINED_TABLE;
}

const str = (v: unknown): string | null => {
  const s = v == null ? "" : String(v).trim();
  return s === "" ? null : s;
};

/**
 * Read every scrape observation for a resolved trades entity.
 *
 * Returns [] when the registry migration has not landed yet. Any other failure
 * rethrows.
 */
export async function loadGooglePlaceScrapeRows(
  pool: RegistryPoolLike,
): Promise<GooglePlaceScrapeRow[]> {
  try {
    const res = await pool.query(
      `SELECT entity_id, google_place_id, lni_license_number, scraped_name, scraped_phone,
              scraped_address, scrape_status, fetched_at, shared_licence_count
         FROM ${GOOGLE_PLACE_SCRAPE_VIEW}`,
    );
    return (res.rows as Record<string, unknown>[]).map((r) => ({
      entityId: String(r["entity_id"]),
      googlePlaceId: String(r["google_place_id"]),
      lniLicenseNumber: str(r["lni_license_number"]),
      scrapedName: str(r["scraped_name"]),
      scrapedPhone: str(r["scraped_phone"]),
      scrapedAddress: str(r["scraped_address"]),
      scrapeStatus: str(r["scrape_status"]),
      fetchedAt: r["fetched_at"] == null ? null : String(r["fetched_at"]),
      sharedLicenceCount: Number(r["shared_licence_count"] ?? 1),
    }));
  } catch (err) {
    if (isMissingRelation(err)) return [];
    throw err;
  }
}

/** One observation judged against the L&I record of the entity it points at. */
export interface ScoredGooglePlaceObservation {
  entityId: string;
  googlePlaceId: string;
  lniLicenseNumber: string | null;
  /** The registry's own name for this entity — the side we trust. */
  lniName: string | null;
  scrapedName: string | null;
  scrapedPhone: string | null;
  sharedLicenceCount: number;
  confirmation: GoogleConfirmation;
  /** HOW the names agreed. Carried so the review queue can group a batch of one
   * basis and judge it as a class — a reviewer can clear 500 `exact` rows far
   * faster than they can adjudicate 500 mixed ones. */
  nameBasis: NameAgreementBasis;
}

export interface GooglePlaceScoreSummary {
  observations: number;
  /** Rows skipped because the scrape did not succeed, or the entity is unknown
   * to the identity contract. Counted, never silently dropped. */
  skippedUnusableStatus: number;
  skippedUnknownEntity: number;
  byConfirmation: Record<GoogleConfirmation, number>;
  /** `phone_and_name` only — the rows worth putting in front of a human. */
  confirmed: ScoredGooglePlaceObservation[];
  /** Place ids where MORE THAN ONE DISTINCT ENTITY reaches `phone_and_name`. A
   * listing cannot belong to two companies, so these are contradictions to
   * resolve, not confirmations to accept.
   *
   * KEYED BY ENTITY, NOT BY LICENCE — this was a live defect. Keying by licence
   * made one company holding several L&I licences look like several rival
   * claimants on its own listing: 139 of 143 flagged conflicts were a single
   * company, and each was withheld from the public surface as
   * `not_public_pending_review` for a conflict that did not exist. Anderson
   * Drilling LLC holding ANDERDL789CQ and ANDERDL789TQ is one company with two
   * licences, not two companies fighting over a listing. */
  contestedPlaceIds: string[];
  /**
   * `name_only` split by WHY the phone did not confirm. The bare verdict merges
   * two different facts:
   *
   *   `divergentPhone` — both sides state a phone and they DISAGREE. A real
   *     contradiction: same name, different line. Either the listing belongs to
   *     a different branch/company of a similar name, or one number is stale.
   *     This is the only sub-class that is evidence AGAINST the match.
   *   `noLniPhone` / `noGooglePhone` / `neitherPhone` — nobody contradicts
   *     anybody; there is simply nothing to compare. Absence of evidence.
   *
   * Kept apart because treating a missing number as a disagreement would
   * manufacture conflicts out of gaps — the same error class as counting a
   * place contested by licence rather than by entity.
   */
  nameOnly: {
    divergentPhone: number;
    noLniPhone: number;
    noGooglePhone: number;
    neitherPhone: number;
  };
}

function emptyCounts(): Record<GoogleConfirmation, number> {
  return { phone_and_name: 0, phone_only: 0, name_only: 0, none: 0 };
}

function emptyNameOnly(): GooglePlaceScoreSummary["nameOnly"] {
  return { divergentPhone: 0, noLniPhone: 0, noGooglePhone: 0, neitherPhone: 0 };
}

/**
 * Judge every observation against the entity's L&I name and phone.
 *
 * Pure — no I/O, so the policy is testable without a database or the seam.
 */
export function scoreGooglePlaceObservations(
  rows: readonly GooglePlaceScrapeRow[],
  identityRows: readonly RegistryIdentityRow[],
): GooglePlaceScoreSummary {
  const identityByEntity = new Map<string, RegistryIdentityRow>();
  for (const row of identityRows) identityByEntity.set(row.entityId, row);

  const summary: GooglePlaceScoreSummary = {
    observations: rows.length,
    skippedUnusableStatus: 0,
    skippedUnknownEntity: 0,
    byConfirmation: emptyCounts(),
    confirmed: [],
    contestedPlaceIds: [],
    nameOnly: emptyNameOnly(),
  };
  const confirmedEntitiesByPlace = new Map<string, Set<string>>();

  for (const row of rows) {
    // A blocked or errored scrape has no observation to judge. Skipping it is
    // not the same as judging it `none`, so it is counted separately.
    if (row.scrapeStatus !== USABLE_SCRAPE_STATUS) {
      summary.skippedUnusableStatus += 1;
      continue;
    }
    const identity = identityByEntity.get(row.entityId);
    if (!identity) {
      // The entity is not in the identity contract — scoring against a name we
      // cannot see would be guessing.
      summary.skippedUnknownEntity += 1;
      continue;
    }

    const confirmation = classifyGoogleConfirmation({
      lniPhone: identity.phone,
      googlePhone: row.scrapedPhone,
      lniName: identity.canonicalName,
      googleName: row.scrapedName,
    });
    summary.byConfirmation[confirmation] += 1;

    if (confirmation === "name_only") {
      const lni = comparablePhone(identity.phone);
      const google = comparablePhone(row.scrapedPhone);
      if (lni !== null && google !== null) summary.nameOnly.divergentPhone += 1;
      else if (lni === null && google === null) summary.nameOnly.neitherPhone += 1;
      else if (lni === null) summary.nameOnly.noLniPhone += 1;
      else summary.nameOnly.noGooglePhone += 1;
    }

    if (confirmation === "phone_and_name") {
      summary.confirmed.push({
        entityId: row.entityId,
        googlePlaceId: row.googlePlaceId,
        lniLicenseNumber: row.lniLicenseNumber,
        lniName: identity.canonicalName,
        scrapedName: row.scrapedName,
        scrapedPhone: row.scrapedPhone,
        sharedLicenceCount: row.sharedLicenceCount,
        confirmation,
        nameBasis: classifyNameAgreement(identity.canonicalName, row.scrapedName),
      });
      // Entity id, never the licence number: the question is "do two different
      // COMPANIES claim this listing", and one company's second licence is not
      // a rival claimant.
      const entities = confirmedEntitiesByPlace.get(row.googlePlaceId) ?? new Set<string>();
      entities.add(row.entityId);
      confirmedEntitiesByPlace.set(row.googlePlaceId, entities);
    }
  }

  for (const [placeId, entities] of confirmedEntitiesByPlace) {
    if (entities.size > 1) summary.contestedPlaceIds.push(placeId);
  }
  summary.contestedPlaceIds.sort();
  return summary;
}
