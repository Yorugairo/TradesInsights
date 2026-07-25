/**
 * Turn Google Place confirmations into staged observations for the registry.
 *
 * The scorer (`google-place-scrape.ts`) decides WHAT is confirmed. This decides
 * what gets SENT, and it deliberately sends contested confirmations too — marked
 * as contested — rather than dropping them. A place that two licences both
 * confirm is information the registry needs in order to resolve the conflict; a
 * silent drop would leave it looking unexamined forever.
 *
 * WRITES `registry_partner.partner_observations` DIRECTLY — NOT through
 * `registry_observations`. That was the first design and it was wrong: EVERY row
 * in `registry_observations` (even machine-generated alias/trade rows) anchors to
 * a real Insights `organizations.id`, because the table's shape is "an Insights
 * org proposes something about a registry entity." This lane has no Insights org
 * in it at all — it is a registry entity confirmed against Google data the
 * registry itself scraped. The live INSERT failed on
 * `organization_id NOT NULL` the first time this ran, which is what surfaced the
 * mismatch. `exportRegistryObservations` already has the matching precedent: its
 * per-entity project-facts block writes straight to `registry_partner.*` for
 * exactly this reason — no per-org review state to stage.
 *
 * NOTHING HERE WRITES REGISTRY IDENTITY. `registry_entity_external_profile_links`
 * is a governed decision table with `decision_locked`, supersession, and a
 * phone-write policy pinned by CHECK. 595 trades links are already locked.
 * Writing it from behind the seam would mean reimplementing that policy in a
 * second place and risking a locked human decision being overwritten. The
 * registry's own loader adjudicates `partner_observations` into that table — the
 * same seam rule the alias, trade and relationship lanes follow.
 *
 * `source_system` MUST be exactly `'otn_insights'` — the registry loader's
 * pending-row query filters on that literal constant, so any other value is
 * simply never picked up.
 */
import type { GooglePlaceScoreSummary, ScoredGooglePlaceObservation } from "./google-place-scrape.js";
import type { RegistryWriterLike } from "./registry-observations.js";

/** `partner_observations.observation_type`; must match the registry CHECK
 * widened in migration 20260726020000. */
export const GOOGLE_PLACE_OBSERVATION_TYPE = "google_place_confirmation";

/** Must equal the registry loader's SOURCE_SYSTEM constant exactly, or the
 * loader's `WHERE source_system = $1` never selects these rows. */
const SOURCE_SYSTEM = "otn_insights";

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

/** Stable across runs so a re-export is a no-op rather than a duplicate.
 * Prefixed with SOURCE_SYSTEM to match the convention every other export type
 * uses on this table (`${SOURCE_SYSTEM}:${...}`), even though the
 * `google_place:` namespace already can't collide with `alias:`/`relationship:`
 * shaped keys on its own. */
export function googlePlaceDedupeKey(entityId: string, googlePlaceId: string): string {
  return `${SOURCE_SYSTEM}:google_place:${entityId}:${googlePlaceId}`;
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
 * Write the export rows straight to `registry_partner.partner_observations`.
 *
 * `writer` is a registry-side connection (`createRegistryPool()`), not the
 * Insights db — there is no Insights-side row for this lane at all. A `null`
 * writer is a skip, mirroring `exportRegistryObservations`'s handling of an
 * unset `REGISTRY_DATABASE_URL`.
 *
 * Idempotent on `dedupe_key`, so re-running after more of the scrape lands adds
 * only what is genuinely new.
 */
export async function recordGooglePlaceConfirmations(
  writer: RegistryWriterLike | null,
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
  if (dryRun || rows.length === 0 || writer === null) return summary;

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
    const res = await writer.query(
      `INSERT INTO registry_partner.partner_observations
         (source_system, entity_id, observation_type, payload, trust_score,
          reviewed_by, reviewed_at, dedupe_key)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, now(), $7)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING observation_id`,
      [
        SOURCE_SYSTEM,
        row.entityId,
        GOOGLE_PLACE_OBSERVATION_TYPE,
        JSON.stringify(payload),
        row.trustScore,
        GOOGLE_PLACE_DECIDED_BY,
        row.dedupeKey,
      ],
    );
    if (res.rows.length > 0) summary.inserted += 1;
    else summary.alreadyPresent += 1;
  }
  return summary;
}
