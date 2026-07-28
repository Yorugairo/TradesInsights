import { existsSync } from "node:fs";
import net from "node:net";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, e2eDatabaseUrl } from "@otn/db";

/**
 * Playwright global setup — the door that was left open.
 *
 * `testDatabaseUrl()` (repo root, `vitest.test-db.ts`) has existed all along,
 * already refuses a non-local DSN, and already prints a warning explaining why.
 * Vitest calls it. **Playwright never did**, so the e2e suite ran against the
 * hosted production database — and, because several tests POST, wrote to it.
 * Measured 2026-07-27: 30 of 30 `claim_corrections` and 30 of 30
 * `opportunity_outcomes` rows in production were e2e output, feeding the
 * customer's ROI scorecard and the "Won" figure on /app/pipeline.
 *
 * Importing the ROOT module rather than copying the rule is deliberate. Two
 * copies of "which database may tests touch" is how the two harnesses drift,
 * and the whole failure here was one harness not sharing the other's guard.
 *
 * This file does six things, in order of how loudly they fail:
 *   1. Refuses to run against a non-local database at all.
 *   2. Checks the database is actually up, and says `pnpm infra:up` if not.
 *   3. MIGRATES `otn_e2e` itself — the same thing vitest's `testDb()` does for
 *      `otn`. Before this, a new migration reached the e2e database only when
 *      someone remembered `pnpm db:setup:e2e`, and the forgetting cost a real
 *      debugging session (0038: new e2e tests 500ing on missing tables while
 *      all the old ones passed). Schema freshness is now structural; the seed
 *      command remains only for (re)building the CORPUS.
 *   4. Checks the corpus is present, and says `pnpm db:setup:e2e` if not.
 *   5. Verifies MUTATION_TABLES against pg_constraint: every table that
 *      FK-references a listed table must itself be listed, children before
 *      parents. The list used to be enforced by tribal knowledge and failed as
 *      FK errors mid-wipe; now it fails at suite start, naming the table.
 *   6. Wipes what previous RUNS wrote, so every run starts from the corpus
 *      alone instead of drifting until someone reseeds.
 */

/**
 * Every table the SUITE WRITES, children before parents — deleting a parent
 * first would trip its FK and fail the wipe loudly.
 *
 * Corpus tables (`projects`, `opportunities`, `organizations`, evidence,
 * roles, `resolution_reviews`) are absent BY DESIGN: the seeded review
 * cluster's `pending` status is corpus, not mutation, and wiping
 * `resolution_reviews` would delete the cluster-reject fixture. `raw_artifacts`
 * also stays: the corpus seeds artifacts, and an orphaned upload artifact is
 * inert.
 *
 * The wipe runs AFTER the non-local refusal above, so it can never touch `otn`
 * or production — keep it below that guard so the ordering is structural.
 */
const MUTATION_TABLES: readonly (readonly [table: string, writtenBy: string])[] = [
  ["feedback", "the feedback POSTs (3 per run)"],
  ["decision_labels", "opportunity keep/dismiss actions"],
  ["opportunity_outcomes", "the outcome POST (references pursuits — deleted first)"],
  ["claim_corrections", "the admin correction POST"],
  ["takeoff_lines", "child of takeoff_sheets (field-takeoff spec)"],
  ["takeoff_sheets", "the takeoff GET's first-call derive — child of pursuits"],
  ["field_entries", "crew log/CO submissions — child of field_links and pursuits"],
  ["field_links", "minted crew links — child of pursuits"],
  // The next two were the tripwire's first catch (2026-07-28), latent since
  // their features shipped: roi_events was never listed at all, and
  // relationship_interactions sat after pursuits, which it FK-references.
  // Either would have failed the wipe the first time a run wrote a
  // pursuit-linked row.
  ["roi_events", "ROI attribution log — child of pursuits and opportunities"],
  ["relationship_interactions", "child of account_organization_relationships AND pursuits"],
  ["pursuit_transitions", "child of pursuits"],
  ["pursuit_tasks", "child of pursuits"],
  ["pursuit_notes", "child of pursuits (takeoff stamp + CO decisions write these)"],
  ["pursuits", "the pursuit-open POST"],
  ["bid_invitation_events", "child of bid_invitations and inbound_messages"],
  ["bid_documents", "child of bid_invitations"],
  ["bid_invitations", "the .eml invitation upload"],
  ["inbound_messages", "the .eml upload's parent message"],
  ["account_organization_relationships", "relationship confirm actions"],
  ["account_suppressions", "suppression toggles (its test cleans up; belt and braces)"],
  ["action_tokens", "action links minted during runs"],
];
export default async function globalSetup(): Promise<void> {
  const url = e2eDatabaseUrl();
  const isLocal = /localhost|127\.0\.0\.1/.test(url);

  // 1. THE GUARD. `testDatabaseUrl()` already falls back to local, so reaching
  // here with a remote URL means someone set ALLOW_REMOTE_TEST_DB=1 explicitly.
  // That switch exists for vitest, where the blast radius is a developer's own
  // fixtures. Here it means "let the browser suite POST outcomes and immutable
  // corrections into production", which is never what anyone wants by accident.
  if (!isLocal) {
    throw new Error(
      [
        "",
        "  REFUSING to run e2e against a non-local database.",
        `  Resolved DATABASE_URL: ${url.replace(/:[^:@/]+@/, ":***@")}`,
        "",
        "  This suite POSTs outcomes, corrections, pursuits and feedback, and does",
        "  not clean them up. Against production it manufactures the evidence base:",
        "  30 of 30 rows in claim_corrections and opportunity_outcomes were e2e",
        "  output before this guard existed.",
        "",
        "  ALLOW_REMOTE_TEST_DB=1 is honoured by vitest but NOT here.",
        "",
      ].join("\n"),
    );
  }

  const parsed = new URL(url.replace(/^postgres(ql)?:/, "http:"));
  const host = parsed.hostname || "localhost";
  const port = Number(parsed.port || 5432);

  // 2. Is anything listening? A raw socket check, mirroring
  // `vitest.global-setup.ts` — no driver dependency, and it answers exactly the
  // question asked. Auth and schema problems are real failures and should
  // surface as such rather than being pre-empted here.
  const reachable = await new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(5_000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });

  if (!reachable) {
    throw new Error(
      [
        "",
        `  The e2e database is not reachable at ${host}:${port}.`,
        "",
        "  Start it with:   pnpm infra:up",
        "",
      ].join("\n"),
    );
  }

  const pg = await import("pg");
  const pool = new pg.default.Pool({ connectionString: url, max: 1 });
  try {
    // 3. MIGRATE. Resolved by candidate-walk rather than import.meta (Playwright
    // transpiles this graph to CJS, where import.meta is a syntax error — the
    // same constraint test-urls.ts documents for its .env walk). Idempotent and
    // ~fast when up to date; the corpus survives because migrations here are
    // additive by policy.
    const migrationsFolder = ["../../packages/db/migrations", "packages/db/migrations", "../packages/db/migrations"]
      .map((p) => resolve(process.cwd(), p))
      .find((p) => existsSync(p));
    if (!migrationsFolder) {
      throw new Error("cannot locate packages/db/migrations from " + process.cwd());
    }
    await migrate(createDb(pool), { migrationsFolder });

    // 4. Is the corpus there? Without it every test fails on an empty table and
    // reads as 29 broken assertions rather than one missing command.
    const res = await pool.query(
      `SELECT count(*)::int AS n FROM opportunities WHERE score_version = 'e2e-1'`,
    );
    const n = Number(res.rows[0]?.n ?? 0);
    if (n === 0) {
      throw new Error(
        [
          "",
          "  The e2e corpus is not in the database.",
          "",
          "  Seed it with:   pnpm db:setup:e2e",
          "",
          "  (Every assertion in this suite is written against that corpus, so",
          "   without it the run reports ~29 failures for one missing command.)",
          "",
        ].join("\n"),
      );
    }
    console.log(`[e2e] corpus present: ${n} opportunities on ${host}:${port}`);

    // 5. THE TRIPWIRE. The wipe below deletes parents (pursuits, deliveries'
    // children, …), so any table that FK-references a listed table MUST also be
    // listed, before its parent — or the wipe dies on an FK error halfway
    // through, and before this check existed the symptom was worse: a
    // migration's new child table simply never joined the list and the suite
    // 500ed. pg_constraint is the source of truth; the hand-written list is now
    // checked against it on every run instead of trusted.
    const listed = MUTATION_TABLES.map(([t]) => t);
    const fks = await pool.query(
      `SELECT DISTINCT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
       FROM pg_constraint c
       WHERE c.contype = 'f' AND c.confrelid::regclass::text = ANY($1::text[])`,
      [listed],
    );
    const problems: string[] = [];
    for (const { child, parent } of fks.rows as { child: string; parent: string }[]) {
      if (child === parent) continue;
      const ci = listed.indexOf(child);
      if (ci === -1) {
        problems.push(
          `${child} FK-references ${parent} but is not in MUTATION_TABLES — add it BEFORE ${parent}`,
        );
      } else if (ci > listed.indexOf(parent)) {
        problems.push(`${child} must come BEFORE ${parent} in MUTATION_TABLES (children are deleted first)`);
      }
    }
    if (problems.length > 0) {
      throw new Error(
        ["", "  MUTATION_TABLES is out of date with the schema:", ...problems.map((p) => `  - ${p}`), ""].join("\n"),
      );
    }

    // 6. THE WIPE. Tests write and do not clean up (that is what made them
    // dangerous against production); here the sandbox absorbs the writes and
    // this wipe returns it to the corpus baseline, so the third run sees the
    // same database as the first. Table names are literals from the list above.
    const wiped: string[] = [];
    for (const [table] of MUTATION_TABLES) {
      const del = await pool.query(`DELETE FROM ${table}`);
      if ((del.rowCount ?? 0) > 0) wiped.push(`${table} ${del.rowCount}`);
    }
    // Field-notify deliveries are run residue too (idempotency key
    // `field-co:{entryId}`, new entry ids every run — they accumulate). The
    // delete is BY TYPE because `deliveries` as a whole may carry corpus
    // rows (weekly digests); only this feature's rows are ours to remove.
    const fieldNotify = await pool.query(`DELETE FROM deliveries WHERE delivery_type = 'field_notify'`);
    if ((fieldNotify.rowCount ?? 0) > 0) wiped.push(`deliveries[field_notify] ${fieldNotify.rowCount}`);
    console.log(
      wiped.length > 0
        ? `[e2e] wiped prior-run rows: ${wiped.join(", ")}`
        : "[e2e] no prior-run rows to wipe",
    );
  } finally {
    await pool.end();
  }
}
