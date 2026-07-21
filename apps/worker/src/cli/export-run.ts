import "../load-env.js";
import { writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { createDb, createPool } from "@otn/db";
import { createLogger } from "@otn/source-sdk";
import { accountExportConfig, exportPursuits } from "@otn/delivery";

// pnpm export:run [--account <key>] [--send] [--out <file>] [--format csv|json]
//
// Exports an account's ACTIONABLE opportunities (CRM sync). By default this is a
// dry CSV run (no outbound POST). With --send, and ONLY when the account has a
// configured `delivery_config_json.export.webhook_url`, it POSTs the JSON payload
// to THAT url — the account's own endpoint, never a URL from any record/source
// (governance #1). CSV/JSON is written to --out (per-account-suffixed when more
// than one account) or to stdout.
async function main() {
  const logger = createLogger({ app: "export-run-cli" });
  const args = process.argv.slice(2);
  const accountArg = args.includes("--account") ? args[args.indexOf("--account") + 1] : null;
  const outArg = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
  const formatArg = args.includes("--format") ? args[args.indexOf("--format") + 1] : "csv";
  const format = formatArg === "json" ? "json" : "csv";
  const send = args.includes("--send");

  const pool = createPool();
  const db = createDb(pool);
  try {
    const accounts = await db.execute(sql`
      SELECT id, key FROM account_profiles WHERE active = true
      ${accountArg ? sql`AND key = ${accountArg}` : sql``} ORDER BY key`);
    if (accounts.rows.length === 0) {
      logger.warn({ accountArg }, "no matching active accounts");
      return;
    }
    const rows = accounts.rows as { id: string; key: string }[];
    for (const account of rows) {
      const cfg = await accountExportConfig(db, account.id);
      // Only POST when --send AND the account configured its own webhook URL.
      const webhookUrl = send && cfg?.webhook_url ? cfg.webhook_url : null;

      const result = await exportPursuits(db, account.id, { webhookUrl, logger });
      const body = format === "json" ? JSON.stringify(result.payload, null, 2) : result.csv;

      if (outArg) {
        // Suffix per-account when exporting more than one account to one --out path.
        const path =
          rows.length > 1 ? outArg.replace(/(\.[^.]+)?$/, `.${account.key}$1`) : outArg;
        writeFileSync(path, body, "utf8");
        logger.info(
          {
            account: account.key,
            exported: result.exported,
            webhookStatus: result.webhookStatus,
            ...(result.webhookReason ? { webhookReason: result.webhookReason } : {}),
            capped: result.capped,
            out: path,
          },
          "export written",
        );
      } else {
        // stdout: a comment banner keeps multiple accounts distinguishable.
        if (rows.length > 1) process.stdout.write(`# account: ${account.key}\n`);
        process.stdout.write(body.endsWith("\n") ? body : `${body}\n`);
        logger.info(
          {
            account: account.key,
            exported: result.exported,
            webhookStatus: result.webhookStatus,
            ...(result.webhookReason ? { webhookReason: result.webhookReason } : {}),
            capped: result.capped,
          },
          "export processed",
        );
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
