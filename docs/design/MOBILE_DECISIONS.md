# Mobile decision record (Milestone 0)

Short ADRs for the mobile app. Each is a decision that propagates into every
later milestone, so each records the *reason*, not just the choice. Where the
honest answer is "a device measures this", the decision says so and names the
experiment rather than guessing.

Companion: `docs/design/MOBILE_SHELL_SPEC.md` (the how),
`.claude/prds/trades-insights-mobile.prd.md` (the what/why).

---

## ADR-1 — Installable web app, not native

**Status:** accepted (owner, 2026-07-31)

A web-installable app reaches iOS and Android from the deployment that already
exists, reuses `apps/web` wholesale, and needs no store review to ship a fix.
Native buys background sync, richer camera control and store presence — none of
which the MVP's hypothesis depends on.

**Revisit if** the ADR-4 measurements show sync cannot be made reliable inside
web constraints, or camera quality blocks the field estimator (M4).

---

## ADR-2 — Outbox queue, not a local replica

**Status:** accepted, pending ADR-6 measurement

Field writes are **append-mostly**: a daily log, a change order, a note. They do
not read much and they do not edit prior rows. That shape suits an outbox — a
durable queue of pending writes — rather than a full local mirror of the
account's data, which would drag in sync of opportunities, orgs and pursuits
that nobody needs on a job site.

The read side gets a much cheaper treatment: the service worker caches the
**last-viewed field page** so a crew who loaded the brief in the parking lot can
still see it in the basement.

**Revisit if** ADR-6 measures multi-day disconnection, which would make a
read-only cache of one page insufficient.

---

## ADR-3 — Idempotency is client-minted, server-enforced

**Status:** accepted

`addFieldEntry` inserted unconditionally, with no idempotency of any kind. Any
retrying replayer duplicates rows, so "exactly once" was **unimplementable as
specified** in the PRD.

The client mints a UUID per queued entry (`clientEntryId`) and reuses it across
every retry. The server enforces it with a partial unique index and returns the
existing row on conflict. Client-minted because the client is the only party
that knows two POSTs are the *same intent* — a server-side dedupe would have to
guess from content, and two identical daily logs on two days are both real.

Cockpit-authored entries send no id and are unaffected (`NULL`s do not collide
in a partial unique index).

**Migration:** `0042_field_entry_idempotency.sql` — additive column + partial
unique index.

---

## ADR-4 — Sync triggers: `online`, page load, `visibilitychange`

**Status:** accepted

**iOS has no Background Sync API.** A service-worker `sync` handler is valid
code that simply never fires on iPhone — it would look implemented and do
nothing. Replay is therefore driven from the page: on `online`, on load, and on
`visibilitychange` (returning to the app is the most reliable "the user is here
and probably has signal" signal available).

Replay is **sequential and polite**: the entries endpoint rate-limits at 30
requests/minute/IP, so a large queue flushed in parallel would trip its own
limiter. On 429 or network failure the queue holds and retries at the next
trigger.

---

## ADR-5 — Conflict policy

**Status:** accepted

| Write | Conflict risk | Policy |
|---|---|---|
| `daily_log`, `note` | None — append-only | Queue and replay |
| `change_order` (raise) | None — append-only | Queue and replay |
| `change_order` (approve/reject) | **Real** — two people can decide the same CO | **Online only.** Never queued |

Approving a change order is money changing hands. `decideChangeOrder` already
guards on `status='submitted'` so a second decision cannot land, and the route
returns 409. Queuing decisions offline would mean someone approves on a phone,
someone else rejects in the cockpit, and the queue silently applies the loser
hours later. Decisions stay online; the affordance is disabled with an honest
reason when offline.

---

## ADR-6 — What the device spike must measure

**Status:** open — gates Milestone 2

A simulator cannot answer any of these. The protocol runs on a real iPhone and a
real Android, in a real building.

| Question | Why it changes the design | Result |
|---|---|---|
| Does the outbox survive force-quit between capture and sync? | If not, the whole approach fails | _pending_ |
| Does IndexedDB survive 48h + storage pressure in an installed PWA? | Decides whether an entry can wait a weekend | _pending_ |
| Is `navigator.storage.persist()` granted? | Ungranted means eviction is possible | _pending_ |
| How long are crews actually without signal? | Confirms or overturns ADR-2 | _pending_ |
| Is the dark cockpit palette legible in direct sunlight? | Decides whether the field shell needs a light variant | _pending_ |

**Bar:** capture → airplane mode → force-quit → reopen → reconnect → verify
server state, on a real phone. DevTools throttling does not count.

---

## ADR-7 — Service worker scope is deliberately small

**Status:** accepted

The SW caches the app shell and does **network-first with cache fallback for
`GET /field/*` only**. It never caches session-gated `/app/*` pages (stale
account data is worse than a network error) and never intercepts the entries
POST — the outbox owns writes, and a SW that also queued them would give two
mechanisms one job.

Caching a token-gated page conflicts with the route's `no-store` intent. That is
accepted knowingly: the token already gates the content, and the cache is on the
same device as the person who legitimately opened it. Recorded here so the next
reader sees a decision rather than an oversight.

The cache name carries a version string. **Bump it on every SW edit** or clients
keep serving the old shell.

---

## ADR-8 — Progressive enhancement, never replacement

**Status:** accepted

`/field/[token]` is plain HTML forms with zero client JS, and its own header
says that is "the entire point of the surface" — it works on any phone, any
browser, any age of device a crew actually carries.

The offline layer is therefore **additive**: when online with an empty queue,
forms submit natively exactly as before. The client intercepts only to *rescue* a
submission that would otherwise be lost. If the JS fails to load, the page keeps
working as it does today.

---

## Measured inputs for Milestone 2

Recorded as they are learned, so the M2 plan starts from data rather than
archaeology.

**Known now (2026-07-31, from building M0/M1):**

- **`preventDefault()` must be synchronous.** The first offline client awaited an
  IndexedDB read before calling it, so the browser had already submitted and the
  call did nothing — offline, that meant a network error page and the crew's
  typed text gone. The e2e offline test caught it. Any future interception
  (photos, CO drafts) must capture `FormData` and cancel the event *before* the
  first `await`.
- **Idempotency is live and verified end-to-end.** Replaying one `clientEntryId`
  returns the original id with `deduped: true` and HTTP 200; a fresh key returns
  201. Verified against a real database, not a stub.
- **Change-order notification must not re-fire on replay.** The route now skips
  `sendFieldChangeOrderNotification` when `deduped` is true; without that, an
  outbox retrying through a lost response would page the owner repeatedly for
  one change order.
- **The queue must not invert ordering.** When a backlog exists, even an online
  submit is queued rather than sent natively, or a later entry could land before
  an earlier one.

**Still to measure on a real device (ADR-6 table above):** persistence across
force-quit, 48h eviction, `storage.persist()` grant, real no-signal durations,
sunlight legibility. **M2 should not be planned until these have answers** — the
outbox-vs-replica choice and the field shell's palette both hang on them.

## ADR-9 — Digest is rendered, never rebuilt, on the client

**Status:** accepted

`deliveries.rendered_content` already holds the HTML the worker produced for the
email. The mobile digest reader renders that stored content. It does not call
`buildDigest()` — a phone rebuilding a digest could show a different week than
the email the owner received, and the whole value of a digest is that it is a
fixed statement about a period.

Nullable `rendered_content` (draft deliveries) renders the metadata header and
says the content was not rendered, rather than an empty page.
