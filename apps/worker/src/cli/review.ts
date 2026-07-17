import "../load-env.js";
import { createDb, createPool } from "@otn/db";
import { createLogger } from "@otn/source-sdk";
import {
  decideReview,
  decideReviewCluster,
  listPendingReviews,
  triageReviewQueue,
  undoResolution,
} from "@otn/resolution";

// pnpm review list
// pnpm review triage
// pnpm review bulk merge|reject --rule <rule> --reason <key> [--candidate <project-id>|none] [--by <who>] [--note <text>] [--limit N]
// pnpm review decide <review-id> merge|reject [--by <who>] [--note <text>]
// pnpm review undo <source-record-id> --reason <text>
async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const logger = createLogger({ app: "review-cli" });
  const pool = createPool();
  const db = createDb(pool);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
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
      console.error("usage: pnpm review list | triage | bulk | decide | undo");
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
