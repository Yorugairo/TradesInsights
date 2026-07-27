# Implementation Report: Source Fleet Flow Verification + Scheduling

Executed 2026-07-27 against production (`arbmeioglflvzoffgtii`) and the local test DB.

## Summary

The fleet had 36 registered sources, 29 enabled, and no scheduler. That is now
fixed, and — more usefully — **two of the three "broken" findings in the plan
turned out to be measurement artefacts rather than defects.** Both were the same
mistake in different clothes: reading counters that were never written.

| Task | Status | Outcome |
|---|---|---|
| 1. Status literal audit | Complete | **No bug.** The only `'completed'` literals are pg-boss's own `state = 'completed'` in `schedules.ts:335-337`, which is correct for `pgboss.job`. Nothing filters `source_runs.status` on a literal that does not exist |
| 2. bellevue + spokane | Complete | bellevue **was never broken**; spokane disabled with a measured reason |
| 3. The 11/4/7 signature | Complete | One shared cause, confirmed, and it is by design |
| 4. The never-ran nine | Complete | All nine dispositioned; **zero are case (c)** |
| 5. `rejected_count` | Complete | Proven live on both record paths |
| 6. Cadence-aware flow assertion | Complete | `assertSourceFlow`, backtested against real history |
| 7. Scheduler | **Code complete, blocked on secrets** | GH Actions workflow committed; needs `DATABASE_URL` + object-storage secrets |
| 8. Alert on the gap | Complete | `source_no_flow` wired into `evaluateAlertConditions` |

---

## Task 2 — the two "broken" ArcGIS sources were not the same problem

### `bellevue_permits_arcgis` — never broken

The plan recorded "2 runs, 0 ok, 0 discovered, zero records ever". Every one of
those zeros was **an unwritten column**. Both runs were orphans, reaped at
`status='running'` with null metrics, so their counters were never measurements.

Measured directly instead:

```
artifacts stored   3
records stored     4,018
first artifact     2026-07-27 02:19:56Z
```

A clean run on 2026-07-27 confirmed it: `discovered 3, fetched 3, unchanged 3,
status succeeded, health green`. **Unchanged** because the bytes were identical
to what the "failed" runs had already banked before dying.

Left enabled. The finding is recorded in its `config/sources.yaml` notes so the
next reader does not re-derive it.

### `spokane_permits_arcgis` — a deliberate UA block, disabled

Not a bad `access_url` or layer index. The identical query, same minute:

| User agent | Result |
|---|---|
| `Mozilla/5.0 (Windows NT 10.0; Win64; x64)` | **HTTP 200** |
| `OTNInsightsBot/0.1 (+https://onetradenetwork.com)` | **HTTP 302** |

The 302's `Location` header is **the request URL itself**, so following it loops
forever. There is no `robots.txt` (404), so this is a server-side UA filter, not
a crawl directive.

**Not worked around by spoofing a browser UA.** That is evading a deliberate
block — the same "push against the gate" that `scripts/pals-capture-loop.mjs`
exists to refuse. Set `enabled: false` with the measurement in `notes`, per the
plan's own disposition rule. Cost is low: eastern WA is far from every current
account and Solis's distance band de-rates it hard.

---

## Task 3 — the 11/4/7 signature has ONE cause, and it is by design

The plan's hypothesis ("three independent bugs producing identical ratios is
unlikely") was right. The shared cause is that all three are **capture-fed
`on_demand` sources**, and a run fails when no capture has been staged:

| Source | Barrier |
|---|---|
| `olympia_smartgov_reports` | Report renders only through a session-bound Exago `eid`; non-PDF export 500s |
| `tumwater_development_review` | Akamai edge policy 403s datacenter clients |
| `tumwater_sepa` | Same Akamai policy |

The adapters raise a descriptive error naming `$OTN_CAPTURE_DIR` and what to
stage there. The 4 successes are the runs where a capture was present; the 7
failures are the runs where one was not. They have produced 1,449 / 80 / 59
records respectively, so they work.

**Nothing to fix.** These are `on_demand` by design, run via
`source:run:operator-local`, and are correctly excluded from both the scheduler
and the new flow check — a datacenter clock has nothing useful to say about a
source that runs when a human stages a capture.

`thurston_active_notices` is unrelated despite appearing in the same list: its
failure was the terminal `source_runs` write losing its connection, the pooler
durability case already documented at `runner.ts:361`.

---

## Task 4 — the never-ran nine, dispositioned

Read from config, not guessed:

| Source | enabled | cadence | access_class | Disposition |
|---|---|---|---|---|
| `auburn_permits_socrata` | false | daily | socrata | (b) disabled on purpose |
| `customer_bid_inbox_solis` | true | on_demand | private_authorized | (a) correct — authorized inbox, own delivery path |
| `fake_source` | true | on_demand | fixture | (a) test fixture |
| `fake_source_required` | false | on_demand | fixture | (a) test fixture |
| `pierce_environmental_determinations` | false | daily | html | (b) disabled |
| `seattle_design_review` | false | on_demand | dynamic_lookup | (b) disabled **and** on_demand |
| `thurston_hearing_examiner` | false | on_demand | dynamic_lookup | (b) disabled |
| `thurston_land_use_rezone` | false | on_demand | dynamic_lookup | (b) disabled |
| `wa_lni_verify` | false | on_demand | dynamic_lookup | (b) disabled |

**Zero cases of (c) "should be running but isn't."** The plan named
`seattle_design_review` as "the most likely (c)" because it has a committed
adapter and a passing test — but it is `enabled: false` *and* `on_demand` *and*
`dynamic_lookup`, i.e. the same capture-fed class as Olympia and Tumwater. Having
an adapter is not evidence a source was meant to be running.

---

## Task 5 — `rejected_count` is a live counter

Traced in `runner.ts` (two increments: schema failure and sourceKey mismatch)
and proven executable on **both** record paths in
`apps/worker/test/solicitations.test.ts`. An invalid record increments the
counter and is not written.

So production's `rejected_count = 0` across ~27,000 records is the honest
reading: adapters construct `NormalizedSourceRecord` under `tsc`, so most
malformed output is a compile error long before it is a runtime rejection. Not a
dead counter.

---

## Task 6 — cadence-aware flow assertion

`packages/source-sdk/src/flow.ts` → `assertSourceFlow`, plus `pnpm flow:check`.

Three design decisions, each forced by a specific way the naive version is wrong:

- **Iterates config, then LEFT JOINs runs.** A source that has never run has no
  rows to find; only something that knew to expect it can report it missing.
- **Usable output is `parsed + duplicate + unchanged`.** A source whose artifacts
  are hash-identical today is working; `unchanged` is the proof.
- **Orphans are excluded from the judgement** and get their own `unknown` state.
  Their counters are unwritten, not zero.

### Backtest against the real 6 days — the plan's acceptance test

| Source | Result | Required |
|---|---|---|
| `bellevue_permits_arcgis` | `unknown` (flagged) | flagged ✓ |
| `spokane_permits_arcgis` | `no_records_in_window` (flagged) | flagged ✓ |
| `lacey_permit_reports` (monthly, 51 records, 0 today) | `flowing` — **not** flagged | not flagged ✓ |

**21 flowing, 2 flagged.** A single-run `parsed_count = 0` check would have
flagged 13 and been wrong about 11.

10 unit tests in `apps/worker/test/source-flow.test.ts` cover each state plus the
mixed orphan/real cases.

---

## Task 7 — scheduler: GitHub Actions

`.github/workflows/source-fleet.yml`, four schedules: daily fetch, weekly fetch,
monthly fetch, nightly maintenance, plus `workflow_dispatch`.

**The default-branch trap is resolved, not merely noted.** Verified with
`gh repo view --json defaultBranchRef` → `claude/tmux-install-320aiz`, which is
the branch this file is on. `schedule:` will fire. No merge or default-branch
change is needed.

### Deviation: sequential runs instead of per-source cron stagger

The plan said "schedule per `cadenceCron()` so the existing stagger is
preserved". Reproducing a per-source-minute stagger in GH Actions would need up
to 60 schedule entries, and GH cron is 5–15 minutes late anyway, so the
precision would be fictional.

`pnpm source:run:cadence --cadence=daily` instead runs the set **sequentially**,
continuing past failures. This honours the stagger's purpose more strictly than
the stagger did: exactly one county server is being fetched at any moment. The
measured budget supports it — mean run 0.7 min, p99 6.9 min, slowest ever 8.8
min, and the daily set is 18 sources.

Sets resolved from config: **18 daily, 2 weekly, 2 monthly.**

---

## Task 8 — `source_no_flow` alert

Added to `evaluateAlertConditions`. Distinct from the existing `source_stale`
check, and the difference is why it was needed: `source_stale` reads
`sources JOIN coverage_entries` and then requires `last_success_at` to be
non-null, so **a source that has never run passes silently**.

Severity splits on the failure kind — `never_ran` / `no_run_in_window` are
critical (nothing is invoking it), `no_records_in_window` / `unknown` are
warnings (it ran; the red/stale checks usually also fire). The idempotency key
includes the state, so a source changing failure mode re-announces rather than
being deduped against yesterday's different problem.

---

## Validation

| Check | Result |
|---|---|
| `pnpm typecheck` | Clean, 11 packages |
| `pnpm lint` | 0 errors |
| Affected tests | 31 passed (flow 10, solicitations 5, alerts 6, domain 10) |
| `pnpm flow:check --all` vs production | 23 checked, 2 flagged, exit 1 |

---

## Deployed 2026-07-27 (owner-approved)

`packages/db/src/seed.ts` run against production, reconciling the `sources`
table with config: `spokane_permits_arcgis` `enabled` true → **false**, and the
two bid sources seeded disabled. 36 → 38 sources.

**This closed a drift worth naming.** Between the commit and the seed, config
said Spokane was disabled while the production row still said enabled. Nothing
would have *run* it — `schedulableSources` and `assertSourceFlow` both read
config — but `evaluateAlertConditions` reads `sources WHERE enabled = true` from
the **database**, so it would have kept raising `source_red` / `source_stale`
for a source deliberately switched off. Editing `config/sources.yaml` is not the
whole act; the seed is.

**`pnpm flow:check` against production: 22 checked, 0 flagged** — the fleet reads
fully green for the first time. Neither change was a code fix:
`bellevue_permits_arcgis` now has a genuine successful run inside its window
(the "broken" verdict was orphaned bookkeeping), and Spokane is correctly out of
scope.

That green is *not yet* evidence the scheduler works — every run behind it was
still invoked by hand. The acceptance criterion below is what tests that, and it
needs the secrets first.

## Remaining human blocker

**GitHub Actions secrets.** The workflow fails fast with an explicit message
until these exist under Settings → Secrets and variables → Actions:

- `DATABASE_URL` (required)
- `OBJECT_STORAGE_ENDPOINT` / `_REGION` / `_BUCKET` / `_ACCESS_KEY` / `_SECRET_KEY` (required — artifacts are stored before parsing)
- `REGISTRY_DATABASE_URL`, `ALERTS_EMAIL`, `SMTP_HOST`, `SMTP_PORT` (optional; absent is a visible skip)
- `SOURCE_USER_AGENT` as a repository *variable*

The plan's acceptance criterion — "every `daily` source has a run within 24h,
sustained over 3 days" — cannot be closed until the secrets are in place and
three nights have passed. `pnpm flow:check` is the command that verifies it.
