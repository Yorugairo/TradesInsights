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
import { withConnectionRetry } from "@otn/db";
import type { GooglePlaceScoreSummary, ScoredGooglePlaceObservation } from "./google-place-scrape.js";
import type { NameAgreementBasis } from "./registry-identifiers.js";
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

/**
 * Trust for a CONTAINMENT-derived confirmation — one name is a whole-token
 * subsequence of the other (`ENCORE ELECTRIC WA` / `ENCORE ELECTRIC`), with the
 * phones agreeing and at least two shared tokens.
 *
 * Below `GOOGLE_PLACE_CONFIRMED_TRUST` on purpose, even though the owner's read
 * of this class is "99%". Measured 2026-07-26 it very nearly is — only 34 of
 * 7,843 exact-or-containment pairs are contested once contests are counted by
 * ENTITY rather than by licence. But containment is strictly weaker evidence
 * than an exact key match: it accepts every extra token the longer name carries,
 * and `SCHUFF STEEL` ⊂ `SCHUFF STEEL FABRICATION FACILITY` is the same shape as
 * a parent company against a subsidiary. Ranking it level with exact would erase
 * a distinction the reviewer needs.
 *
 * These are STAGED FOR REVIEW, not auto-accepted (owner decision 2026-07-26):
 * the band orders the queue, and `nameBasis` on the payload lets a reviewer take
 * them as one group. Promote the constant once the accept rate justifies it.
 */
export const GOOGLE_PLACE_CONTAINMENT_TRUST = 0.9;

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
  /** How the names agreed (`exact` | `close` | `contained`). Staged so the
   * reviewer can group and judge a whole basis at once. */
  nameBasis: NameAgreementBasis;
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
      nameBasis: c.nameBasis,
      // A contest is the "other conflict" that overrides everything: at most one
      // claimant can be right, so it outranks how well the names matched.
      trustScore: isContested
        ? GOOGLE_PLACE_CONTESTED_TRUST
        : c.nameBasis === "contained"
          ? GOOGLE_PLACE_CONTAINMENT_TRUST
          : GOOGLE_PLACE_CONFIRMED_TRUST,
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
  /**
   * Rows already staged under this `dedupe_key` and left untouched.
   *
   * READS 0 IN A DRY RUN BY CONSTRUCTION — the insert never executes, so nothing
   * can report as already present. A dry-run 0 says nothing whatsoever about how
   * full the table is, and has twice been misread as "the table is empty".
   */
  alreadyPresent: number;
  /** Existing rows whose payload was rewritten. Only ever non-zero with `restage`. */
  restaged: number;
  /**
   * Restaged rows whose freshly computed trust differs from the trust stored
   * when they were first staged. Reported, never applied — see `restage`.
   */
  trustDrift: number;
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
  opts: {
    dryRun?: boolean | undefined;
    /**
     * Rewrite the payload of rows that are ALREADY staged, instead of skipping
     * them.
     *
     * Needed because `name_basis` was added after 3,578 rows had already been
     * written and consumed, so those rows carry no basis and cannot be grouped
     * by it. A plain re-run cannot fix them: the statement is
     * `ON CONFLICT (dedupe_key) DO NOTHING`, so it reports `alreadyPresent` and
     * changes nothing — a silent no-op that looks like success.
     *
     * DELIBERATELY NARROW. It rewrites `payload` and nothing else:
     *  - `applied_at` / `applied_action` belong to the OneTradeNetwork loader.
     *    Writing them from this side of the seam would forge its provenance.
     *  - `trust_score` is left as first staged. These rows are already applied,
     *    and silently re-scoring a decision the loader has acted on is not a
     *    backfill, it is a retroactive edit. Where the recomputed trust differs
     *    it is COUNTED in `trustDrift` and reported, so the disagreement is
     *    visible and someone can decide about it deliberately.
     */
    restage?: boolean | undefined;
    /** Logged on each transient-fault retry, so a degraded link is visible. */
    onRetry?: ((attempt: number, err: unknown) => void) | undefined;
  } = {},
): Promise<RecordGooglePlaceSummary> {
  const dryRun = opts.dryRun ?? true;
  const restage = opts.restage ?? false;
  const summary: RecordGooglePlaceSummary = {
    dryRun,
    candidates: rows.length,
    uncontested: rows.filter((r) => !r.contested).length,
    contested: rows.filter((r) => r.contested).length,
    inserted: 0,
    alreadyPresent: 0,
    restaged: 0,
    trustDrift: 0,
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
      // HOW the names agreed, so the registry's reviewer can group the batch by
      // basis instead of adjudicating a mixed queue row by row. `contained` is
      // the newer, weaker class and is the one worth eyeballing first.
      name_basis: row.nameBasis,
    };
    // `xmax = 0` is true only for a freshly INSERTed row, which is how an
    // upsert tells "created" from "updated" — the DO UPDATE branch returns a row
    // either way. `trust_score` is read back AFTER the update, and since the
    // update never sets it, comparing it to $5 reports drift without causing it.
    const conflictClause = restage
      ? `DO UPDATE SET payload = EXCLUDED.payload
         RETURNING observation_id, (xmax = 0) AS was_inserted,
                   (partner_observations.trust_score IS DISTINCT FROM $5) AS trust_drift`
      : `DO NOTHING RETURNING observation_id, true AS was_inserted, false AS trust_drift`;

    // Safe to retry: both branches are keyed on `dedupe_key`, so a replay after
    // a dropped connection either re-inserts the same row or rewrites it to the
    // same payload. Nothing accumulates.
    const res = await withConnectionRetry(
      () =>
        writer.query(
          `INSERT INTO registry_partner.partner_observations
         (source_system, entity_id, observation_type, payload, trust_score,
          reviewed_by, reviewed_at, dedupe_key)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, now(), $7)
       ON CONFLICT (dedupe_key) ${conflictClause}`,
          [
            SOURCE_SYSTEM,
            row.entityId,
            GOOGLE_PLACE_OBSERVATION_TYPE,
            JSON.stringify(payload),
            row.trustScore,
            GOOGLE_PLACE_DECIDED_BY,
            row.dedupeKey,
          ],
        ),
      { ...(opts.onRetry ? { onRetry: opts.onRetry } : {}) },
    );

    const returned = res.rows[0] as
      | { was_inserted?: boolean; trust_drift?: boolean }
      | undefined;
    if (!returned) {
      // DO NOTHING swallowed it — the row was already staged.
      summary.alreadyPresent += 1;
    } else if (returned.was_inserted) {
      summary.inserted += 1;
    } else {
      summary.restaged += 1;
      if (returned.trust_drift) summary.trustDrift += 1;
    }
  }
  return summary;
}
