#!/usr/bin/env node
/**
 * PALS genuine-visitor header capture — the operator-run half of the Phase A0
 * hydration lane (queue-cockpit plan).
 *
 * AUTHORIZATION & POSTURE
 * - Owner approved scaling this lookup/hydration 2026-07-24. Terms of Use were
 *   accepted under owner authorization 2026-07-19 (see
 *   fixtures/pierce_pals_contractor/metadata.json for the verbatim ToU clause);
 *   the RCW 42.56.070(8) scope was reconciled by the owner: this resolves the
 *   identity of licensed BUSINESSES on permits we already hold — it builds no
 *   commercial list of individuals.
 * - This script drives the REAL PALS SPA in a real Chromium. The app mints its
 *   own reCAPTCHA Enterprise token per request, exactly as for any visitor —
 *   nothing here mints, forges, or bypasses a control. If PALS declines to
 *   serve (403/timeout), that is treated as the answer: the script STOPS after
 *   `--max-failures` consecutive misses instead of pushing harder.
 * - Run it from the operator's in-region machine (precedent: the 2026-07-19
 *   capture and every other operator-local source). Low and slow: default
 *   2.5s+jitter between permits, plus a full page load per permit (~2-4s of
 *   Angular bootstrap — see the FULL DOCUMENT LOAD note in the loop for why
 *   that is mandatory, not incidental). Budget ~6-8s/permit: a 250 batch is
 *   roughly 25-35 minutes.
 * - LOOKUP-CLASS HARD RULE: the input list comes from pals-hydrate-export
 *   (permits we already hold). This script never discovers or crawls.
 *
 * USAGE (run from the repo ROOT — @playwright/test is a root devDependency
 * specifically so this resolves there; Node's ESM resolver walks up from
 * THIS FILE's own location, not the caller's cwd, so it must live under an
 * ancestor directory of a node_modules that has the package — repo root
 * qualifies, apps/web does NOT, since apps/web is scripts/'s sibling, not
 * its ancestor):
 *   node scripts/pals-header-capture.mjs \
 *     --list=apps/worker/pals-hydrate-seed.json --out=$OTN_CAPTURE_DIR/pierce_pals_contractor \
 *     [--limit=250] [--delay-ms=2500] [--max-failures=5] [--headless]
 *
 * Output: one verbatim `<applPermitId>.json` per permit (the raw response body,
 * stored BEFORE any parsing — spec §5). Already-captured ids are skipped, so
 * reruns resume where the last batch stopped. Ingest afterwards with:
 *   OTN_CAPTURE_DIR=<dir-above-out> pnpm --filter @otn/worker source:run:operator-local
 */
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";

const BASE = "https://pals.piercecountywa.gov/palsonline/";
const HEADER_API = "webApplPermitStatusHeader";

function arg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

/**
 * Race a promise against a hard deadline, ALWAYS clearing the timer.
 * An uncleared setTimeout per permit would keep the Node process alive after
 * the batch finished and, at 250 permits, pile up hundreds of live timers.
 */
function withDeadline(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: exceeded ${ms}ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Accept the Terms-of-Use modal if it is showing, else do nothing.
 * Safe to call on every page load: absence is the normal case once the session
 * has accepted it. A modal whose markup has changed is LEFT ALONE rather than
 * force-clicked — acceptance is owner-authorized for THIS modal, not a blanket
 * licence to dismiss whatever dialog the site puts up.
 */
async function acceptTouIfPresent(page, announce = false) {
  try {
    await page.getByRole("button", { name: /^yes$/i }).click({ timeout: 3000 });
    if (announce) console.log("ToU modal accepted (owner-authorized, 2026-07-19 / scale 2026-07-24).");
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const listPath = arg("list");
  const outDir = arg("out");
  if (!listPath || !outDir) {
    console.error("required: --list=<seed file from pals-hydrate-export> --out=<capture dir>");
    process.exit(2);
  }
  const limit = Number(arg("limit", "250"));
  const delayMs = Number(arg("delay-ms", "2500"));
  const maxFailures = Number(arg("max-failures", "5"));

  const seed = JSON.parse(await readFile(listPath, "utf8"));
  const ids = (seed.permitIds ?? []).filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) {
    console.error("seed file has no permitIds — run pals-hydrate-export first");
    process.exit(2);
  }
  await mkdir(outDir, { recursive: true });

  // @playwright/test is a ROOT devDependency (Node's ESM resolver walks up
  // from this file's own path, not cwd — see the USAGE comment above for why
  // that ruled out apps/web). Fail with instructions, not a bare module error.
  let chromium;
  try {
    ({ chromium } = await import("@playwright/test"));
  } catch {
    console.error(
      "Cannot resolve @playwright/test — run `pnpm install` at the repo root " +
        "(it is a root devDependency; see USAGE in this file for why).",
    );
    process.exit(2);
  }

  const summary = { attempted: 0, saved: 0, emptyNotInPals: 0, skippedExisting: 0, failures: 0 };
  let consecutiveFailures = 0;

  // Headed by default: this is a genuine-visitor flow, and headed is the honest
  // shape of it. --headless is for the operator's unattended in-region box.
  const browser = await chromium.launch({ headless: flag("headless") });
  try {
    const page = await browser.newPage();
    // Playwright gotcha (documented, not hypothetical): a native dialog
    // (confirm/alert/beforeunload prompt) blocks ALL further page interaction
    // — including page.evaluate/page.goto, which have NO timeout of their own
    // — until dismissed. Without this handler, one permit whose view happens
    // to trigger a dialog hangs the whole batch forever, silently, on
    // whatever url was showing. Log it rather than swallow it, so a recurring
    // dialog on a specific permit TYPE becomes visible instead of mysterious.
    page.on("dialog", async (dialog) => {
      console.error(`[dialog] "${dialog.message()}" — auto-dismissed`);
      try {
        await dialog.dismiss();
      } catch {
        /* already gone */
      }
    });
    await page.goto(`${BASE}#/permitSearch`, { waitUntil: "domcontentloaded" });
    if (!(await acceptTouIfPresent(page, true))) {
      console.log("No ToU modal on the landing page — continuing (may already be accepted).");
    }

    for (const id of ids) {
      if (summary.attempted >= limit) break;
      const file = join(outDir, `${id}.json`);
      try {
        await access(file);
        summary.skippedExisting += 1;
        continue; // resume semantics: never re-fetch a captured permit
      } catch {
        /* not captured yet */
      }
      summary.attempted += 1;

      try {
        const hash = `#/permitSearch/permit/departmentStatus?applPermitId=${id}`;
        // ── FULL DOCUMENT LOAD PER PERMIT — the crux of this script's reliability.
        //
        // A goto() whose URL differs from the current one ONLY in the hash
        // fragment is a SAME-DOCUMENT navigation: the browser fires hashchange,
        // the document is never reloaded, and Angular is never re-bootstrapped.
        // That makes it behave identically to writing `location.hash` directly
        // (the approach this replaced — the "fix" was not a fix). If the app's
        // router has drifted into a state where it no longer re-fetches on
        // hashchange, NOTHING throws: the URL visibly updates while no request
        // is ever made, and the batch stalls silently. Observed in the field
        // twice, on different permits, after ~48 successful captures each time.
        //
        // Bouncing through about:blank forces every permit to be a genuine
        // CROSS-document load, so the app re-bootstraps and re-fetches from a
        // clean state — which is also exactly what a visitor opening a permit
        // URL fresh produces. Costs ~2-4s of Angular bootstrap per permit.
        await withDeadline(page.goto("about:blank"), 15000, `permit ${id}: blank`);

        // Registered AFTER the blank bounce (a navigation can abort a waiter
        // registered before it) but BEFORE the real load, so a fast response
        // cannot arrive un-awaited.
        const respPromise = page.waitForResponse(
          (r) => r.url().includes(HEADER_API) && r.url().includes(`applPermitId=${id}`),
          { timeout: 30000 },
        );
        await withDeadline(
          page.goto(`${BASE}${hash}`, { waitUntil: "domcontentloaded" }),
          30000,
          `permit ${id}: load`,
        );
        // A genuine reload can re-present the ToU modal, and the app will not
        // fetch until it is dismissed — so this has to run INSIDE the loop, not
        // once at startup. respPromise is already pending and catches the
        // response that follows dismissal.
        await acceptTouIfPresent(page);
        const resp = await respPromise;
        const body = await resp.text();
        const parsed = JSON.parse(body); // verbatim body is what we STORE; parse only to classify
        if (!Array.isArray(parsed)) throw new Error(`non-array header body (status ${resp.status()})`);
        await writeFile(file, body);
        if (parsed.length === 0) summary.emptyNotInPals += 1;
        else summary.saved += 1;
        consecutiveFailures = 0;
      } catch (err) {
        summary.failures += 1;
        consecutiveFailures += 1;
        console.error(`permit ${id}: ${err.message ?? err}`);
        if (consecutiveFailures >= maxFailures) {
          console.error(
            `${maxFailures} consecutive failures — PALS is declining to serve this session. ` +
              "Stopping (never push against the gate); rerun later resumes automatically.",
          );
          break;
        }
      }
      await new Promise((r) => setTimeout(r, delayMs + Math.floor(Math.random() * 1000)));
    }
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(summary, null, 2));
  if (summary.saved + summary.emptyNotInPals === 0 && summary.attempted > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
