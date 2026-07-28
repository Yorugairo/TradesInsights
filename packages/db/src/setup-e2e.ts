import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { e2eDatabaseUrl } from "./test-urls.js";

/**
 * pnpm db:setup:e2e — build the e2e database from nothing.
 *
 * Migrates, seeds sources/accounts from config, then lays the corpus on top —
 * all three against `otn_e2e`, a database of its own.
 *
 * WHY A SEPARATE DATABASE and not just a separate host from production: the
 * corpus inserts projects and opportunities that the vitest suite would then
 * read. Measured — seeding it into vitest's `otn` broke `assistant.test.ts`,
 * which asserts a filter returns exactly one row and got two. That is the same
 * "one suite writes what another reads" defect this workstream exists to
 * remove, so it gets the same answer rather than a tuned corpus.
 *
 * WHY SUBPROCESSES rather than importing the three mains: each is a CLI that
 * reads `DATABASE_URL` at module load and calls `process.exit`. Spawning with an
 * overridden env is honest about that; importing them would need all three
 * refactored into functions, which is a bigger change than this task warrants.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const DB_PACKAGE = join(HERE, "..");

const STEPS: { label: string; script: string }[] = [
  { label: "migrate", script: "src/migrate.ts" },
  { label: "seed (sources + accounts from config)", script: "src/seed.ts" },
  { label: "seed:e2e (the corpus)", script: "src/seed-e2e.ts" },
];

/**
 * DROP and recreate the e2e database, so this command really does build from
 * nothing.
 *
 * Without it a half-applied migration leaves the database in a state the
 * migrator will not repair: the run that failed had already recorded journal
 * entries for tables it created in the WRONG schema, so every retry failed
 * differently. A test database is disposable by definition — that is what makes
 * it a test database — and the local-only guard above is what makes dropping it
 * safe to automate.
 */
async function recreateDatabase(url: string): Promise<void> {
  const target = new URL(url.replace(/^postgres(ql)?:/, "http:")).pathname.replace(/^\//, "");
  if (!/^otn_e2e$/.test(target)) {
    throw new Error(`refusing to drop a database not named otn_e2e (got "${target}")`);
  }
  // Connect to a DIFFERENT database — you cannot drop the one you are in.
  const admin = url.replace(/\/otn_e2e(\?|$)/, "/otn$1");
  const pg = await import("pg");
  const pool = new pg.default.Pool({ connectionString: admin, max: 1 });
  try {
    await pool.query(`DROP DATABASE IF EXISTS ${target} WITH (FORCE)`);
    await pool.query(`CREATE DATABASE ${target}`);
  } finally {
    await pool.end();
  }
}

/**
 * A fresh database has none of the schemas the migrations assume.
 *
 * The first migration creates its tables UNQUALIFIED, so they land in the first
 * existing schema on the search_path. Without `insights` that is `public`, the
 * migration "succeeds", and a later view migration then fails on
 * `relation "insights.account_profiles" does not exist` — a confusing error
 * whose real cause is four migrations earlier.
 */
async function bootstrapSchemas(url: string): Promise<void> {
  const pg = await import("pg");
  const pool = new pg.default.Pool({ connectionString: url, max: 1 });
  try {
    await pool.query("CREATE SCHEMA IF NOT EXISTS insights");
    await pool.query("CREATE SCHEMA IF NOT EXISTS insights_public");
    await pool.query("CREATE EXTENSION IF NOT EXISTS postgis");
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const url = e2eDatabaseUrl();
  if (!/localhost|127\.0\.0\.1/.test(url)) {
    throw new Error(`refusing to set up a non-local e2e database: ${url.replace(/:[^:@/]+@/, ":***@")}`);
  }
  console.log(`e2e database: ${url.replace(/:[^:@/]+@/, ":***@")}\n`);

  console.log("── recreate database");
  await recreateDatabase(url);

  console.log("── bootstrap schemas");
  await bootstrapSchemas(url);

  for (const step of STEPS) {
    console.log(`── ${step.label}`);
    // `shell: true` on Windows, and Node WILL warn about it (DEP0190: args are
    // concatenated unescaped). Accepted deliberately: every argument here is a
    // hard-coded literal from STEPS, so there is no untrusted input for the
    // warning to be about. The alternative — naming `npx.cmd` directly — fails
    // outright on Node 24 with `spawnSync npx.cmd EINVAL`, which is how this
    // comment came to exist.
    execFileSync("npx", ["tsx", step.script], {
      cwd: DB_PACKAGE,
      stdio: "inherit",
      shell: process.platform === "win32",
      // DATABASE_URL last so the repo .env, loaded by each script, cannot win.
      env: { ...process.env, DATABASE_URL: url },
    });
  }
  console.log("\ne2e database ready.");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
