import net from "node:net";
import { testDatabaseUrl } from "./vitest.test-db.js";

/**
 * Fail FAST and legibly when the local test database is not up.
 *
 * Without this, a stopped Docker container presents as 40 failed test FILES and
 * 262 skipped tests, with `ECONNREFUSED ::1:5433` buried in a stack trace inside
 * each one. That reads like the code is broken. It is not — it is one container.
 *
 * Deliberately a raw TCP connect rather than a real Postgres handshake: `pg` is a
 * workspace dependency of @otn/db and is NOT resolvable from the repo root where
 * vitest config lives (the first version of this file failed with "Cannot find
 * package 'pg'"). A socket check needs no dependency and answers exactly the
 * question being asked — is anything listening? Auth and schema problems are
 * genuine test failures and should surface as such, not be pre-empted here.
 *
 * The DB is intentionally LOCAL and not the hosted Supabase (see the
 * PRODUCTION-SAFETY GUARD in vitest.config.ts): tests delete rows and insert
 * fixture projects/orgs/opportunities into shared tables, so pointing them at
 * the shared database would corrupt real counts and let two agents running
 * `vitest` concurrently clobber each other's `fake_source` fixture.
 */
export default async function setup(): Promise<void> {
  // MUST be the resolved test URL, not process.env.DATABASE_URL — that is the
  // HOSTED database, which is always reachable, so checking it reported healthy
  // while the local container was stopped and every DB test was about to fail.
  const url = testDatabaseUrl();

  let host: string;
  let port: number;
  try {
    const parsed = new URL(url);
    host = parsed.hostname || "localhost";
    port = Number(parsed.port || 5432);
  } catch {
    return; // Unparseable DSN is the suite's problem to report, not ours.
  }

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
        `  The test database is not reachable at ${host}:${port}.`,
        "",
        "  Start it with:   pnpm infra:up",
        "",
        "  (Tests deliberately use a LOCAL database, never the hosted one — they",
        "   delete rows and insert fixtures into shared tables.)",
        "",
      ].join("\n"),
    );
  }
}
