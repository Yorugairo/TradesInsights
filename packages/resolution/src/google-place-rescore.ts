/**
 * Turn Google Place confirmations into export observations for the registry.
 *
 * The scorer (`google-place-scrape.ts`) decides WHAT is confirmed. This decides
 * what gets SENT, and it deliberately sends contested confirmations too — marked
 * as contested — rather than dropping them. A place that two licences both
 * confirm is information the registry needs in order to resolve the conflict; a
 * silent drop would leave it looking unexamined forever.
 *
 * NOTHING HERE WRITES THE REGISTRY. It appends to `registry_observations`, which
 * `exportRegistryObservations` drains into `registry_partner.partner_observations`
 * for the registry's own loader to adjudicate. The registry keeps the last word
 * on its own tables — the same seam rule the alias, trade and relationship lanes
 * follow.
 *
 * WHY OBSERVATIONS RATHER THAN A DIRECT PROMOTION: `registry_entity_external_
 * profile_links` is a governed decision table with `decision_locked`,
 * supersession, and a phone-write policy pinned by CHECK. 595 trades links are
 * already locked. Writing it from behind the seam would mean reimplementing that
 * policy in a second place and risking a locked human decision being
 * overwritten. The loader owns it.
 */
import type { Db } from "@otn/db";
import { sql } from "drizzle-orm";
import type { GooglePlaceScoreSummary, ScoredGooglePlaceObservation } from "./google-place-scrape.js";

/** Insights-side observation type; drained by `exportRegistryObservations`. */
export const GOOGLE_PLACE_OBSERVATION_TYPE = "google_place_export";

/** Rule key recorded on every row, so the lane is filterable in the queue. */
export const GOOGLE_PLACE_RULE_KEY = "google_place_phone_and_name";

/**
 * Trust for a phone AND name agreement.
 *
 * High but deliberately below 1.0: the name is genuinely independent evidence
 * (it was never a link key), yet `crossNameKey` similarity at 0.85 admits
 * "Smith Fire Systems" vs "Smith Fire Systems Co", which is right far more often
 * than not but is not proof.
 */
export const GOOGLE_PLACE_CONFIRMED_TRUST = 0.95;

/**
 * Trust for a contested confirmation. Materially lower because the SAME evidence
 * points at more than one company, so at most one of these rows can be true.
 */
export const GOOGLE_PLACE_CONTESTED_TRUST = 0.4;

/** Written into `decided_by`; this lane is machine-derived, not a human click. */
export const GOOGLE_PLACE_DECIDED_BY = "otn_insights_google_place_rescore";

export interface GooglePlaceExportRow {
  entityId: string;
  googlePlaceId: string;
  lniLicenseNumber: string | null;
  lniName: string | null;
  scrapedName: string | null;
  scrapedPhone: string | null;
  sharedLicenceCount: number;
  /** True when several licences confirm this same place id. */
  contested: boolean;
  /** The other entities claiming this place, when contested. Provenance for the
   * registry's conflict resolution — never a claim that they are related. */
  competingEntityIds: string[];
  trustScore: number;
  dedupeKey: string;
}

/** Stable across runs so a re-export is a no-op rather than a duplicate. */
export function googlePlaceDedupeKey(entityId: string, googlePlaceId: string): string {
  return `google_place:${entityId}:${googlePlaceId}`;
}

/**
 * Build the export rows from a score summary.
 *
 * Pure, so the contested split and the trust bands are testable without a
 * database.
 */
export function buildGooglePlaceExports(summary: GooglePlaceScoreSummary): GooglePlaceExportRow[] {
  const contested = new Set(summary.contestedPlaceIds);
  // Who else claims each contested place — collected once rather than rescanned
  // per row.
  const claimantsByPlace = new Map<string, Set<string>>();
  for (const c of summary.confirmed) {
    if (!contested.has(c.googlePlaceId)) continue;
    const set = claimantsByPlace.get(c.googlePlaceId) ?? new Set<string>();
    set.add(c.entityId);
    claimantsByPlace.set(c.googlePlaceId, set);
  }

  return summary.confirmed.map((c: ScoredGooglePlaceObservation) => {
    const isContested = contested.has(c.googlePlaceId);
    const competing = isContested
      ? [...(claimantsByPlace.get(c.googlePlaceId) ?? [])].filter((e) => e !== c.entityId).sort()
      : [];
    return {
      entityId: c.entityId,
      googlePlaceId: c.googlePlaceId,
      lniLicenseNumber: c.lniLicenseNumber,
      lniName: c.lniName,
      scrapedName: c.scrapedName,
      scrapedPhone: c.scrapedPhone,
      sharedLicenceCount: c.sharedLicenceCount,
      contested: isContested,
      competingEntityIds: competing,
      trustScore: isContested ? GOOGLE_PLACE_CONTESTED_TRUST : GOOGLE_PLACE_CONFIRMED_TRUST,
      dedupeKey: googlePlaceDedupeKey(c.entityId, c.googlePlaceId),
    };
  });
}

export interface RecordGooglePlaceSummary {
  dryRun: boolean;
  candidates: number;
  uncontested: number;
  contested: number;
  inserted: number;
  alreadyPresent: number;
}

/**
 * Append the export rows to `registry_observations`.
 *
 * Rows are written already `accepted` with `exported_at` NULL — the same shape
 * `recordRelationshipAcceptance` uses — because there is no prior pending row to
 * decide: the scorer's verdict and the observation's creation are one event. The
 * registry loader is the reviewer, not this side.
 *
 * Idempotent on `dedupe_key`, so re-running after more of the scrape lands adds
 * only what is genuinely new.
 */
export async function recordGooglePlaceConfirmations(
  db: Db,
  rows: readonly GooglePlaceExportRow[],
  opts: { dryRun?: boolean | undefined } = {},
): Promise<RecordGooglePlaceSummary> {
  const dryRun = opts.dryRun ?? true;
  const summary: RecordGooglePlaceSummary = {
    dryRun,
    candidates: rows.length,
    uncontested: rows.filter((r) => !r.contested).length,
    contested: rows.filter((r) => r.contested).length,
    inserted: 0,
    alreadyPresent: 0,
  };
  if (dryRun || rows.length === 0) return summary;

  for (const row of rows) {
    const payload = {
      google_place_id: row.googlePlaceId,
      lni_license_number: row.lniLicenseNumber,
      lni_name: row.lniName,
      scraped_name: row.scrapedName,
      scraped_phone: row.scrapedPhone,
      shared_licence_count: row.sharedLicenceCount,
      // The loader keys its accepted/relationship_pending decision on this.
      contested: row.contested,
      competing_entity_ids: row.competingEntityIds,
      verdict: "phone_and_name",
    };
    const res = await db.execute(sql`
      INSERT INTO registry_observations
        (observation_type, registry_entity_id, rule_key, payload_json, trust_score,
         status, decided_by, decided_at, dedupe_key, created_at, updated_at)
      VALUES
        (${GOOGLE_PLACE_OBSERVATION_TYPE}, ${row.entityId}, ${GOOGLE_PLACE_RULE_KEY},
         ${JSON.stringify(payload)}::jsonb, ${row.trustScore},
         'accepted', ${GOOGLE_PLACE_DECIDED_BY}, now(), ${row.dedupeKey}, now(), now())
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING id`);
    if ((res.rows as unknown[]).length > 0) summary.inserted += 1;
    else summary.alreadyPresent += 1;
  }
  return summary;
}
