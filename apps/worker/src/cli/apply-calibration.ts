import "../load-env.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAccountProfiles } from "@otn/config";
import { isSeq, parseDocument, type YAMLSeq } from "yaml";

/**
 * pnpm calibration:apply <export.json> [--apply]
 *
 * Applies a calibration-session export (the JSON `intake.html` downloads) to
 * `config/account-profiles.yaml`.
 *
 * WHAT THIS CAN AND CANNOT DO, and why the split is not arbitrary.
 *
 * The export's confirmations are VERDICTS, not values: "that's right" or
 * "needs changing" plus a sentence of prose ("Drop Lewis, add Mason"). Every
 * free-text answer in sections 2-4 is likewise prose ("2 crews, 9 total",
 * "$40k-$250k"). So exactly one operation in this file is mechanical and safe:
 *
 *   a CONFIRMED assumption stops being an assumption — it leaves `owner_assumed`.
 *
 * That is the whole mechanical surface, and it is worth automating because it
 * is pure bookkeeping across a list a human would otherwise hand-edit while
 * reading a JSON file — the exact circumstance in which an item gets dropped
 * silently.
 *
 * Everything else is PRINTED for a human: corrections, answers, the GC list.
 * Turning "Drop Lewis, add Mason" into a yaml array edit requires understanding
 * the sentence, and a tool that guesses would write a territory nobody agreed
 * to. Printing it beside its `yamlPath` keeps the value of the export (nothing
 * is re-typed from memory) without inventing precision the data does not have.
 *
 * THE 1:1 TRIPWIRE. `docs/meetings/.../README.md` states that the form's
 * ASSUMPTIONS array and the yaml's `owner_assumed` list are deliberately 1:1,
 * in order. This script therefore pairs them BY POSITION — and refuses
 * entirely if the two lengths disagree, because a drifted pairing would remove
 * the wrong assumption while looking like it worked. Every pairing is printed
 * in the dry run so a human confirms the alignment before anything is written.
 *
 * DRY RUN BY DEFAULT, like every other supervised CLI here.
 */

const APPLY = process.argv.includes("--apply");
const EXPORT_PATH = process.argv.slice(2).find((a) => !a.startsWith("--"));

const CONFIG_DIR = join(process.cwd(), "..", "..", "config");
const YAML_PATH = join(CONFIG_DIR, "account-profiles.yaml");

/**
 * Paths whose change is governed by the §12.3 protocol: name the label
 * evidence, apply on a branch, rerun `pnpm eval:run`, re-baseline with the
 * owner present. This script never writes one, even when the answer is
 * unambiguous — the protocol is the point, not the value.
 */
const WEIGHT_BEARING = /score_components|priority_review_min|weekly_digest_min|weight/i;

interface Confirmation {
  id: string;
  setting: string;
  yamlPath: string;
  verdict: "confirm" | "correct" | null;
  correction: string | null;
}

interface CalibrationExport {
  account: string;
  session?: string;
  capturedAt?: string;
  confirmations: Confirmation[];
  answers?: Record<string, string>;
  gcs?: { name: string; relationship: string }[];
}

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

function main(): void {
  if (!EXPORT_PATH) fail("usage: pnpm calibration:apply <export.json> [--apply]");

  const exported = JSON.parse(readFileSync(EXPORT_PATH, "utf8")) as CalibrationExport;
  if (!exported.account || !Array.isArray(exported.confirmations)) {
    fail(`${EXPORT_PATH} does not look like a calibration export (no account / confirmations).`);
  }

  const banner = APPLY ? "APPLY — the yaml WILL be edited" : "DRY RUN — nothing will be written";
  console.log(`\n=== apply-calibration (${banner}) ===`);
  console.log(`account: ${exported.account}   session: ${exported.session ?? "?"}   captured: ${exported.capturedAt ?? "?"}\n`);

  const raw = readFileSync(YAML_PATH, "utf8");
  // parseDocument, NOT parse: account-profiles.yaml carries the reasoning for
  // nearly every setting in comments. `stringify(parse(x))` would silently
  // delete all of it, which is a far worse loss than the edit is a gain.
  const doc = parseDocument(raw);

  const accounts = doc.get("accounts");
  if (!isSeq(accounts)) fail("account-profiles.yaml has no `accounts` sequence.");
  const index = accounts.items.findIndex(
    (item) => (item as { get?: (k: string) => unknown }).get?.("key") === exported.account,
  );
  if (index < 0) fail(`no account with key "${exported.account}" in account-profiles.yaml.`);

  const assumed = doc.getIn(["accounts", index, "owner_assumed"]);
  if (!isSeq(assumed)) fail(`account "${exported.account}" has no owner_assumed list.`);
  const assumedItems = (assumed as YAMLSeq).items.map((i) => String((i as { value?: unknown }).value ?? i));

  // THE TRIPWIRE. Position pairing is only safe while the two lists are the
  // 1:1 the docs promise; a length mismatch means one drifted, and removing by
  // position would then take out the wrong line while appearing to succeed.
  if (assumedItems.length !== exported.confirmations.length) {
    fail(
      `REFUSING: the export carries ${exported.confirmations.length} confirmations but the yaml has ` +
        `${assumedItems.length} owner_assumed entries. These lists are documented as 1:1 and are paired ` +
        `by position, so a mismatch means one has drifted. Reconcile them by hand first.`,
    );
  }

  console.log("owner_assumed pairings (verify the alignment before applying):\n");
  const removals: number[] = [];
  const corrections: Confirmation[] = [];
  const unanswered: Confirmation[] = [];

  exported.confirmations.forEach((c, i) => {
    const entry = assumedItems[i] ?? "";
    const verdict =
      c.verdict === "confirm" ? "CONFIRMED — remove" : c.verdict === "correct" ? "needs changing" : "unanswered";
    console.log(`  [${String(i + 1).padStart(2)}] ${verdict}`);
    console.log(`       form: ${c.setting}`);
    console.log(`       yaml: ${entry}`);
    if (WEIGHT_BEARING.test(c.yamlPath)) {
      console.log(`       §12.3: ${c.yamlPath} is weight-bearing — never written by this tool`);
    }
    if (c.verdict === "confirm") removals.push(i);
    else if (c.verdict === "correct") corrections.push(c);
    else unanswered.push(c);
    console.log("");
  });

  console.log(
    `${removals.length} confirmed (removable), ${corrections.length} need changing, ${unanswered.length} unanswered.\n`,
  );

  if (corrections.length > 0) {
    console.log("── Corrections — PROSE, apply by hand ────────────────────────────");
    for (const c of corrections) {
      console.log(`  • ${c.setting}`);
      console.log(`    path: ${c.yamlPath}${WEIGHT_BEARING.test(c.yamlPath) ? "   [§12.3 protocol required]" : ""}`);
      console.log(`    owner said: ${c.correction ?? "(no text captured)"}\n`);
    }
  }

  const answers = Object.entries(exported.answers ?? {});
  if (answers.length > 0) {
    console.log("── Answers — free text, apply by hand ────────────────────────────");
    for (const [k, v] of answers) console.log(`  ${k.padEnd(28)} ${v}`);
    console.log("");
  }

  if ((exported.gcs?.length ?? 0) > 0) {
    // No yamlPath exists for these — the relationship lane is not wired to
    // config. Printing them is the honest end of this tool's responsibility.
    console.log("── GC relationships — no config destination yet ──────────────────");
    for (const g of exported.gcs ?? []) console.log(`  ${g.relationship.padEnd(16)} ${g.name}`);
    console.log("");
  }

  if (!APPLY) {
    console.log("Nothing was written. Re-run with --apply to remove the CONFIRMED assumptions.\n");
    return;
  }

  if (removals.length === 0) {
    console.log("Nothing to apply — no assumption was confirmed.\n");
    return;
  }

  // TEXT SPLICE, not re-serialization — the document is used only to LOCATE.
  //
  // Re-stringifying was tried first and is wrong for this file: it carries
  // hand-written MIXED flow styles (`[Thurston, Pierce]` unpadded beside
  // `{ component: trade_fit, weight: 30 }` padded), and yaml's stringifier
  // normalizes to one style or the other. Every option combination rewrote
  // some unrelated block — 17 changed lines to remove 4. Deleting the exact
  // source ranges instead leaves every other byte untouched, so the diff is
  // precisely the four removals and a reviewer can see that at a glance.
  const ranges = removals
    .map((i) => (assumed as YAMLSeq).items[i] as { range?: [number, number, number] } | undefined)
    .map((node) => node?.range)
    .filter((r): r is [number, number, number] => Array.isArray(r));
  if (ranges.length !== removals.length) {
    fail("REFUSING: could not locate every confirmed entry in the source text.");
  }

  let updated = raw;
  // valueEnd (range[1]), NOT nodeEnd (range[2]). nodeEnd runs to the next
  // token, so it swallows trailing comments and blank lines: using it deleted
  // 8 lines to remove 4 — including the `# Genuinely unknown` comment and the
  // head of `calibration_pending`. The result was still VALID yaml, which is
  // why validation did not catch it and reading the diff did.
  // Descending by offset, so each splice cannot shift the next one's range.
  for (const [start, end] of [...ranges].sort((a, b) => b[0] - a[0])) {
    // Expand to whole lines: back over the `      - ` prefix, forward past the
    // newline, so no blank stub is left behind.
    const lineStart = updated.lastIndexOf("\n", start) + 1;
    let lineEnd = updated.indexOf("\n", end);
    lineEnd = lineEnd < 0 ? updated.length : lineEnd + 1;
    updated = updated.slice(0, lineStart) + updated.slice(lineEnd);
  }
  writeFileSync(YAML_PATH, updated, "utf8");

  // The file must still LOAD. A write that leaves config unparseable would
  // take the next deploy down, and finding out at deploy time is too late.
  try {
    loadAccountProfiles(CONFIG_DIR);
  } catch (err) {
    writeFileSync(YAML_PATH, raw, "utf8");
    fail(`REVERTED: the edited yaml failed validation — ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log(`Removed ${removals.length} confirmed assumption(s) from owner_assumed. Config still validates.\n`);
}

main();
