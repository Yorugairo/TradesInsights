# Plan: durability pass — surviving Supavisor connection drops

> Evidence gathered 2026-07-27 from THREE live failures the same day, plus a
> codebase search for the same exposure. Every claim below is a file:line or a
> production observation, not a hypothesis.

## Summary

Processes holding a database connection across minutes die mid-run against the
Supavisor pooler and leave **partial state that looks complete**. It happened three
times on 2026-07-27, in three unrelated subsystems, from two different causes (an
idle socket reaped by the pooler, and a local DNS blip). The fix already exists inside
this repo — in a script nobody back-ported — and the shared pool factory is missing
every setting that prevents it.

This is a three-layer pass: **prevent** at the pool, **recover** at the boundary,
**detect** what already broke.

## User story

As the operator, I want a nightly chain and a source sweep that either complete or
fail loudly, so that I never again find production on a mix of algorithm versions
or a source stuck at `status='running'` while the dashboard reads healthy.

## Metadata
- **Complexity**: Medium
- **Source PRD**: N/A (arose from the 2026-07-27 refresh)
- **Estimated files**: 6–8

---

## GROUND TRUTH

### Three confirmed failures, same day, unrelated subsystems

**1. `scoreAll` — v1.12.0 rescore.** Died at row ~31 of ~1,260 with
`Connection terminated unexpectedly`. The loop has no resume, so production sat on a
**MIX of algorithm versions** — strictly worse than either the old or new model,
because half the list was ranked by rules the other half was not. Fixed same day
(`94edc26`) with a local retry helper.

**2. `thurston_active_notices` — source sweep.** Reported as a failed source. It was
not: the adapter discovered 1, fetched 1 and **parsed 1 cleanly**. What died was the
`update source_runs` write, with `AggregateError [ETIMEDOUT]`. The fetch succeeded
and the ledger recorded failure.

Both are the same fault: a pooled connection that has gone away between uses.

**3. The Google Place fleet — six of seven workers, simultaneously.** Observed while
this plan was being written (02:53–02:55 UTC):

```
{"event":"crashed","error":"getaddrinfo ENOTFOUND aws-1-us-west-2.pooler.supabase.com"}
```

A local DNS blip, cleared within minutes (`nslookup` resolves, `select 1` answers). It
is worth recording for three reasons:

- It is the **same failure family** — a transient connection fault — arriving through a
  different door (name resolution rather than an idle socket). `ENOTFOUND` is already
  in the `isTransientConnectionError` regex; the driver simply has no retry to use it.
- The driver **crashes the whole worker** on it, discarding an in-flight batch, when
  the correct response is to back off and re-resolve. Its own pool config is the best
  in either repo; its *error handling* is the weakest.
- It proves the class is not specific to long serial loops. Any process holding a
  database connection across minutes is exposed, including ones that are otherwise
  well engineered.

The watchdog did its job — 11 relaunches logged — but a relaunch loses the batch and
resets the log. Recovery is not the same as durability.

**Three unrelated subsystems, one day, one root cause.** That is the argument for
fixing this at the shared layer rather than per incident.

### The collateral: orphaned `running` rows

`bellevue_permits_arcgis` is **still `status='running'`** with `metrics_json = NULL`,
from a run that ended over an hour ago. Same for the class of crash above. Nothing
reaps these, and `evaluateSourceHealth` has no notion of "a run that never ended", so
a stuck row is invisible.

### The fix already exists here — and was never shared

`OneTradeNetwork/apps/registry/scripts/scrape-google-place-batches.mjs:78-84`:

```js
{ max: 1, idleTimeoutMillis: 10_000, keepAlive: true, connectionTimeoutMillis: 30_000 }
```

with a comment that diagnoses precisely today's failures:

> *"Supabase's pooler reaps idle connections, and the first query after the scrape
> then dies with 'Connection terminated unexpectedly' — which is exactly how three of
> four workers crashed on their first batch. `idleTimeoutMillis` well below the
> pooler's own reaper means node closes idle connections FIRST and opens a fresh one
> on demand, so a dead socket is never handed back."*

The shared factory, `packages/db/src/client.ts:17-20`, has **none of it**:

```ts
export function createPool(databaseUrl = process.env.DATABASE_URL): pg.Pool {
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
}
```

Every consumer inherits that: web pool, worker pool, pg-boss, the drizzle migrator,
vitest, and every CLI. **One change fixes the whole surface.**

### Exposure inventory

Long serial paths doing a round trip per iteration, ranked by blast radius:

| Path | Iterations | Consequence of a mid-loop drop |
|---|---|---|
| `packages/source-sdk/src/runner.ts:310` | per record | **Confirmed today.** Orphaned run row; source reads failed |
| `packages/intelligence/src/score-run.ts:525` | ~9,135 | **Confirmed.** Mixed algorithm versions. *Already fixed* |
| `packages/resolution/src/geocode.ts:169-181` | 500/night | Partial geocode; silently fewer coordinates |
| `packages/resolution/src/velocity.ts:120-128` | per development | Partial velocity events |
| `packages/resolution/src/resolver.ts:215-237` | per record | Partial resolution; records left unresolved |
| `packages/resolution/src/registry-observations.ts` | per observation | Partial export to the registry seam |

`runner.ts` is first because it is the only one with a confirmed failure that is
still unfixed, and because it corrupts the *evidence ledger* rather than a
derived value.

---

## Strategic design

### Approach: three layers, in this order

**1. PREVENT (pool config).** Back-port the proven settings into `createPool`. Cheapest,
broadest, and it removes most of the events rather than surviving them. Do this first
so the later layers are a genuine safety net rather than the primary mechanism.

**2. RECOVER (shared retry).** `withConnectionRetry` currently lives privately in
`score-run.ts:459`. Promote it into `@otn/db` and apply it at the boundaries above.

**3. DETECT (reap + surface).** A run row that never reached a terminal state is a
first-class health signal, not litter.

### Alternatives rejected

- **Retry everywhere, no pool fix.** Treats the symptom; leaves every future call site
  exposed and depends on authors remembering. The pool fix is one line per setting.
- **Wrap the drizzle client so all queries retry transparently.** Tempting, and wrong:
  a retry is only safe when the statement is idempotent. `upsertOpportunity` is a
  single `ON CONFLICT` statement and safe; a mid-transaction retry is not. Retry must
  stay an explicit, per-call-site decision.
- **Raise `max`.** More connections do not help; the connections are dying while idle,
  not queueing.

### NOT building

- Resume/checkpointing for `scoreAll` (real, but a bigger design — the pool fix plus
  retry removes the observed failure)
- Any change to pg-boss's own retry semantics
- Migrating off the pooler to a direct connection (Supabase direct is IPv6-only here)
- Batching the score upserts into multi-row statements (worth doing, separate concern)

---

## Patterns to mirror

### CONNECTION_RETRY — the existing, working shape
```ts
// SOURCE: packages/intelligence/src/score-run.ts:449-478
function isTransientConnectionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /Connection terminated/i.test(msg) ||
    /server closed the connection/i.test(msg) ||
    /Client has encountered a connection error/i.test(msg) ||
    /ECONNRESET|EPIPE|ETIMEDOUT|ENOTFOUND/i.test(msg)
  );
}
// 5 attempts, backoff 0.5/1/2/4s, non-transient errors rethrow immediately.
```
**Note the gap this pass must close:** today's thurston failure surfaced as
`AggregateError [ETIMEDOUT]` — the `ETIMEDOUT` substring matches, but only because
the message happens to contain it. Match on `err.code` as well as the message.

### VISIBLE_SKIP — degrade without losing the run
```ts
// SOURCE: apps/worker/src/schedules.ts (alerts step, 2026-07-27)
// A late, non-essential step must not discard a chain that already committed.
```

### POOL_CONFIG — the proven values
```js
// SOURCE: OneTradeNetwork/apps/registry/scripts/scrape-google-place-batches.mjs:78-84
{ max: 1, idleTimeoutMillis: 10_000, keepAlive: true, connectionTimeoutMillis: 30_000 }
```
`max: 1` is specific to that single-shard driver; the shared pool keeps its own `max`.

---

## Step-by-step tasks

### Task 1 — harden `createPool` *(do first; highest leverage)*
- **ACTION**: Add `keepAlive`, `idleTimeoutMillis`, `connectionTimeoutMillis` to
  `packages/db/src/client.ts:17`.
- **IMPLEMENT**: `idleTimeoutMillis: 10_000` (below Supavisor's reaper so node closes
  first and never hands back a dead socket), `keepAlive: true`,
  `connectionTimeoutMillis: 30_000`. Keep `max: 10`.
- **MIRROR**: POOL_CONFIG above — carry the *reasoning* comment across, not just the
  numbers, so the next person does not strip them as noise.
- **GOTCHA**: `createRegistryPool` (same file, `max: 4`) has the identical exposure and
  is easy to miss.
- **GOTCHA**: Do NOT lower `max` — the failure is idle-death, not contention.
- **VALIDATE**: `pnpm vitest run` (1067 tests) — pool changes are invisible to
  behaviour, so any failure is a real regression. Then `pnpm cycle:run --only=wa_sepa`
  end to end.

### Task 2 — promote `withConnectionRetry` into `@otn/db`
- **ACTION**: Move `isTransientConnectionError` + `withConnectionRetry` from
  `score-run.ts:449-478` into `packages/db/src/retry.ts`, export from the package
  index; re-point `score-run.ts` at the shared copy.
- **IMPLEMENT**: Add `err.code` matching alongside the message regex, and unwrap
  `AggregateError.errors[]` — today's real failure was an AggregateError whose
  *message* was empty and whose cause carried `ETIMEDOUT`.
- **GOTCHA**: Retry is only sound for a single idempotent statement. Document that on
  the export and do not wrap multi-statement transactions.
- **VALIDATE**: New unit tests — a transient error retries and eventually succeeds; a
  constraint violation rethrows immediately with no delay; an `AggregateError`
  wrapping `ETIMEDOUT` is recognised.

### Task 3 — apply retry in `runner.ts` *(the only confirmed-unfixed path)*
- **ACTION**: Wrap the per-record persistence and the terminal `source_runs` update in
  `packages/source-sdk/src/runner.ts` (~line 310 and ~360).
- **GOTCHA**: The terminal update is the one that matters most — that is what left
  bellevue orphaned. Wrap it even though it sits in a `finally`-style path.
- **VALIDATE**: `pnpm vitest run packages/source-sdk`; then re-run
  `thurston_active_notices`, which failed today, and confirm it reaches a terminal
  status.

### Task 4 — reap and surface orphaned runs
- **ACTION**: Treat a `source_runs` row in `running` older than a threshold as failed,
  and make it a health signal.
- **IMPLEMENT**: A maintenance-chain step that marks such rows
  `completed_with_errors` with an explicit `orphaned_no_terminal_write` reason; extend
  `evaluateSourceHealth` (`packages/source-sdk/src/health.ts:61`) to report amber.
- **GOTCHA**: The threshold must exceed the slowest legitimate run. `king_permit_reports`
  parsed 3,082 records in one run — measure before picking a number; do not guess.
- **GOTCHA**: Clean up **bellevue's existing stuck row** as part of this, and say so.
- **VALIDATE**: Insert a synthetic old `running` row in the test DB; assert it is
  reaped and that health goes amber.

### Task 5 — apply retry to the remaining chain steps
- **ACTION**: `geocode.ts`, `velocity.ts`, `resolver.ts`, `registry-observations.ts`.
- **GOTCHA**: Each is a *different* idempotency story. `geocode` upserts by project id
  (safe). `resolver` inserts `projectEvents` (check for a natural key before retrying,
  or a retry duplicates events). Verify per call site — do not pattern-match.
- **VALIDATE**: Full suite plus a live `pnpm cycle:run --skip-sources`.

### Task 6 — harden the Google Place driver *(different repo: OneTradeNetwork)*
- **ACTION**: Make `scrape-google-place-batches.mjs` survive a transient DNS/connection
  fault instead of crashing the worker.
- **IMPLEMENT**: Wrap `claimBatch` and the result-write in the same bounded retry. On
  exhaustion, exit non-zero as today so the watchdog still relaunches — retry is an
  addition to the safety net, not a replacement for it.
- **GOTCHA**: This file lives in the **OneTradeNetwork** tree, and a diverged near-copy
  exists in the `trades-google-place-integration-v2` worktree. Fix the one the watchdog
  actually launches (`-RepoRoot C:\Users\Snipe\Downloads\OneTradeNetwork`) and note the
  other, or the fix appears to do nothing.
- **GOTCHA**: Do NOT retry past the `STOP-do-not-relaunch` semantics — a Google block
  must still stop the run hard. Only connection faults retry.
- **VALIDATE**: Point `DATABASE_URL` at an unresolvable host, confirm the worker retries
  and backs off rather than exiting immediately; restore and confirm a batch completes.

### Task 7 — close-out
Full suite, `pnpm eval:run` gates, commit, update `docs/STATUS.md`, plan history.

---

## Testing strategy

| Test | Input | Expected | Edge? |
|---|---|---|---|
| transient retries | throws `Connection terminated`, then succeeds | resolves, 1 retry logged | |
| AggregateError unwrap | `AggregateError` wrapping `ETIMEDOUT` | recognised as transient | ✅ today's real shape |
| non-transient rethrows | unique-violation | throws immediately, no delay | ✅ |
| attempt cap | always throws transient | throws after 5, does not hang | ✅ |
| orphan reaper | `running` row older than threshold | marked errored, health amber | ✅ |
| live run reaches terminal | re-run thurston | `succeeded`, metrics non-null | |

---

## Validation commands

```bash
pnpm vitest run
```
EXPECT: 1067+ passing (Docker up — `pnpm infra:up`)

```bash
pnpm eval:run
```
EXPECT: GATES PASS, byte-identical

```bash
pnpm cycle:run --only=thurston_active_notices --sources-only
```
EXPECT: terminal status, metrics non-null — the exact failure reproduced green

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Retrying a non-idempotent write duplicates rows | Medium | **High — silent** | Task 5 verifies each call site individually; `projectEvents` called out |
| Orphan threshold too low, kills a legitimate long run | Medium | High | Measure the slowest real run first; 3,082-record precedent noted |
| Pool settings mask a genuine outage as a slow hang | Low | Medium | `connectionTimeoutMillis: 30_000` bounds it |
| Retry hides a systemic problem behind latency | Medium | Medium | Every retry logs; the pool fix is the primary mechanism |

## Notes

The knowledge to prevent both of today's failures already existed **in this codebase**,
written by the person who debugged it the first time — in a standalone script's pool
config, where nothing else could inherit it. The durable output of this pass is not the
retry helper; it is that the shared factory carries the lesson.

## Plan history

**2026-07-27 — v1.** Written after THREE same-day production failures (`scoreAll` mid-loop,
`thurston_active_notices` terminal write) and a search that found six more exposed paths
plus a bare shared pool factory.
