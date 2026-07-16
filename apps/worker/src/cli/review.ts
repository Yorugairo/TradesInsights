import "../load-env.js";
import { createDb, createPool } from "@otn/db";
import { createLogger } from "@otn/source-sdk";
import { decideReview, listPendingReviews, undoResolution } from "@otn/resolution";

// pnpm review list
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
      console.error("usage: pnpm review list | decide | undo");
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
