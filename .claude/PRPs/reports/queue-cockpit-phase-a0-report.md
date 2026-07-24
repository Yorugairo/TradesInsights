# Implementation Report: Queue cockpit — Phase A0 (PALS licence hydration at scale)

## Summary
Phase A0 of `queue-cockpit.plan.md`, upgraded from "measure and stop" to "build
the lane" by the owner's approval ("Approved to scale the PALS lookup/hydration",
2026-07-24). Shipped as Insights `d22b41c` (`claude/tmux-install-320aiz`).
Phases A1–A6 (Google Places enrichment) and B–E remain; the plan stays in
`plans/`, not archived.

## What existed already (verified, not assumed)
| Piece | Where | State |
|---|---|---|
| Pierce external_id = PALS applPermitId | `source_records` + sourceUrl embeds it | confirmed live |
| Adapter (parse, masked-licence safety, invariants, gate-respecting fetch) | `packages/adapters/src/pierce-pals-contractor.ts` | contract-complete since the 2026-07-19 fixture session |
| `contractorLicense` → `contractor_number` identifier | `identifiers.ts:287-289` | plumbed |
| NULL-only stamp of `organizations.contractor_registration` | `identifiers.ts:321` | plumbed |
| Deterministic bind on that column | `registry-link.ts` (`contractor_number_exact`) | plumbed |
| Capture-fed operator-local run pattern | `source-run-operator-local.ts` + tumwater precedent | reused verbatim |
| Playwright | `apps/web` devDependencies | already present — **but not usable from `scripts/`; see Deviation 4** |

## What was built
| File | Action | Purpose |
|---|---|---|
| `packages/adapters/src/pierce-pals-contractor.ts` | UPDATE | capture-fed discover (staged files ARE the work list) + fetch (staged file IS the artifact); checkpoint seed order preserved |
| `apps/worker/src/cli/pals-hydrate-export.ts` | CREATE | seed list: every un-enriched Pierce permit, recent-first, + full-pool type mix (the A0 yield report basis) |
| `scripts/pals-header-capture.mjs` | CREATE | operator-run genuine-visitor capture (real SPA, app-minted tokens, stop-on-failures, verbatim raw storage, resumable) |
| `config/sources.yaml` | UPDATE | enabled for operator-local runs; authorization chain recorded in notes |
| `packages/config/src/loader.test.ts` | UPDATE | pinned activation set gains the source (the gate test doing its job) |
| `packages/adapters/src/pierce-pals-contractor.test.ts` | UPDATE | 4 new capture-fed tests (staged discovery, non-numeric ignored, checkpoint union order, verbatim fetch → end-to-end parse) |
| `apps/worker/package.json` | UPDATE | `pals:hydrate:export` script |

## Validation
| Check | Result |
|---|---|
| Adapter tests | 15/15 (11 existing + 4 new) |
| Full suite | **852 passed / 94 files** |
| Typecheck | 11 projects clean |
| Config activation gate | updated deliberately, passes |

## Deviations
1. **A0 scope upgraded** from measurement-only to full lane build — owner
   instruction, not drift.
2. **Discovery ordering bug caught by an existing test**: my first version
   sorted the union of checkpoint + staged ids, destroying the seed list's
   recent-first priority. Fixed in the implementation (checkpoint order
   preserved, staged ids append), not the test.
3. **No live PALS traffic from this session.** The capture step is operator-run
   and in-region by the established precedent; the four 2026-07-19 fixtures
   served as the staged-capture proof (fetch → parse end-to-end test).

## The authorization chain (recorded in config + script + adapter)
ToU accepted 2026-07-19 under owner authorization → RCW 42.56.070(8) scope
reconciled by owner 2026-07-24 as identity resolution of licensed BUSINESSES on
permits already held (no commercial list of individuals) → scaling approved
2026-07-24. Posture: real SPA mints its own reCAPTCHA tokens; 5 consecutive
failures aborts; low-and-slow (2.5s+jitter, 250/batch); lookup-class hard rule
(never crawl) enforced by the seed CLI.

## Operator runbook (per batch)

**Windows, one command** (added 2026-07-24 after a manual run surfaced two
paper cuts — PowerShell execution-policy blocking `pnpm.ps1`, and
`pnpm --filter <pkg> <script>` running with cwd set to that PACKAGE, not repo
root, which silently misplaced the seed file on the first manual attempt):
```
scripts\pals-hydrate-batch.cmd [limit]
```
Self-locating (works double-clicked from Explorer or run from any directory),
sequences all three steps below, aborts with a clear message on failure at any
step, safe to re-run (already-captured permits are skipped, so re-running after
an ingest failure does not re-open the browser).

**Manual / non-Windows equivalent** (what the batch file wraps — run entirely
from repo root, per Deviation 4 below):
```bash
pnpm --filter @otn/worker pals:hydrate:export --limit=250
node scripts/pals-header-capture.mjs --list=apps/worker/pals-hydrate-seed.json --out=$OTN_CAPTURE_DIR/pierce_pals_contractor
OTN_CAPTURE_DIR=<dir> pnpm --filter @otn/worker source:run:operator-local
```
Then the nightly resolve/link pass stamps licences and binds deterministically.

## Deviation 4 (post-ship correction, same day): playwright resolution
The original design ran the capture script from `apps/web` on the theory that
`cd`-ing there would put `@playwright/test` on its module search path. Wrong —
Node's ESM resolver walks up ancestor directories from the *importing file's
own path* (`import.meta.url`), not from `process.cwd()`. `scripts/` and
`apps/web/` are siblings, so `apps/web/node_modules` was never reachable no
matter the caller's directory. First real run surfaced this immediately
(`Cannot resolve @playwright/test — run from apps/web`, even when run FROM
apps/web).

Fix: added `@playwright/test@^1.50.0` as a **root** devDependency (repo root
is a genuine ancestor of `scripts/`, matching how `typescript`/`vitest`/
`eslint` already live there for the same reason) and ran `pnpm install`.
Verified with a resolution-only smoke test (`node -e "import('@playwright/test')…"`
from repo root — succeeds) before re-testing the real script. Simplified the
batch file and the manual runbook to run everything from repo root — the
`apps/web` step is gone entirely, not just relocated.

## Yield context (live)
Addressable pool: **6,145 Pierce permits, zero enriched**. Caveat for the yield
measurement: 4,544 carry `permitType: unknown` on the ArcGIS side (New
Structure 998, Remodel 421, Addition 77, TI 52 are the labelled slices), so
type-stratified `contrLicNum` yield will come from the capture batches
themselves, not the seed list. First batch report = the real A0 measurement.

## Next Steps
- [ ] Operator: run the first 250-permit batch (runbook above), report the
      `saved / emptyNotInPals / failures` summary + contrLicNum yield
- [ ] `/prp-implement` next pass: Phase A1–A6 (Google Places enrichment —
      phone/website fuel for unbound orgs)
- [ ] Then B (corporate-family accept → registry export), C (cockpit), D
      (Google Place queue + the 926 auto-resolver), E (domain groundwork)
