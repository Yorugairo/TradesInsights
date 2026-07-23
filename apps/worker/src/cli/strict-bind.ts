import "../load-env.js";
import { createDb, createPool, createRegistryPool } from "@otn/db";
import { createLogger } from "@otn/source-sdk";
import {
  fetchRegistryIdentityRows,
  fetchTradeTaxonomy,
  generateRegistryObservations,
} from "@otn/resolution";

// pnpm strict-bind:preview   (read-only — prints what WOULD auto-bind)
// pnpm strict-bind:apply     (writes the strict-tier binds)
//
// The strict tier (owner-approved 2026-07-23) auto-binds an Insights org to a
// registry entity ONLY when all three hold: exact canonical name + same city +
// shared AUTHORITATIVE trade. Everything softer stays in the human review queue.
// Preview writes NOTHING (dryRun); apply runs the registry-observation
// generation for real and prints each bind. Both are idempotent — a rerun binds
// nothing new once the qualifying orgs are bound.
async function main() {
  const apply = process.argv.includes("--apply");
  const logger = createLogger({ app: apply ? "strict-bind-apply" : "strict-bind-preview" });
  const pool = createPool();
  const db = createDb(pool);
  const registryPool = createRegistryPool();
  try {
    if (!registryPool) {
      logger.info({ skipped: true }, "no REGISTRY_DATABASE_URL — strict-bind cannot run");
      return;
    }
    const registryRows = await fetchRegistryIdentityRows(registryPool);
    const tradeTaxonomy = await fetchTradeTaxonomy(registryPool);
    const summary = await generateRegistryObservations(db, registryRows, {
      logger,
      tradeTaxonomy,
      dryRun: !apply,
    });
    for (const c of summary.strictCandidates) {
      logger.info(
        {
          org: c.organizationName,
          registry: c.registryName,
          city: c.city,
          sharedTrades: c.sharedTradeCodes,
          trust: c.trust,
          entity: c.registryEntityId,
        },
        apply ? "strict-bound" : "would strict-bind",
      );
    }
    logger.info(
      {
        mode: apply ? "apply" : "preview (dry run — no writes)",
        strictCandidates: summary.strictCandidates.length,
        strictAutoBound: summary.strictAutoBound,
        // In preview these are what an apply WOULD queue for review (new rows
        // only); in an apply they are what it did queue.
        [apply ? "reviewQueued" : "reviewWouldQueue"]: summary.bindingCandidates,
        byRule: summary.byRule,
      },
      "strict-bind complete",
    );
    if (summary.strictCandidates.length === 0) {
      logger.info(
        { reviewWouldQueue: apply ? undefined : summary.bindingCandidates },
        "no strict-tier candidates (auto-bind); softer matches go to review",
      );
    }
  } finally {
    await registryPool?.end();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
