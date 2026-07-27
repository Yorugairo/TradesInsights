import "../load-env.js";
import { createRegistryPool, withConnectionRetry } from "@otn/db";
import { createLogger } from "@otn/source-sdk";
import {
  buildGooglePlaceExports,
  fetchRegistryIdentityRows,
  loadGooglePlaceScrapeRows,
  recordGooglePlaceConfirmations,
  scoreGooglePlaceObservations,
} from "@otn/resolution";

// pnpm google-place-rescore:preview   (read-only — prints what WOULD be staged)
// pnpm google-place-rescore:apply     (stages the observations)
//
// Re-judges every Google Place scrape observation against L&I through
// classifyGoogleConfirmation, and stages the phone+name confirmations for the
// registry. This is the answer to "a listing rejected for one licence may be the
// right answer for another licence bridged to the same place" — the verdict is
// computed per (entity, place), not per place.
//
// APPLY STAGES DIRECTLY TO registry_partner.partner_observations — no Insights
// connection is opened at all. The first version staged through
// registry_observations, but that table anchors every row to an Insights
// organizations.id and this lane has no Insights org in it (it is a registry
// entity confirmed against Google data), which failed on
// organization_id NOT NULL the first time it ran live. See
// google-place-rescore.ts for the full explanation.
//
// APPLY STAGES, IT DOES NOT PROMOTE. The registry's own loader decides what
// becomes a profile link, because registry_entity_external_profile_links is a
// governed table with decision_locked and supersession that must not be written
// from behind the seam.
//
// Contested places are staged too, marked, at lower trust. A place several
// licences all confirm cannot belong to all of them, and dropping the conflict
// would leave it looking unexamined.
//
// Flags:
//   --apply     stage the observations (default is dry run)
//   --limit=N   cap rows staged (diagnostic; does not change the scoring)
function numericArg(name: string): number | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const n = Number(hit.slice(name.length + 3));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const limit = numericArg("limit");
  const logger = createLogger({
    app: apply ? "google-place-rescore-apply" : "google-place-rescore-preview",
  });
  const registryPool = createRegistryPool();
  try {
    if (!registryPool) {
      // Mirrors strict-bind: an unset seam is a skip, not a crash.
      logger.info({ skipped: true }, "no REGISTRY_DATABASE_URL — google place rescore cannot run");
      return;
    }

    // Both loads are single full-table reads across the Supavisor pooler, and
    // this lane had NO retry: on 2026-07-26 a DNS blip (ENOTFOUND on
    // aws-1-us-west-2.pooler.supabase.com) killed an entire preview outright,
    // and the same drop during --apply would abandon a part-staged batch. The
    // reads are idempotent so retrying is free; anything that is NOT a
    // connection fault still surfaces immediately and unchanged.
    const onRetry = (attempt: number, err: unknown) =>
      logger.info(
        { attempt, err: String(err) },
        "transient connection fault reading the registry contract — retrying",
      );

    const observations = await withConnectionRetry(() => loadGooglePlaceScrapeRows(registryPool), {
      onRetry,
    });
    if (observations.length === 0) {
      // Either the contract view has not been deployed yet (skip-safe read) or
      // nothing has been scraped. Both are honest zeros, not failures.
      logger.info({ observations: 0 }, "no google place observations visible on the contract");
      return;
    }
    const identityRows = await withConnectionRetry(() => fetchRegistryIdentityRows(registryPool), {
      onRetry,
    });
    const scored = scoreGooglePlaceObservations(observations, identityRows);
    const allRows = buildGooglePlaceExports(scored);
    const rows = limit ? allRows.slice(0, limit) : allRows;

    const staged = await recordGooglePlaceConfirmations(registryPool, rows, { dryRun: !apply });

    logger.info(
      {
        mode: apply ? "apply (staged for the registry loader)" : "preview (dry run — no writes)",
        observations: scored.observations,
        skippedUnusableStatus: scored.skippedUnusableStatus,
        skippedUnknownEntity: scored.skippedUnknownEntity,
        byConfirmation: scored.byConfirmation,
        // name_only split by WHY the phone did not confirm. `divergentPhone` is
        // the only sub-class that is evidence AGAINST the match — the rest are
        // simply missing a number, and reading them as disagreement would
        // manufacture conflicts out of gaps.
        nameOnly: scored.nameOnly,
        // Only phone_and_name is real confirmation; phone_only is circular
        // because most existing links were made BY matching that phone.
        confirmed: scored.confirmed.length,
        contestedPlaceIds: scored.contestedPlaceIds.length,
        candidates: staged.candidates,
        uncontested: staged.uncontested,
        contested: staged.contested,
        [apply ? "staged" : "wouldStage"]: apply ? staged.inserted : staged.candidates,
        alreadyPresent: staged.alreadyPresent,
        truncatedByLimit: limit ? allRows.length - rows.length : 0,
      },
      apply ? "google place rescore staged" : "google place rescore preview",
    );
  } finally {
    await registryPool?.end?.();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
