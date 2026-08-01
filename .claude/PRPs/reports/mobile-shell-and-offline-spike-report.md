# Implementation Report: Mobile M0+M1 — offline spike, installable shell, digest reader

**Date:** 2026-08-01
**Plan:** `.claude/PRPs/plans/completed/mobile-shell-and-offline-spike.plan.md`
**PRD:** `.claude/prds/trades-insights-mobile.prd.md` (milestones 0 + 1)
**Repo/branch:** TradesInsights, `claude/tmux-install-320aiz`
**Hosted DB:** `arbmeioglflvzoffgtii` (schema `insights`) — migration 0042 applied

## Summary

Insights is installable, the digest is readable on a phone, and a field entry
captured with no signal survives a force-quit and reaches the server exactly
once. Nine of ten tasks are complete; **Task 8 (the real-device spike) is a
manual protocol that cannot be executed from here** and remains the gate on
Milestone 2.

## Assessment vs reality

| Metric | Plan | Actual |
|---|---|---|
| Complexity | Large | Large — as scoped |
| Confidence | 8/10 | Justified; one real bug found by the tests it specified |
| Files | ~14 | 16 (10 created, 6 modified) |
| Tasks | 10 | 9 complete, 1 manual/deferred |

## Tasks

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Decision record | Complete | 9 ADRs + measured-inputs section |
| 2 | Migration 0042 + idempotent `addFieldEntry` | Complete | Applied to hosted; partial index verified |
| 3 | Route threads `clientEntryId` | Complete | Plus an unplanned fix — see deviations |
| 4 | Manifest + icons + SW | Complete | Icons generated from cockpit palette |
| 5 | Offline outbox client | Complete | One real bug found and fixed |
| 6 | Digest reader | Complete | Account-scoped; 3 e2e assertions |
| 7 | e2e specs | Complete | 8 new tests, no existing spec edited |
| 8 | **Real-device spike** | **NOT DONE — manual** | Requires a physical phone in a real building |
| 9 | Hosted migrate + close-out | Complete | Verified on hosted |
| 10 | M2 seed | Complete | In `MOBILE_DECISIONS.md` |

## Validation

| Gate | Result |
|---|---|
| `pnpm typecheck` | Clean (11 workspaces) |
| `pnpm lint` | Clean |
| `pnpm test` | **1325 passed** (+9 new) |
| `pnpm test:e2e` | **47 passed**, 0 failed (+8 new) |
| `pnpm --filter @otn/web build` | Clean; `/manifest.webmanifest`, `/offline`, `/app/digests/[id]` emitted |
| `pnpm eval:run` | **Byte-identical** — precision 1, recall 0.9609375, Solis 22/22, gates pass |
| `pnpm db:migrate` (hosted) | Applied; column + partial unique index confirmed live |

## The bug the tests were written to catch, and did

The first offline client called `event.preventDefault()` **after** awaiting an
IndexedDB read. By then the browser had already begun submitting, so the call
did nothing: offline, the form navigated to a network-error page and the crew's
typed text was gone — the exact failure the whole feature exists to prevent.

`mobile-offline-field.spec.ts` failed on it immediately (`field-outbox` never
appeared). The fix cancels the event and snapshots `FormData` synchronously, then
decides asynchronously whether to queue or hand back to the browser via
`form.submit()`. Recorded in `MOBILE_DECISIONS.md` because any future
interception (photos, CO drafts) will hit the same trap.

## Deviations from plan

**1. Unit tests cannot prove exactly-once — e2e does.** The plan's Task 2
VALIDATE assumed a DB-backed unit test. No intelligence test touches a database;
they are pure-logic with hand-built fixtures. `field.test.ts` therefore covers
validation and branching against a stub, and says in its own header that it
*cannot* prove the index works — a stub would pass even with migration 0042
missing. The real assertion (same id, `deduped: true`, HTTP 200 on replay) lives
in `mobile-offline-field.spec.ts` against a real database.

**2. No `field-entries` list endpoint exists.** The plan's e2e assertions read
one. `[entryId]` is the only sub-route. The offline test now asserts against the
crew page's own server-rendered Recent list (given a `data-testid`), and the
idempotency test relies on the returned id being identical — which can only hold
if no second row was inserted.

**3. Unplanned fix: change-order notifications must not re-fire on replay.** The
route now skips `sendFieldChangeOrderNotification` when `deduped` is true.
Without it, an outbox retrying through a lost response would email the owner once
per attempt for a single change order. Found while threading the key through.

**4. `/offline` fallback page added** (not in the plan's file list). The service
worker needs somewhere to send a request for a page never opened on the device.
It states plainly that queued work is safe — the reassurance that matters when a
crew sees an error screen.

## Files changed

| File | Action |
|---|---|
| `docs/design/MOBILE_DECISIONS.md` | CREATE |
| `packages/db/migrations/0042_field_entry_idempotency.sql` | CREATE |
| `packages/db/migrations/meta/_journal.json` | UPDATE (idx 42) |
| `packages/intelligence/src/field.ts` | UPDATE (idempotent insert) |
| `packages/intelligence/src/field.test.ts` | CREATE (9 tests) |
| `apps/web/app/api/field/[token]/entries/route.ts` | UPDATE |
| `apps/web/app/manifest.ts` | CREATE |
| `apps/web/public/sw.js` | CREATE |
| `apps/web/public/icons/{192,512,maskable-512}.png` | CREATE |
| `apps/web/app/offline/page.tsx` | CREATE |
| `apps/web/app/field/[token]/offline-client.tsx` | CREATE |
| `apps/web/app/field/[token]/page.tsx` | UPDATE (mount + testid) |
| `apps/web/lib/queries.ts` | UPDATE (`digestById`) |
| `apps/web/app/app/digests/page.tsx` | UPDATE (row links) |
| `apps/web/app/app/digests/[id]/page.tsx` | CREATE |
| `apps/web/e2e/mobile-offline-field.spec.ts` | CREATE (5 tests) |
| `apps/web/e2e/digest-reader.spec.ts` | CREATE (3 tests) |

## What is NOT proven

- **Nothing about real devices.** Force-quit durability, 48-hour eviction,
  `storage.persist()` grants, actual no-signal durations and sunlight legibility
  are all unmeasured. Playwright's `setOffline` is a proxy, not evidence.
- **iOS PWA behaviour** is asserted from documentation (no Background Sync API),
  not observed here.
- The **icons are generated geometric marks**, not brand assets — a gold chevron
  on the cockpit canvas. Replace before any public launch.

## Next steps

- [ ] **Run the Task 8 device protocol** — it gates Milestone 2.
- [ ] Replace generated icons with real brand assets.
- [ ] `/plan` Milestone 2 once the spike table in `MOBILE_DECISIONS.md` is filled.
