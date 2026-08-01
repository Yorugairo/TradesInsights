# Plan: Mobile M0+M1 — offline spike, decision record, installable shell + digest home

> Source PRD: `.claude/prds/trades-insights-mobile.prd.md` · Design spec:
> `docs/design/MOBILE_SHELL_SPEC.md`. This PRP covers **Milestone 0 (decisions +
> offline spike) and Milestone 1 (mobile shell + digest home)** and deliberately
> stops there: Milestone 2's full field app (photos, offline brief, CO decisions)
> depends on what the M0 spike measures on a real device, and a plan whose tasks
> hinge on an unanswered experiment fails the "no questions during
> implementation" rule. M2 gets its own PRP fed by this one's spike results.

## Summary

Make Insights installable on a phone, make the digest readable there, and prove
— on the real field surface, against the real endpoint — that a crew entry
captured offline reaches the server exactly once after reconnect. The spike is
built as **progressive enhancement on the existing `/field/[token]` page**, not a
throwaway route: that page is deliberately zero-JS plain-HTML forms, so the
offline layer can only ADD behavior and can never break the working path.

## User Story

As an owner-estimator, I want Insights installed on my phone opening to my
week's digest — and as a field lead, I want my daily log to save even with no
signal, so that nothing I type in a basement is lost.

## Problem → Solution

`apps/web` is a desktop cockpit with no manifest, no service worker, no offline
path; digests render as a table of delivery rows with no readable content page.
→ Installable PWA; digest content readable on the phone; field entries queue in
an IndexedDB outbox and replay idempotently; every open decision written down in
one decision record.

## Metadata

- **Complexity**: Large (~14 files, 1 additive migration, 10 tasks)
- **Repo**: TradesInsights (**pnpm**), branch `claude/tmux-install-320aiz` (the
  default branch — schedules fire from it; do not create a side branch)
- **DB caution**: `DATABASE_URL` in `apps/web/.env` / worker env points at
  **hosted production** (`arbmeioglflvzoffgtii`, schema `insights`). Migration
  0042 is additive-only. e2e uses the `otn_e2e` sandbox via
  `apps/web/e2e/global-setup.ts`, which migrates itself.

---

## GROUND TRUTH — verified in-repo 2026-07-31

1. **The field page is zero-JS by design.** Its own header:
   *"Plain HTML forms POSTing to /api/field/{token}/entries — works on any phone
   with zero client JS, which is the entire point of the surface."* The offline
   layer must be progressive enhancement; the no-JS path must keep working
   byte-for-byte.
2. **The entries endpoint already accepts JSON** (`api/field/[token]/entries/route.ts`:
   *"The crew page posts plain HTML forms; JSON is accepted for tests/tools"*) —
   an outbox replayer needs no new API, only idempotency (it has none today).
3. **`addFieldEntry` has NO idempotency key** (`field.ts:160-196` inserts
   unconditionally). Offline replay with retries WILL duplicate without Task 2.
   "Exactly once" in the PRD's acceptance criteria is currently unimplementable.
4. **The endpoint rate-limits at 30 req/min/IP** (`hits` map in the route). A
   replayer flushing a large outbox must go sequentially and stop at the 429,
   resuming later — not blast and lose.
5. **Digest content is already stored**: `deliveries.rendered_content` (text) +
   `metadata_json` (schema.ts:998-1013). The mobile digest home RENDERS stored
   content; it never rebuilds a digest (that is the worker's `digest:run`).
6. **Web pool caps at 2 connections** — the field page comments it and a prior
   session proved `Promise.all` of two page reads starves the app. All new pages
   read sequentially.
7. **No `apps/web/public/`, no manifest, no SW** — shell surface is green-field.
   Root layout already sets `viewport` and dark `data-theme`; a first-paint
   density script pattern exists in `layout.tsx` (do not duplicate it).
8. **e2e**: `apps/web/e2e/*.spec.ts` (`app`, `cockpit-cards`, `field-takeoff`,
   `home`, `perf`, `shell` + `global-setup`). **Existing specs are the safety net
   — never edit one.** New coverage = new spec files. Adding a COLUMN needs no
   wipe-list change; adding a TABLE would (none added here).
9. **Styling**: Tailwind v4 via `@tailwindcss/postcss` + design tokens in
   `apps/web/app/globals.css` (`--canvas #061109`, `--accent #d4af37`, `--ok`,
   `--warn`, `--bad`…). Older pages use inline `React.CSSProperties`; cockpit
   components use tokens. New UI uses tokens; never name the `tailwindcss`
   package in PostCSS config (silent no-styles failure).

---

## UX Design

### Before
```
Owner: desktop cockpit only; digests page = table of delivery rows, no content.
Crew : /field/{token} works online only; offline submit = browser error page,
       typed text LOST.
```

### After
```
Owner: installs "OTN Insights" from the browser menu → opens to /app/digests →
       taps a row → reads the rendered digest. Empty state says so plainly.
Crew : same field page; offline submit → "Saved on this phone — will send when
       you're back in signal" chip; on reconnect entries flush sequentially and
       flip to "✓ sent". Force-quit between capture and sync loses nothing.
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Install | — | manifest + icons; add-to-home-screen | iOS: SW/push only for installed PWAs 16.4+ |
| `/app/digests` | rows only | rows link to `/app/digests/[id]` rendering `rendered_content` | sequential reads (pool=2) |
| Field submit offline | data lost | queued to IndexedDB outbox, replayed | zero-JS path unchanged |
| Field sync state | — | queued / sending / sent / failing — four states, never a spinner | "empty" ≠ "broken": distinguish *nothing to sync* from *sync failing* |

---

## Mandatory Reading

| Priority | File | Why |
|---|---|---|
| P0 | `apps/web/app/field/[token]/page.tsx` | The surface being enhanced; zero-JS contract in its header |
| P0 | `apps/web/app/api/field/[token]/entries/route.ts` | JSON acceptance, rate limiter, neutral-failure hardening to preserve |
| P0 | `packages/intelligence/src/field.ts:160-196` | `addFieldEntry` — Task 2 modifies this exact function |
| P0 | `apps/web/e2e/global-setup.ts` + `field-takeoff.spec.ts` | Sandbox contract + the spec style to mirror (read-only) |
| P1 | `apps/web/lib/queries.ts:602-620` (`listDigests`) | Query + row-mapping pattern for the two new queries |
| P1 | `apps/web/app/app/digests/page.tsx` | Session gate + empty-state pattern |
| P1 | `apps/web/app/layout.tsx` | Viewport/theme; where manifest metadata hooks in |
| P2 | `packages/db/migrations/0041_sso_and_calibration.sql` | Latest migration file conventions |
| P2 | `docs/design/MOBILE_SHELL_SPEC.md` §4 | Offline requirements this plan implements |

## External Documentation (verify-on-device, not assumptions)

| Topic | Key takeaway | GOTCHA |
|---|---|---|
| iOS PWA background sync | **No Background Sync API on iOS.** Replay must trigger on `online`, page load, and `visibilitychange` | A SW `sync` event handler simply never fires on iPhone — code that relies on it looks done and isn't |
| iOS storage eviction | IndexedDB in installed PWAs generally survives, but eviction under storage pressure is real | Call `navigator.storage.persist()`; the SPIKE on a real iPhone is the test, not caniuse |
| Next 15 manifest | `app/manifest.ts` exports `MetadataRoute.Manifest` — no plugin needed | SW must live at `public/sw.js` for root scope; `next-pwa` NOT added (unmaintained fit w/ Next 15, and the SW here is ~40 lines) |

---

## Patterns to Mirror

### QUERY_PATTERN (row-map, snake→camel, LIMIT)
```ts
// SOURCE: apps/web/lib/queries.ts:602-620
export async function listDigests(db: Db, accountProfileId: string): Promise<...> {
  const res = await db.execute(sql`
    SELECT id, delivery_type, period_start, period_end, status, sent_at
    FROM deliveries WHERE account_profile_id = ${accountProfileId}
    ORDER BY period_start DESC LIMIT 100`);
  return (res.rows as Record<string, unknown>[]).map((r) => ({ id: r["id"] as string, ... }));
}
```

### PAGE_AUTH_PATTERN
```ts
// SOURCE: apps/web/app/app/digests/page.tsx
const session = await currentSession();
if (!session?.accountKey) redirect("/login");
const account = await accountByKey(db(), session.accountKey);   // sequential —
const digests = await listDigests(db(), account.id);            // pool caps at 2
```

### TOKEN_ROUTE_HARDENING (preserve exactly)
```ts
// SOURCE: apps/web/app/api/field/[token]/entries/route.ts
const HEADERS = { "cache-control": "no-store, private", "referrer-policy": "no-referrer" } as const;
// per-IP limiter, 30/min; one neutral failure: { error: "link unavailable" }, 404
```

### SERVICE_ERROR_PATTERN
```ts
// SOURCE: packages/intelligence/src/field.ts
throw new FieldError("invalid_entry_type", `unknown entry type ${input.entryType}`);
```

### TEST_STRUCTURE
Vitest colocated (`packages/intelligence/src/field.test.ts`); e2e in
`apps/web/e2e/*.spec.ts` asserting on `data-testid` attributes
(`field-page`, `field-submitted-ok`, `digests-empty`).

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `docs/design/MOBILE_DECISIONS.md` | CREATE | M0 decision record (ADR-style) |
| `packages/db/migrations/0042_field_entry_idempotency.sql` | CREATE | `client_entry_id` + partial unique index |
| `packages/intelligence/src/field.ts` | UPDATE | idempotent `addFieldEntry` |
| `packages/intelligence/src/field.test.ts` | UPDATE | duplicate-replay tests |
| `apps/web/app/api/field/[token]/entries/route.ts` | UPDATE | thread `clientEntryId`; `deduped` response |
| `apps/web/app/manifest.ts` | CREATE | installability |
| `apps/web/public/sw.js` | CREATE | shell cache + field-page offline fallback |
| `apps/web/public/icons/*` (192/512/maskable) | CREATE | manifest icons, token palette |
| `apps/web/app/field/[token]/offline-client.tsx` | CREATE | outbox + replay + status chip (client component, **no db imports**) |
| `apps/web/app/field/[token]/page.tsx` | UPDATE | mount client, register SW, testids |
| `apps/web/lib/queries.ts` | UPDATE | `digestById` query |
| `apps/web/app/app/digests/page.tsx` | UPDATE | rows link to detail |
| `apps/web/app/app/digests/[id]/page.tsx` | CREATE | rendered digest reader |
| `apps/web/e2e/mobile-offline-field.spec.ts` | CREATE | offline round-trip + idempotency |
| `apps/web/e2e/digest-reader.spec.ts` | CREATE | detail render + empty state |
| `.claude/prds/trades-insights-mobile.prd.md` | UPDATE | milestone statuses |

## NOT Building (this PRP)

- Photos, offline brief caching, change-order decisions offline — **M2**, gated
  on this spike's device findings. CO *decisions* stay online-only permanently
  (they are contended writes; `decideChangeOrder`'s 409 guard is the arbiter).
- The `jobs` entity, schedule, cost book, field estimator (M3–M4).
- Bottom-tab nav / owner-shell redesign — M1's outcome is install + read digest;
  existing nav suffices.
- Native builds, push notifications, any caching of session-gated `/app` pages
  in the SW (auth pages stay network-only in v1).
- Any new npm dependency. The outbox is ~60 lines of hand-rolled IndexedDB.

---

## Step-by-Step Tasks

### Task 1: Decision record — `docs/design/MOBILE_DECISIONS.md`
- **ACTION**: Write the M0 decisions as short ADRs with status + rationale.
- **IMPLEMENT**: (1) PWA over native — restate PRD out-of-scope rationale;
  (2) storage = **IndexedDB outbox**, not local replica — field writes are
  append-mostly; revisit only if the spike measures multi-day no-signal;
  (3) conflict policy — entries append (no conflicts); CO decisions online-only;
  (4) sync triggers — `online` + load + `visibilitychange` (**iOS has no
  Background Sync**); (5) idempotency — client-minted UUID `clientEntryId`,
  server partial-unique; (6) what the device spike must answer (persistence
  across force-quit, eviction, `storage.persist()` honored, sunlight-legibility
  of the dark palette).
- **VALIDATE**: every open question in the PRD is either answered here or named
  as spike-measured.

### Task 2: Idempotent `addFieldEntry` (migration 0042 + service)
- **ACTION**: Add `client_entry_id` to `field_entries`; dedupe on replay.
- **IMPLEMENT**:
  ```sql
  -- 0042_field_entry_idempotency.sql
  ALTER TABLE field_entries ADD COLUMN IF NOT EXISTS client_entry_id text;
  CREATE UNIQUE INDEX IF NOT EXISTS field_entries_client_entry_ux
    ON field_entries (client_entry_id) WHERE client_entry_id IS NOT NULL;
  ```
  In `addFieldEntry`: accept optional `clientEntryId`; validate shape (36-char
  UUID) via `FieldError("invalid_value", …)`; INSERT
  `ON CONFLICT (client_entry_id) WHERE client_entry_id IS NOT NULL DO NOTHING`;
  on 0 rows, SELECT the existing id and return `{ id, deduped: true }`.
- **MIRROR**: SERVICE_ERROR_PATTERN; the insert at `field.ts:188-195`.
- **GOTCHA**: partial unique indexes need the WHERE repeated in ON CONFLICT.
  Cockpit-authored entries pass no id — behavior unchanged (`NULLs` don't
  collide). **Never** dedupe on content hash; two identical daily logs on two
  days are both real.
- **VALIDATE**: `pnpm --filter @otn/intelligence test` — new cases: same
  `clientEntryId` twice → one row, second returns `deduped`; two entries without
  ids both insert.

### Task 3: Route threads `clientEntryId`
- **ACTION**: Pass `fields["clientEntryId"]` through; expose dedupe.
- **IMPLEMENT**: JSON + form both already funnel into `fields`; add to the
  `addFieldEntry` call; JSON response gains `deduped`; form redirect unchanged.
- **MIRROR**: TOKEN_ROUTE_HARDENING — no new failure shapes, limiter untouched.
- **GOTCHA**: do NOT bypass the rate limiter for replays; the client respects it
  (Task 5).
- **VALIDATE**: `curl -X POST …/entries -H 'content-type: application/json'`
  twice with one UUID → same id, second `deduped: true`.

### Task 4: Manifest + icons + SW
- **ACTION**: Make the app installable; make `/field/*` reopenable offline.
- **IMPLEMENT**: `app/manifest.ts` (name "OTN Insights", `display:
  "standalone"`, `background_color`/`theme_color` `#061109`, `start_url:
  "/app/digests"`, icons 192/512 + maskable, gold-on-canvas). `public/sw.js`:
  version-stamped cache; **network-first with cache fallback for `GET /field/*`
  only** (so the last-viewed brief reopens in a dead zone); everything else
  pass-through; activate cleans old caches.
- **GOTCHA**: the entries POST is *never* SW-cached — the outbox owns writes.
  Caching a token page conflicts with `no-store` intent: acceptable, documented
  in MOBILE_DECISIONS (the token already gates the content; cache is same-device).
  Bump the SW cache version string on every SW edit or clients keep stale shells.
- **VALIDATE**: Lighthouse installability passes locally; airplane-mode reopen
  of a visited field page renders from cache.

### Task 5: Offline outbox client (`offline-client.tsx`)
- **ACTION**: Progressive enhancement over the existing forms.
- **IMPLEMENT**: `"use client"` component mounted from the field page. Captures
  form `submit`; if offline OR the fetch fails → persist
  `{clientEntryId: crypto.randomUUID(), token, fields, createdAt}` to IndexedDB
  (`otn-field-outbox` store, hand-rolled ~60-line wrapper — no dependency);
  render queue. Replay on `online`/load/`visibilitychange`: **sequential**, JSON
  POSTs, stop-and-hold on 429 (limiter is 30/min) or network failure; remove on
  2xx (deduped counts as success). When online and the queue is empty, forms
  submit natively — zero behavior change. `navigator.storage.persist()` on first
  queue. Registers `/sw.js`.
- **MIRROR**: client/server split per repo rule — **no `@otn/db` or server
  imports in a client component** (a prior session shipped that bug; the module
  graph will pull `pg` into the bundle and fail the build).
- **GOTCHA**: replay must re-check the response for `error: "link unavailable"`
  — a revoked link's queued entries must surface as FAILED (visible, with the
  text preserved on-screen for manual copy), never silently dropped and never
  retried forever.
- **VALIDATE**: e2e in Task 7; manual: devtools offline → submit → entry chips
  "saved on this phone" → online → flips to sent, server has exactly one row.

### Task 6: Digest reader (`/app/digests/[id]`) + row links
- **ACTION**: Make the digest readable — the M1 outcome.
- **IMPLEMENT**: `digestById(db, accountProfileId, id)` in `queries.ts`
  (mirror `listDigests`; **must filter by `account_profile_id`**, not id alone —
  ids are guessable UUIDs across accounts). Page: PAGE_AUTH_PATTERN, sequential
  reads, render `rendered_content` via `dangerouslySetInnerHTML` (our own
  worker-rendered HTML — same trust as the email body; comment this), wrapped in
  a `max-width: 42rem` token-styled article. Not-found → honest "digest not
  found" + link back. Rows on the list page become links; empty state text kept
  verbatim (`digests-empty` testid is load-bearing).
- **GOTCHA**: `rendered_content` is nullable (draft rows) — render the metadata
  header and say "content not rendered for this delivery" rather than an empty
  page.
- **VALIDATE**: e2e Task 7; typecheck.

### Task 7: e2e — new spec files only
- **ACTION**: `mobile-offline-field.spec.ts` + `digest-reader.spec.ts`.
- **IMPLEMENT**: offline spec: mint link via global-setup helpers (mirror
  `field-takeoff.spec.ts` fixtures), `context.setOffline(true)` → submit →
  assert queued testid → `setOffline(false)` → assert sent + **exactly one** row
  (query sandbox DB); replay-twice assertion via direct JSON POST with a fixed
  UUID. Digest spec: seed a delivery row with `rendered_content`, assert render
  + cross-account 404 + empty state on a bare account.
- **GOTCHA**: **do not edit existing specs** (redesign safety net). New
  pursuit-child TABLES would need wipe-list registration — 0042 adds only a
  column, so none.
- **VALIDATE**: `pnpm test:e2e` — existing suites still green at their baseline
  count; new specs pass.

### Task 8: Real-device spike protocol (manual, gates M2)
- **ACTION**: Run the M0 verification bar and record results IN
  `MOBILE_DECISIONS.md`.
- **IMPLEMENT**: on a real iPhone (and one Android): install; open a real field
  link; airplane mode; submit daily log; **force-quit**; reopen (assert queue
  survived); restore signal (assert flush + server row); leave installed 48h and
  re-check persistence; read the dark palette in direct sunlight and record the
  verdict (drives the M2 light-variant decision).
- **GOTCHA**: a simulator or DevTools throttling does not count — the PRD's bar
  is a real phone in a real building.
- **VALIDATE**: results table committed; each PRD "spike-measured" question has
  an answer.

### Task 9: Hosted migrate + PRD/STATUS close-out
- **ACTION**: `pnpm db:migrate` against hosted (0042 is additive; drizzle
  applies by journal timestamp — **never edit 0042 after it lands**, ship 0043).
  PRD milestones 0+1 → status per reality; STATUS.md entry; memory update.
- **VALIDATE**: `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`,
  `pnpm eval:run` byte-identical (nothing here touches scoring, so any drift is
  a red flag, not noise).

### Task 10: (checkpoint) M2 PRP seed
- **ACTION**: Append to MOBILE_DECISIONS a "measured inputs for M2" section —
  outbox vs replica verdict, eviction findings, sunlight verdict — so the M2
  planner starts from data, not archaeology.

---

## Testing Strategy

| Test | Input | Expected | Edge |
|---|---|---|---|
| addFieldEntry same clientEntryId ×2 | one UUID | 1 row; 2nd `deduped` | replay |
| addFieldEntry no id ×2 | two calls | 2 rows | cockpit path unchanged |
| bad clientEntryId shape | `"abc"` | FieldError invalid_value | validation |
| route JSON replay | fixed UUID ×2 | same id both times | exactly-once |
| offline e2e | setOffline→submit→online | 1 server row, sent chip | the spike's CI proxy |
| revoked link replay | revoke, then flush | FAILED state, text preserved | no silent drop |
| digest cross-account | other account's id | not-found | IDOR guard |
| digest null content | draft row | honest placeholder | nullable column |

Edge checklist: [x] empty outbox distinguishable from failing sync · [x] 429
mid-flush holds queue · [x] force-quit durability (manual) · [x] concurrent
double-submit same UUID (unique index is the arbiter).

## Validation Commands

```bash
pnpm typecheck
pnpm --filter @otn/intelligence test
pnpm test
pnpm test:e2e          # existing counts stay at baseline; new specs green
pnpm db:migrate        # 0042 additive
pnpm eval:run          # must stay byte-identical — this plan touches no scoring
```
Manual: Task 8 protocol on real devices.

## Acceptance Criteria
- [ ] Installable on iOS + Android; opens to digests
- [ ] Digest content readable on phone; empty + null-content states honest
- [ ] Offline field entry survives force-quit and lands exactly once
- [ ] Revoked-link queue surfaces as failed, text recoverable, never silent
- [ ] Zero-JS field submit path byte-identical in behavior
- [ ] No existing e2e spec edited; all baselines green
- [ ] Decision record answers or assigns every PRD open question

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| iOS evicts IndexedDB before sync | Med | Data loss — the one unforgivable | `storage.persist()` + 48h spike measurement before M2 builds on it |
| SW caches a stale shell forever | Med | Confusing | versioned cache + activate cleanup |
| Replay trips the 30/min limiter | Low | Stalled queue | sequential + stop-on-429 |
| Digest reader leaks cross-account | Low | High | query filters on account_profile_id; e2e asserts 404 |
| Drizzle journal trap | Known | Silent no-op | never edit applied 0042; ship 0043 |

## Notes

Confidence: **8/10**. The two genuinely new muscles are the SW and the outbox —
both small, dependency-free, and covered by an e2e proxy plus a written
real-device protocol. Everything else mirrors patterns quoted above from the
files they live in.
