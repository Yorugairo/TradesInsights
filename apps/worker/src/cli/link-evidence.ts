import "../load-env.js";
import { createDb, createPool } from "@otn/db";
import { createLogger } from "@otn/source-sdk";
import { auditOpportunityEvidence, linkOpportunityEvidence } from "@otn/intelligence";

// pnpm link-evidence:preview   (read-only — prints what WOULD link)
// pnpm link-evidence:apply     (writes the rows)
//
// Links the 88,407 evidence rows that already exist to the opportunities they
// support, so the table the publication gate reads stops being empty. Nothing is
// extracted or inferred: it is a deterministic walk of
// opportunities -> record_resolutions (active) -> evidence_items.
//
// Preview writes NOTHING and subtracts rows that are already linked, exactly as
// apply does, so "would link N" and "linked N" are the same number and a second
// run of either reports zero.
//
// Flags:
//   --audit                 reconcile against the publication gate (read-only, wins over --apply)
//   --apply                 write (default is dry run)
//   --limit=N               only the first N opportunities, ordered by id
//   --account=<uuid>        scope to one account profile
//   --max-per-opportunity=N override the default cap of 50
function numericArg(name: string): number | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const n = Number(hit.slice(name.length + 3));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function stringArg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main() {
  const audit = process.argv.includes("--audit");
  const apply = !audit && process.argv.includes("--apply");
  const logger = createLogger({
    app: audit ? "link-evidence-audit" : apply ? "link-evidence-apply" : "link-evidence-preview",
  });
  const pool = createPool();
  const db = createDb(pool);
  try {
    if (audit) {
      // Read-only. `--audit` beats `--apply` deliberately: an audit that wrote
      // would be measuring its own effect.
      const result = await auditOpportunityEvidence(db, {
        limit: numericArg("limit"),
        accountProfileId: stringArg("account"),
        maxPerOpportunity: numericArg("max-per-opportunity"),
        logger,
      });
      logger.info(
        {
          mode: "audit (read-only)",
          opportunitiesScanned: result.opportunitiesScanned,
          projectsChecked: result.projectsChecked,
          passing: result.passing,
          failingCoreEvent: result.failingCoreEvent,
          failingFactsEvidenced: result.failingFactsEvidenced,
          // Empty is the expected and correct state.
          failureDetails: result.failureDetails,
          reconciliation: result.reconciliation,
        },
        result.reconciliation.balances
          ? "evidence audit — reconciliation balances"
          : "evidence audit — RECONCILIATION DOES NOT BALANCE",
      );
      return;
    }
    const summary = await linkOpportunityEvidence(db, {
      dryRun: !apply,
      limit: numericArg("limit"),
      accountProfileId: stringArg("account"),
      maxPerOpportunity: numericArg("max-per-opportunity"),
      logger,
    });
    logger.info(
      {
        mode: apply ? "apply" : "preview (dry run — no writes)",
        opportunitiesScanned: summary.opportunitiesScanned,
        opportunitiesWithEvidence: summary.opportunitiesWithEvidence,
        pairsConsidered: summary.pairsConsidered,
        alreadyLinked: summary.alreadyLinked,
        [apply ? "linked" : "wouldLink"]: summary.linked,
        cappedDropped: summary.cappedDropped,
        opportunitiesOverCap: summary.opportunitiesOverCap,
        refusedByReason: summary.refusedByReason,
        byClaimType: summary.byClaimType,
        // Empty is the expected state. Anything here means a source started
        // emitting a fact path the claim vocabulary has never seen.
        unknownFactPaths: summary.unknownFactPaths,
      },
      apply ? "evidence linked" : "evidence link preview",
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
