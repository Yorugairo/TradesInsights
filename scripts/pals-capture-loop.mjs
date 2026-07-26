#!/usr/bin/env node
/**
 * Sequential PALS capture sessions — the throughput answer that is NOT "more
 * browsers in parallel".
 *
 * WHY SEQUENTIAL. Measured across two full runs, a session stops serving after
 * roughly SEVEN MINUTES of active capture rather than after a fixed number of
 * requests: run 1 managed 54 attempts at a 2.5s delay, run 2 managed 44 at 3s —
 * different counts, same wall-clock. That points at a session/token TTL, which
 * means N concurrent browsers would each still die at seven minutes. You would
 * buy N-times throughput inside one window in exchange for N-times the
 * instantaneous load on a county government server, purely to outpace a limit
 * the service is expressing. That is the "push against the gate" the capture
 * script exists to refuse. Letting an expired session end and starting a new one
 * is what a real browser does; running three at once to beat the limit is not.
 *
 * (Two runs is thin evidence for a TTL. It is held loosely — but the batching
 * below is the right shape either way, because a fresh session is what recovers
 * from BOTH a TTL and a per-session request budget.)
 *
 * Each round spawns a FRESH `pals-header-capture.mjs` process, so it gets a new
 * browser and a new token. `--limit` per round stays under the observed wall so
 * the session ends on our terms instead of on five consecutive failures — a
 * clean stop leaves no half-open page and burns no attempts against the gate.
 *
 * The capture script skips ids it has already saved, so each round resumes where
 * the last stopped and this wrapper keeps no state of its own.
 *
 * Run from the repo ROOT (same reason as the capture script: @playwright/test is
 * a root devDependency and Node's ESM resolver walks up from the SCRIPT's own
 * location).
 *
 * Usage:
 *   node scripts/pals-capture-loop.mjs [--rounds=8] [--per-round=40]
 *                                      [--gap-seconds=90] [--delay-ms=3000]
 *
 * Then ingest:
 *   OTN_CAPTURE_DIR=$(pwd)/artifacts/captures \
 *     pnpm --filter @otn/worker source:run:operator-local
 */
/* global console, process, setTimeout */
// Declared at the source rather than by widening eslint.config.mjs: these are
// Node globals, genuinely defined here, and the flat config simply does not
// declare an environment for scripts/. A file-level declaration is the honest
// fix — it asserts what is true of THIS file instead of relaxing a rule repo-wide.
import { spawn } from "node:child_process";
import { readdirSync, existsSync, mkdirSync } from "node:fs";

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const num = (name, fallback) => {
  const v = Number(arg(name, String(fallback)));
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const ROUNDS = num("rounds", 8);
const PER_ROUND = num("per-round", 40);
const GAP_SECONDS = num("gap-seconds", 90);
const DELAY_MS = num("delay-ms", 3000);
const SEED = arg("list", "apps/worker/pals-hydrate-seed.json");
const OUT = arg("out", "artifacts/captures/pierce_pals_contractor");

if (!existsSync(SEED)) {
  console.error(
    `seed not found: ${SEED}\n` +
      "run: pnpm --filter @otn/worker pals:hydrate:export --account=<key>",
  );
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const banked = () => readdirSync(OUT).filter((f) => f.endsWith(".json")).length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One capture session. Resolves however it ends — a session that stops early is
 * information, not an error, so the loop decides what to do rather than dying. */
function runRound() {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "scripts/pals-header-capture.mjs",
        `--list=${SEED}`,
        `--out=${OUT}`,
        `--limit=${PER_ROUND}`,
        `--delay-ms=${DELAY_MS}`,
        "--max-failures=5",
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    child.on("close", (code) => resolve(code ?? 0));
    child.on("error", (err) => {
      console.error(`round failed to start: ${err.message}`);
      resolve(1);
    });
  });
}

const startTotal = banked();
console.log(
  `pals capture loop: ${ROUNDS} rounds x ${PER_ROUND} permits, ${GAP_SECONDS}s gap. banked: ${startTotal}`,
);

for (let i = 1; i <= ROUNDS; i += 1) {
  const before = banked();
  console.log(`--- round ${i}/${ROUNDS} (banked ${before}) ---`);
  await runRound();
  const after = banked();
  const gained = after - before;
  console.log(`round ${i}: saved ${gained} (total ${after})`);

  // A round that saves NOTHING means PALS is refusing across sessions, not
  // merely expiring one. A new session will not fix that, and grinding through
  // the remaining rounds would be exactly the behaviour this pipeline refuses.
  if (gained === 0) {
    console.log(
      `round ${i} gained nothing — PALS is declining across sessions, not just expiring one.\n` +
        "Stopping. Try again in a few hours; the seed and captures resume untouched.",
    );
    break;
  }

  if (i < ROUNDS) {
    console.log(`sleeping ${GAP_SECONDS}s before the next session`);
    await sleep(GAP_SECONDS * 1000);
  }
}

const finalTotal = banked();
console.log(`done. banked ${finalTotal} total (+${finalTotal - startTotal} this loop)`);
console.log(
  "ingest with: OTN_CAPTURE_DIR=$(pwd)/artifacts/captures " +
    "pnpm --filter @otn/worker source:run:operator-local",
);
