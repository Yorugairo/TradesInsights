import net from "node:net";
import { e2eDatabaseUrl } from "@otn/db";

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
 * This file does three things, in order of how loudly they fail:
 *   1. Refuses to run against a non-local database at all.
 *   2. Checks the database is actually up, and says `pnpm infra:up` if not.
 *   3. Checks the corpus is present, and says `pnpm db:seed:e2e` if not.
 */
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

  // 3. Is the corpus there? Without it every test fails on an empty table and
  // reads as 29 broken assertions rather than one missing command.
  const pg = await import("pg");
  const pool = new pg.default.Pool({ connectionString: url, max: 1 });
  try {
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
  } finally {
    await pool.end();
  }
}
