# Plan: Windowed peer selection for gym_market_comparators

> **STATUS 2026-07-28 (v2) — COMPLETE. ARCHIVED.** The 2026-07-28 v1 banner said "task 5 NOT STARTED" and was WRONG; it read the report and ignored this plan's own inline markers plus work that shipped in the REGISTRY repo. Verified: Task 5a `c1b13646` (cherry-pick of registry `88669d94`) on `origin/release/trades-staging`; **Task 5b shipped as `scripts/refresh-registry-source-mvs.mjs`, commit `d7d3696f` (2026-07-27) on `origin/release/staging`** — *"refresh the source materialized views one statement at a time"*, citing the same 2D000 constraint this plan flagged; Task 6 marked SHIPPED 2026-07-25. All three declared artifacts exist on trades-staging, including migration `20260728020000_gym_market_comparator_windowed_peers.sql`.

## Summary

`registry_gym_market_comparators_v1` picks peer gyms with a correlated LATERAL that
rescans the entire 75,901-row `gym_base` CTE **once per gym** — 5.76 billion row visits,
total planner cost 172,969,298. It is the only source MV that does not complete; the
other nine refresh in 302 seconds combined. This replaces the per-gym rescan with a
bounded windowed pre-pass, turning O(n²) into O(n log n).

This supersedes Task 2 of `trades-read-model-verticalization.plan.md`, which proposed
converting the MV to an incrementally maintained table. That would have carried the
quadratic build into the delta path and inherited it on every bulk-ingest day.

## User Story

As the operator, I want the market-comparator model to rebuild in bounded time, so that
all 75,901 contractors get comparison panels and the weekly refresh can be re-enabled.

## Problem → Solution

| Current | Desired |
|---|---|
| Per-gym LATERAL rescans all 75,901 gyms; never finishes | One windowed pass, bounded join; completes in minutes |
| 24 peers computed per gym, 6 kept — 75% waste | 6 computed, 6 kept |
| MV stale at 26,934 while 9 siblings hold 75,901 | Full parity at 75,901 |

## Metadata
- **Complexity**: Medium
- **Supersedes**: Task 2 of `trades-read-model-verticalization.plan.md`
- **Skeleton change**: NO for the rewrite (skin). YES, separately, for Task 5 (correctness).
- **Estimated files**: 3

---

## Measured evidence (2026-07-25 — verify, do NOT re-derive)

Per-MV probe run `b8f4efd8-e776-4380-bfce-24e071a577a0`, telemetry in
`registry_internal.registry_source_mv_refresh_probe`:

| # | MV | sec | spill MB | rows |
|---|---|---:|---:|---|
| 1 | gym_profile_metrics | 16.9 | 255 | 26,934 → 75,901 |
| 2–7 | (analytics, labels, overlays, tags, directory, market) | 48.1 | 331 | all grew |
| 8 | region_comparators | 55.0 | 280 | 3,108 → 5,475 |
| 9 | program_region_comparators | 181.7 | 344 | 10,890 → 14,515 |
| 10 | **gym_market_comparators** | **1200.2 ✗ 57014** | 332 | unchanged |

- Nine of ten complete in **302s**. The tenth is 80% of runtime and never finishes.
- **Not disk.** No MV spilled over 344 MB; database peaked at 2,543 MB. The earlier
  ">1.65 GB" figure was a cumulative total across all ten mistaken for a single-MV
  measurement.
- **Not CONCURRENTLY.** `EXPLAIN ANALYZE` of the defining query **alone** timed out at
  25 minutes, before any diff cost. Dropping CONCURRENTLY does not rescue it.
- **Not the comparator caps.** The 2026-07-25 peer-tail cap appears as `SubPlan 3` at
  cost **1.34**, three orders of magnitude below the quadratic join.

### The plan node that costs everything

```
Nested Loop Left Join  (cost=24097.94..172969298.48 rows=75901 width=312)
  CTE gym_base -> Seq Scan on registry_gym_profile_metrics_v1 (rows=75901) Filter: is_published
  ->  Aggregate  (cost=2277.10..2277.11 rows=1)              <- once per gym
        ->  Sort  Sort Key: CASE city/county tier, sponsor_sort DESC, rating DESC, gym_name
              ->  Limit
                    ->  Sort
                          ->  CTE Scan on gym_base p_1  (cost=0.00..2277.03)
```

2,277 × 75,901 ≈ 172.8M — essentially the whole plan. At 26,934 gyms it was 725M row
visits; at 75,901 it is 5.76B. **A 2.8× row increase produced 8× the work.**

---

## The exact current semantics (captured from `pg_get_viewdef`, line 131 / 88 / 79)

Peer filter and ordering:

```sql
WHERE p_1.tenant_id <> g.tenant_id
  AND p_1.state_code = g.state_code
  AND ( (g.city_token   IS NOT NULL AND p_1.city_token   = g.city_token)
     OR (g.county_token IS NOT NULL AND p_1.county_token = g.county_token)
     OR (g.city_token IS NULL AND g.county_token IS NULL) )
ORDER BY (CASE WHEN g.city_token   IS NOT NULL AND p_1.city_token   = g.city_token   THEN 0
               WHEN g.county_token IS NOT NULL AND p_1.county_token = g.county_token THEN 1
               ELSE 2 END),
         p_1.sponsor_sort DESC, p_1.rating DESC NULLS LAST, p_1.gym_name
LIMIT 24
```

Outer cap (applied 2026-07-25) keeps only the first 6:

```sql
|| COALESCE(( SELECT jsonb_agg(t.e ORDER BY t.ord)
                FROM jsonb_array_elements(peer_options.options) WITH ORDINALITY t(e, ord)
               WHERE t.ord <= 6), '[]'::jsonb) AS compare_options
```

**Tier 2 is unreachable unless both tokens are NULL.** If `city_token` is present, the
filter admits only city-matches and county-matches, so the ELSE branch never fires. Three
disjoint cases:

| Gym | Candidate set | Tiers used |
|---|---|---|
| has city and/or county | same city ∪ same county | 0, 1 |
| both tokens NULL | whole state | 2 only |

---

## Design: bounded pre-pass, then a plain join

Rank once per bucket, keep 7 per bucket, join, dedupe, rank, take 6.

```sql
, gym_ranked AS (
    SELECT b.*,
      row_number() OVER (PARTITION BY b.state_code, b.city_token
        ORDER BY b.sponsor_sort DESC, b.rating DESC NULLS LAST, b.gym_name) AS city_rank,
      row_number() OVER (PARTITION BY b.state_code, b.county_token
        ORDER BY b.sponsor_sort DESC, b.rating DESC NULLS LAST, b.gym_name) AS county_rank,
      row_number() OVER (PARTITION BY b.state_code
        ORDER BY b.sponsor_sort DESC, b.rating DESC NULLS LAST, b.gym_name) AS state_rank
    FROM gym_base b
  )
, peer_pool AS (
    SELECT state_code, city_token AS bucket_key, 'city'::text AS bucket, 0 AS tier,
           tenant_id, gym_name, slug, data, sponsor_sort, rating
      FROM gym_ranked WHERE city_token IS NOT NULL AND city_rank <= 7
    UNION ALL
    SELECT state_code, county_token, 'county', 1,
           tenant_id, gym_name, slug, data, sponsor_sort, rating
      FROM gym_ranked WHERE county_token IS NOT NULL AND county_rank <= 7
    UNION ALL
    SELECT state_code, NULL, 'state', 2,
           tenant_id, gym_name, slug, data, sponsor_sort, rating
      FROM gym_ranked WHERE state_rank <= 7
  )
, peer_matched AS (
    SELECT DISTINCT ON (g.tenant_id, c.tenant_id)
           g.tenant_id AS gym_tenant_id,
           c.tenant_id AS peer_tenant_id,
           c.gym_name, c.slug, c.data, c.sponsor_sort, c.rating, c.tier
      FROM gym_base g
      JOIN peer_pool c
        ON c.state_code = g.state_code
       AND c.tenant_id <> g.tenant_id
       AND ( (c.bucket = 'city'   AND g.city_token   IS NOT NULL AND c.bucket_key = g.city_token)
          OR (c.bucket = 'county' AND g.county_token IS NOT NULL AND c.bucket_key = g.county_token)
          OR (c.bucket = 'state'  AND g.city_token IS NULL AND g.county_token IS NULL) )
     ORDER BY g.tenant_id, c.tenant_id, c.tier      -- dedupe keeps the BEST tier
  )
, peer_ranked AS (
    SELECT pm.*, row_number() OVER (PARTITION BY pm.gym_tenant_id
             ORDER BY pm.tier, pm.sponsor_sort DESC, pm.rating DESC NULLS LAST, pm.gym_name) AS ord
      FROM peer_matched pm
  )
, peer_options AS (
    SELECT gym_tenant_id,
           jsonb_agg(jsonb_build_object(
             'key', 'gym:'::text || peer_tenant_id, 'label', gym_name, 'scope', 'gym',
             'href', '/brazilian-jiu-jitsu-gym/'::text || slug,
             'targetTenantId', peer_tenant_id, 'targetSlug', slug, 'data', data
           ) ORDER BY ord) AS options
      FROM peer_ranked WHERE ord <= 6
     GROUP BY gym_tenant_id
  )
```

Outer join becomes `LEFT JOIN peer_options ON peer_options.gym_tenant_id = g.tenant_id`,
and `compare_options` simplifies to `... || COALESCE(peer_options.options, '[]'::jsonb)`.

### Why 7 per bucket is provably sufficient for a final 6

A gym sits in its own bucket, so top-7-minus-self leaves ≥6. Tier 0 entries all sort
before tier 1, so the true top 6 are either wholly within the city bucket's top 7, or are
city peers plus the county bucket's top 7. **This constant is coupled to the outer cap:
if the 6 ever changes to N, the 7 must become N+1.** State-line the coupling in a comment.

### Complexity

Three window functions over 75,901 rows (one sort each), then a hash join producing
≤14 candidate rows per gym (~1.06M total), one dedupe, one window, one GROUP BY.
No per-gym rescan anywhere.

---

## Mandatory Reading

| Priority | File | Why |
|---|---|---|
| P0 | `apps/registry/scripts/cap-region-comparator-peers.mjs` | The pattern: full new definition written out, indexes/grants captured at runtime, one transaction, `SET LOCAL statement_timeout` |
| P0 | `apps/registry/scripts/profile-source-mv-refresh.mjs` | `--explain` gives build cost without locking the MV; `--only=`/`--apply` drive the refresh |
| P1 | `apps/registry/src/lib/gymMarketComparison.ts:6-24` | `ComparisonOption` contract the jsonb must satisfy |
| P1 | `apps/registry/scripts/cap-gym-market-comparator-peers.mjs` | **Do not re-run after this lands** — its anchor disappears |
| P2 | `.claude/PRPs/reports/trades-read-model-verticalization-task1-report.md` | Full Task 1 findings |

---

## Patterns to Mirror

### RUNTIME CAPTURE, NEVER TRANSCRIBE
```js
// SOURCE: cap-region-comparator-peers.mjs:110-119
const def = (await client.query(`SELECT pg_get_viewdef($1::regclass, true) AS d`, [qualified])).rows[0].d;
const idx = (await client.query(
  `SELECT indexdef FROM pg_indexes WHERE schemaname='registry_internal' AND tablename=$1 ORDER BY indexname`, [name])).rows.map(r => r.indexdef);
const grants = (await client.query(
  `SELECT grantee, privilege_type FROM information_schema.role_table_grants
    WHERE table_schema='registry_internal' AND table_name=$1`, [name])).rows;
```

### ONE TRANSACTION, EXPLICIT TIMEOUTS
```js
// SOURCE: cap-region-comparator-peers.mjs:164-176
await client.query('BEGIN');
await client.query(`SET LOCAL statement_timeout = '30min'`);
await client.query(`SET LOCAL lock_timeout = '60s'`);
await client.query(`DROP MATERIALIZED VIEW ${TARGET}`);
await client.query(`CREATE MATERIALIZED VIEW ${TARGET} AS ${newDef}`);
for (const i of idx) await client.query(i);
for (const g of grants) await client.query(`GRANT ${g.privilege_type} ON ${TARGET} TO "${g.grantee}"`);
await client.query('COMMIT');
```

### REFUSE RATHER THAN GUESS
```js
// SOURCE: cap-gym-market-comparator-peers.mjs:63-64
if (!def.includes(ANCHOR)) throw new Error('anchor not found — definition changed, refusing to guess');
if (def.split(ANCHOR).length !== 2) throw new Error('anchor is not unique — refusing to guess');
```

### DRY RUN BY DEFAULT
```js
// SOURCE: cap-region-comparator-peers.mjs:46,155-160
const APPLY = process.argv.includes('--apply');
if (!APPLY) { console.log('\n--- new definition (dry run, nothing changed) ---'); return; }
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `apps/registry/scripts/rewrite-gym-market-comparator-peers.mjs` | CREATE | The rewrite, mirroring the cap-* pattern |
| `apps/registry/scripts/compare-gym-market-peer-equivalence.mjs` | CREATE | Proves old ≡ new on a bounded sample |
| `apps/registry/supabase/migrations/2026072802XXXX_gym_market_comparator_windowed_peers.sql` | CREATE | Records the new definition in the ledger |

## NOT Building

- **Incremental/table conversion of this MV.** Superseded — the build is the cost, and a
  delta path would inherit the quadratic join on every ingest day.
- **Any change to the other nine source MVs.** They complete in 302s combined.
- **Dropping CONCURRENTLY — DECIDED AGAINST 2026-07-25, not merely deferred.**
  Measured as not the cause of the failure, and the system is healthy without it: the
  production function now completes in 545.5s with `failures: []`. Switching this MV to a
  plain refresh would buy ~2.6 GB of spill and ~50s per weekly run — an optimization, not
  a repair.
  It is declined because the refresh function is SHARED SKELETON, so the flip would reach
  BJJ, where it fails the skeleton test outright: BJJ's comparators total ~165 MB (nothing
  to fix), it is a live public directory with real traffic, and `AccessExclusiveLock`
  blocks readers — a user-facing stall with zero compensating benefit. "Better for BJJ as
  well" is false here; it is strictly worse.
  IF it is ever revisited, it must be a per-MV opt-in (e.g. a `plain_refresh_mvs text[]`
  parameter), never a blanket change, so the trades/BJJ distinction cannot be lost by a
  one-line edit. Note also `temp_file_limit = -1` on this instance: there is no per-session
  spill guard, so the only backstop is the physical volume — which is what gave way on
  2026-07-05.
- **Porting anything to BJJ.** At ~4,000 gyms nationally the quadratic join is ~16M row
  visits and finishes fine. Same code, different density.
- **Trades-native pSEO read models** (old plan Task 3) — still pending, unchanged, out of
  scope here.

---

## Step-by-Step Tasks

### Task 1: Capture an equivalence baseline BEFORE changing anything
- **ACTION**: Build `compare-gym-market-peer-equivalence.mjs`. For a sample of gyms, run
  the CURRENT peer LATERAL (scoped to those gyms only) and store `(gym_tenant_id, ordered
  peer tenant_ids)`.
- **IMPLEMENT**: Sample must span the shape space, not just the head — at minimum: 40
  gyms in the densest city bucket, 40 in a mid-size city, 40 in a county-only bucket
  (`city_token IS NULL`), 20 with both tokens NULL, 20 singletons whose bucket has no
  other member. Take the sample deterministically (`ORDER BY tenant_id`), not randomly,
  so re-runs compare like with like.
- **GOTCHA**: The current query cannot run over all 75,901 gyms — that is the whole
  problem. It runs fine for a few hundred because cost is per outer row. Scope with
  `WHERE g.tenant_id = ANY($1)` **inside** the `gym_base`-consuming outer query, NOT by
  wrapping the finished view.
- **GOTCHA**: `sponsor_sort` ties are broken by `gym_name`; two gyms with identical
  name/rating/sponsor_sort make order non-deterministic. Detect and exclude such gyms
  from the strict comparison, and report how many were excluded rather than hiding them.
- **VALIDATE**: script prints N sampled gyms and writes a baseline JSON artifact.

### Task 2: Write the rewrite script
- **ACTION**: Create `rewrite-gym-market-comparator-peers.mjs` producing the new
  definition from the design above.
- **MIRROR**: `cap-region-comparator-peers.mjs` — full new definition written out (it did
  the same for `cappedDef`), indexes/grants captured at runtime, one transaction with
  `SET LOCAL statement_timeout='30min'` and `lock_timeout='60s'`.
- **IMPLEMENT**: Before replacing, assert the captured original still contains the
  quadratic marker (`FROM gym_base p_1`) and the `LIMIT 24`; refuse if absent — that means
  someone already changed it and this rewrite may no longer be equivalent.
- **GOTCHA**: `registry_gym_market_comparators_v1` has **1 unique index and 3 indexes
  total** — all must be recreated, or the next CONCURRENTLY refresh fails with "cannot
  refresh concurrently, create a unique index".
- **GOTCHA**: Preserve every non-peer column and the scoped-region assembly (national,
  parent, city/county/state) byte-for-byte. Only the peer machinery changes.
- **GOTCHA**: The outer `ord <= 6` slice becomes redundant once the CTE limits to 6.
  Removing it is correct, but it deletes the anchor
  `cap-gym-market-comparator-peers.mjs` splices on. That script will then refuse — which
  is the right behaviour. Note it in the header so nobody "fixes" the refusal.
- **VALIDATE**: dry run prints the new definition; `--apply` completes in one transaction.

### Task 3: Prove equivalence, then measure
- **ACTION**: Re-run the Task 1 comparison against the rewritten view and diff.
- **IMPLEMENT**: Compare ordered peer lists per sampled gym. Any difference is a failure
  unless attributable to a declared tie (Task 1).
- **GOTCHA**: Do not accept "same set, different order" — `compare_options` order is what
  the page renders, so order is part of the contract.
- **VALIDATE**: zero unexplained diffs; then
  `node scripts/profile-source-mv-refresh.mjs --explain --only=registry_gym_market_comparators_v1`
  reports a finite build time (target: under 120s, versus >25 min today).

### Task 4: Refresh and verify downstream
- **ACTION**: `node scripts/profile-source-mv-refresh.mjs --apply --only=registry_gym_market_comparators_v1`
- **VALIDATE**: probe row status `success`; MV reaches **75,901 rows** (parity with
  `public.tenants` and `registry_gym_profile_metrics_v1`); a directory page and a profile
  page render with a populated comparison panel for a contractor that previously had none.

### Task 5 (correctness): make the shared refresh tell the truth, and bank partial work

Two edits to `registry_internal.refresh_registry_read_models` /
`refresh_registry_source_materialized_views`. They are grouped because they touch the
same function in the same window, and because doing either alone leaves the other
actively misleading.

**5a — Stop recording failed runs as successes.** — **SHIPPED 2026-07-25** (registry
`88669d94`, cherry-picked to trades-staging as `c1b13646`). Applied by splice via
`scripts/fix-source-mvs-audit-status.mjs`; migration
`20260728030000_source_mvs_audit_status_truth.sql` dumps the patched function verbatim.
- **ACTION**: In the `source_only` branch, derive the audit status from `source_result`
  instead of hardcoding it.
- **WHY**: The branch currently builds its result with a literal `'ok', true` and runs
  `UPDATE ... SET status = 'success'` without consulting `source_result`. Because the
  inner loop catches per-MV errors and continues, the function returns normally and the
  parent row is stamped success no matter what failed. This is not hypothetical: audit
  id 18 (2026-07-05) reads `status = 'success'` at the parent while its phase row is
  `failed` and lists three `No space left on device` errors. A monitored cron that
  reports success while failing is worse than one that reports nothing.
- **GOTCHA**: `source_result->>'ok'` is already correct in the payload — only the parent
  UPDATE and the hardcoded `'ok', true` in the `result` object are wrong. Do not "fix"
  the inner loop's catch-and-continue; partial progress is the desired behaviour.
- **VALIDATE**: force one MV to fail; the parent audit row must read `failed`.

**5b — One transaction per MV.**
- **ACTION**: Make each MV refresh commit independently rather than sharing the caller's
  transaction.
- **WHY**: On 2026-07-25 MV 10's failure discarded the nine successful rebuilds ahead of
  it — which is why `gym_profile_metrics` stayed at 26,934 despite refreshing correctly
  in 17 seconds on both attempts. Driving one transaction per MV is what finally banked
  them.
- **SKELETON JUSTIFICATION**: Passes the bar on correctness, not speed — "a late failure
  should not discard earlier successes" is equally true for BJJ. Implement once in the
  shared function; do NOT fork per vertical.
- **GOTCHA**: The function is `SECURITY DEFINER` and holds an advisory lock
  (`hashtext('registry_source_mv_refresh')`). plpgsql cannot COMMIT inside a function
  invoked via `SELECT`, so this likely means the *caller* drives the loop (as
  `profile-source-mv-refresh.mjs` does) rather than the function committing internally.
  Decide that shape explicitly before writing code.
- **NOTE**: 5b is no longer urgent. With the quadratic fixed, the full run completes in
  545s, so the "one failure discards nine successes" scenario is not currently firing.
  It remains correct to do, and cheap insurance against the next regression.
- **SHAPE DECISION — RESOLVED BY EVIDENCE 2026-07-25. Option 3 is IMPOSSIBLE here.**
  A procedure containing COMMIT cannot be invoked from any context that already owns a
  transaction, and both entry points do:
    * Supavisor pooler -> `2D000 invalid transaction termination`
    * **pg_cron runs each job inside a transaction** -> same error, observed in
      `cron.job_run_details`: `CONTEXT: PL/pgSQL function refresh_registry_source_mvs(text) line 27 at COMMIT`
  A function also cannot CALL such a procedure, and
  `process_registry_read_model_refresh_queue` IS a function — so converting the shared
  entry point would have broken job 3, the daily path. The procedure was built, tested,
  dropped, and its test cron job unscheduled.
  **Therefore per-MV commits must be driven from OUTSIDE the database.** That is now the
  only remaining shape, and it already exists and is proven:
  `scripts/profile-source-mv-refresh.mjs` ran 10/10 MVs in 549s and kept nine successes
  committed when the tenth was forced to fail. The open question is no longer "what
  shape" but "what schedules it" — pg_cron cannot, so job 1 either stays single-transaction
  (fine at 545s today) or moves to an external runner (needed at multi-state scale, where
  retries/backpressure/observability matter anyway). `dblink` remains a third path: it
  would give autonomous transactions from inside pg_cron, at the cost of an extension and
  per-MV connection overhead.
  *Superseded options, kept for provenance:*
  1. *Caller drives the loop* (what `profile-source-mv-refresh.mjs` already does). No DB
     change, but pg_cron would have to call something other than the function, so the
     cron and the manual path diverge — the exact drift this workstream keeps paying for.
  2. *Leave as-is.* Defensible now that a full run takes 545s and the audit no longer
     lies. Costs nothing, banks nothing.
  3. *Convert to a PROCEDURE.* plpgsql PROCEDUREs **can** COMMIT (PG11+), and pg_cron can
     `CALL` them, so this is the only option that puts per-MV commits inside the shared
     path where both verticals get them. But it changes the object type of a shared
     skeleton entry point, which BJJ also calls — so it needs the same "better for BJJ
     too" justification as any skeleton change, plus a check of every caller.
  Evidence for option 3 being genuinely better: on 2026-07-25 audit id 84 refreshed nine
  MVs successfully and, because they shared one transaction, **all nine were rolled back**
  when the tenth failed. That is the cost, measured, in the current design.
- **VALIDATE**: a forced failure on one MV leaves the earlier MVs refreshed and committed.

### Task 6: Re-enable job 1 behind evidence — **SHIPPED 2026-07-25**
Job 1 (`registry-read-model-source-refresh-weekly`, `20 2 * * 0`) is **active** again,
for the first time since 2026-07-05. Evidence that cleared the gate:

| audit | parent status | phase status | run |
|---|---|---|---|
| 82 | `success` | success | genuine full success, 545.4s |
| 84 | **`failed`** | failed | 9 refreshed + 1 forced failure |

Id 84 is the one that matters: before 5a it would have read `success`. The gate now
means something because the function can report both outcomes.

Timing checked: 02:20 Sunday + ~545s finishes ~02:29, clear of job 2 at 02:35. If they
ever did overlap, the advisory lock makes the later one skip rather than collide.

- **ACTION**: Re-enable the weekly `source_mvs` cron.
- **PRECONDITION (new)**: Task 5a must land first. As of 2026-07-25 the gate below is
  satisfiable by a run that FAILED — see 5a. Re-enabling before that fix means the first
  partial failure is written to the audit table as a success and is discovered from stale
  pages instead of from monitoring.
- **GOTCHA**: Do NOT re-enable on the strength of `state:WA` succeeding, or of nine of ten
  MVs succeeding. Both inferences were made in this workstream and both were wrong.
- **STATUS 2026-07-25**: the run evidence now exists — probe harness 10/10 in 549.0s, and
  the production function green in 545.5s with a committed `success` audit row (id 82).
  Job 1 remains paused solely on the 5a precondition.
- **VALIDATE**: all ten probe rows `success` in one run; a committed `source_mvs` audit
  row with status `success` **produced by a function that can also report `failed`**.

---

## Testing Strategy

| Test | Input | Expected | Edge? |
|---|---|---|---|
| Dense city bucket | 40 gyms, largest city | identical ordered peers | no |
| County-only | `city_token IS NULL`, county set | tier-1 peers only | yes |
| Both tokens NULL | state-wide fallback | tier-2 peers, ≤6 | yes |
| Bucket singleton | only gym in its city | falls through to county, or `[]` | yes |
| Self-exclusion | top-ranked gym in its bucket | never contains itself | yes |
| Fewer than 6 peers | sparse bucket | short array, not padded, not null | yes |
| No peers at all | isolated | `'[]'::jsonb`, and page renders | yes |

### Edge Cases Checklist
- [ ] Gym is rank 1 in its own bucket (self-exclusion must not shorten the list to 5)
- [ ] Peer appears in both city and county buckets (dedupe keeps tier 0, not a duplicate)
- [ ] `rating IS NULL` sorts last, matching `NULLS LAST` today
- [ ] `is_published = false` gyms remain excluded (filter lives in `gym_base`)
- [ ] Unique index recreated — CONCURRENTLY refresh still works

---

## Validation Commands

```bash
# Build cost, no lock taken on the MV
node scripts/profile-source-mv-refresh.mjs --explain --only=registry_gym_market_comparators_v1

# Equivalence
node scripts/compare-gym-market-peer-equivalence.mjs --baseline=artifacts/peer-equivalence/baseline.json

# Refresh with telemetry
node scripts/profile-source-mv-refresh.mjs --apply --only=registry_gym_market_comparators_v1

# App-level
npm run lint:src
npm run build
```

```sql
-- Parity check
SELECT (SELECT count(*) FROM registry_internal.registry_gym_market_comparators_v1) AS mv,
       (SELECT count(*) FROM public.tenants)                                       AS tenants;

-- Peer counts must never exceed 6, never be null
SELECT max(jsonb_array_length(compare_options)) FROM registry_internal.registry_gym_market_comparators_v1;
```

---

## Acceptance Criteria
- [ ] Equivalence proven on the bounded sample, ties declared
- [ ] Build completes; `--explain` reports finite time (<120s target)
- [ ] MV reaches 75,901 rows
- [ ] All 3 indexes and all grants restored; CONCURRENTLY refresh still works
- [ ] Pages render comparison panels for previously-missing contractors
- [ ] `registry_internal` still denies the Insights role (no new grants)

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Rewrite changes peer selection subtly | Medium | High | Task 1 baseline captured BEFORE any change; order compared, not just membership |
| K=7 insufficient for some bucket shape | Low | High | Proof in design; edge tests cover singleton/sparse/self-exclusion |
| Index or grant lost in drop/recreate | Low | High | Captured at runtime, restored in the same transaction; one unique index is mandatory for CONCURRENTLY |
| Rewrite fast but still large output | Medium | Medium | 75,901 rows × 6 peers × ~908 B ≈ 900 MB uncompressed — measure `db_size_peak_bytes`, do not assume |
| Task 5 attempts COMMIT inside plpgsql | Medium | Medium | Gotcha states it outright; decide caller-driven vs function-driven before coding |

## Notes

Current safe state: job 1 paused, jobs 2–3 active, nine of ten source MVs at full 75,901
parity, `gym_market_comparators` stale at 26,934 and degrading gracefully
(`gymMarketComparison.ts` returns `compareOptions: []`, verified). Nothing regresses while
this is built.

The 2026-07-25 comparator caps are complete and independent; this plan does not undo them.
