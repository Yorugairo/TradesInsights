import "../load-env.js";
import { createDb, createPool } from "@otn/db";
import { createLogger } from "@otn/source-sdk";
import {
  auditAddressNameMismatch,
  decideReview,
  reclassifyComparanda,
  decideReviewCluster,
  listPendingReviews,
  reevaluatePendingReviews,
  triageReviewQueue,
  undoResolution,
} from "@otn/resolution";

// pnpm review list
// pnpm review triage
// pnpm review bulk merge|reject --rule <rule> --reason <key> [--candidate <project-id>|none] [--by <who>] [--note <text>] [--limit N]
// pnpm review decide <review-id> merge|reject [--by <who>] [--note <text>]
// pnpm review undo <source-record-id> --reason <text>
// pnpm review reevaluate [--apply] [--limit N]     (READ-ONLY without --apply)
// pnpm review name-audit [--limit N]               (always read-only)
// pnpm review reclassify [--apply] [--limit N]     (READ-ONLY without --apply)
async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const logger = createLogger({ app: "review-cli" });
  const pool = createPool();
  const db = createDb(pool);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const has = (name: string): boolean => args.includes(`--${name}`);
  try {
    if (cmd === "list") {
      const rows = await listPendingReviews(db);
      for (const r of rows) {
        console.log(
          `${r.id}  [${r.matchedRule} ${r.score}] ${JSON.stringify(r.reasons)}  ${r.recordTitle ?? ""}`,
        );
      }
      console.log(`${rows.length} pending review(s)`);
    } else if (cmd === "triage") {
      const clusters = await triageReviewQueue(db);
      for (const c of clusters) {
        console.log(
          `${String(c.count).padStart(5)}  [${c.matchedRule} ${c.reasonKey}]  ` +
            `${c.candidateProjectId ? `${c.candidateName ?? c.candidateProjectId} (${c.candidateCounty ?? "?"})` : "(no candidate)"}  ` +
            `scores ${c.minScore.toFixed(2)}–${c.maxScore.toFixed(2)}  e.g. ${c.sampleTitles[0]?.slice(0, 60) ?? ""}`,
        );
      }
      console.log(`${clusters.length} cluster(s), ${clusters.reduce((n, c) => n + c.count, 0)} pending`);
    } else if (cmd === "bulk") {
      const [decision] = args;
      const rule = flag("rule");
      const reason = flag("reason");
      const candidateArg = flag("candidate");
      if ((decision !== "merge" && decision !== "reject") || !rule || reason === undefined) {
        console.error(
          "usage: pnpm review bulk merge|reject --rule <rule> --reason <key> [--candidate <project-id>|none] [--by][--note][--limit]",
        );
        process.exit(2);
      }
      const candidateProjectId = !candidateArg || candidateArg === "none" ? null : candidateArg;
      if (decision === "merge" && candidateProjectId === null) {
        console.error("bulk merge requires --candidate <project-id>");
        process.exit(2);
      }
      const summary = await decideReviewCluster(db, {
        matchedRule: rule,
        reasonKey: reason,
        candidateProjectId,
        decision,
        decidedBy: flag("by") ?? "cli",
        ...(flag("note") ? { note: flag("note")! } : {}),
        ...(flag("limit") ? { limit: Number(flag("limit")) } : {}),
      });
      logger.info(summary, "bulk review decision complete");
    } else if (cmd === "decide") {
      const [reviewId, decision] = args;
      if (!reviewId || (decision !== "merge" && decision !== "reject")) {
        console.error("usage: pnpm review decide <review-id> merge|reject [--by <who>] [--note <text>]");
        process.exit(2);
      }
      const outcome = await decideReview(db, reviewId, decision, {
        decidedBy: flag("by") ?? "cli",
        ...(flag("note") ? { note: flag("note")! } : {}),
      });
      logger.info({ outcome }, "review decided");
    } else if (cmd === "reevaluate") {
      // Dry-run unless --apply is passed. The default has to be the safe one:
      // this decides reviews without a human in the loop, and the first thing
      // anyone types is the bare command.
      const apply = has("apply");
      const summary = await reevaluatePendingReviews(db, {
        apply,
        ...(flag("limit") ? { limit: Number(flag("limit")) } : {}),
        logger,
      });
      console.log(
        `${summary.scanned} scanned  ${summary.resolved} ${apply ? "resolved" : "would resolve"}  ` +
          `${summary.stillAmbiguous} still ambiguous  ${summary.errors.length} error(s)` +
          (summary.mismatched > 0 ? `  ${summary.mismatched} MISMATCHED` : ""),
      );
      for (const [rule, n] of Object.entries(summary.byRule)) console.log(`  ${rule}: ${n}`);
      if (!apply) console.log("(dry run — nothing written; re-run with --apply)");
    } else if (cmd === "reclassify") {
      // Dry-run unless --apply, same reason as `reevaluate`: the bare command is
      // what anyone types first, and it must never write.
      const apply = has("apply");
      const summary = await reclassifyComparanda(db, {
        apply,
        ...(flag("limit") ? { limit: Number(flag("limit")) } : {}),
        logger,
      });
      console.log(
        `${summary.scanned} scanned  ${summary.upgraded} ${apply ? "upgraded" : "would upgrade"} to org-role comparison  ` +
          `${summary.awaitingTagged} ${apply ? "tagged" : "would tag"} awaiting org evidence  ` +
          `${summary.leftActionable} left actionable (org names disagree)  ` +
          `${summary.alreadyTagged} already tagged`,
      );
      for (const [basis, n] of Object.entries(summary.byBasis)) {
        if (n > 0) console.log(`  ${basis.padEnd(10)} ${String(n).padStart(5)}`);
      }
      console.log("(no status, decision or merge is ever written by this pass)");
      if (!apply) console.log("(dry run — nothing written; re-run with --apply)");
    } else if (cmd === "name-audit") {
      const audit = await auditAddressNameMismatch(db, {
        ...(flag("limit") ? { limit: Number(flag("limit")) } : {}),
      });
      console.log(`${audit.total} pending same_address_name_mismatch review(s)`);
      for (const [basis, n] of Object.entries(audit.byBasis)) {
        const pct = audit.total > 0 ? ((n / audit.total) * 100).toFixed(1) : "0.0";
        console.log(`  ${basis.padEnd(10)} ${String(n).padStart(5)}  ${pct}%`);
      }
      for (const s of audit.samples) {
        console.log(`  [${s.basis}] "${s.recordTitle}"  vs  "${s.candidateName}"`);
      }
      console.log("(measurement only — no behaviour is wired to these buckets)");
    } else if (cmd === "undo") {
      const [sourceRecordId] = args;
      const reason = flag("reason");
      if (!sourceRecordId || !reason) {
        console.error("usage: pnpm review undo <source-record-id> --reason <text>");
        process.exit(2);
      }
      await undoResolution(db, sourceRecordId, { reason });
      logger.info({ sourceRecordId }, "resolution undone");
    } else {
      console.error(
        "usage: pnpm review list | triage | bulk | decide | undo | reevaluate | name-audit | reclassify",
      );
      process.exit(2);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
