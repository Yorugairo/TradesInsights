# Plan: Data hygiene round 2 — org name quality, review-queue honesty, codified audit

> **Working doc + source of truth.** Every number below was measured against hosted
> production on **2026-07-28** during planning — not assumed, not recalled. If a claim here
> disagrees with the code or a fresh measurement, reality wins and this file gets fixed.

## Summary

Round 2 of the data-quality program (round 1 = phases 1/2/3/5, `fdb67e7`, completed plan in
`completed/data-quality-connections-observability.plan.md`). Three defects earn code this
round: **org-name quality lives only inside one view's regex** while 57%+ of orgs fail it and
every other consumer either re-implements or silently includes junk; **the review queue is
~⅓ noise** (784 documented category-error rows nobody can action, mixed in with actionable
work); and **this audit itself was hand-run SQL** — unrepeatable, undiffable. The round
closes by codifying the audit as a gate so round 3 starts from a diff, not archaeology.

## User Story

As **the operator (and every read-model consumer)**, I want junk org names classified once
at write time, the review queue segmented into actionable vs awaiting-evidence, and a
one-command production data audit, so that quality regressions surface as a failing command
instead of a customer-visible oddity.

## Problem → Solution

Quality knowledge is scattered: a regex in migration 0026, a memory note about 784
unactionable reviews, a hand-run SQL session. → One `name_quality` column stamped at write
time and read everywhere; reviews tagged by what evidence they actually await; `pnpm
audit:data` reproducing every number in this plan.

## Metadata

- **Complexity**: Medium-Large (~14 files, 6 tasks, 2 migrations)
- **Source PRD**: N/A (standalone round; predecessor plan in `completed/`)
- **Repo**: TradesInsights — **pnpm**. Migrations `0039`/`0040` (0038 = takeoff/field).
- **Scoring**: NOTHING in this plan may touch a scoring input. Eval must stay
  byte-identical; that is an acceptance gate, not an aspiration.

---

## GROUND TRUTH — production measurements, 2026-07-28

### Healthy (verified, no work needed — resist the urge)

| Metric | Value |
|---|---|
| Geometry coverage | 15,031/16,231 located (92.6%); only **2** never-attempted — nightly geocode is draining fine |
| Corroboration | **0** NULL — derivation pass complete |
| Event dedupe | 41,305 events, **0** duplicates on the 0035 five-column key |
| Resolution completeness | **2** records unresolved-and-not-in-review (invariant-level clean) |
| Invitations/inbound | 0 rows (feature idle awaiting real customer mail — nothing to clean) |
| Lint | **0 errors** — the memory claim "phase 5.3 undone, 28 real errors" is STALE; fixed since. Correct the memory at close-out |

### Defects (the round's actual scope)

| # | Finding | Measured |
|---|---|---|
| D1 | Org-name quality encoded ONLY in `insights_public.cockpit_opportunities_v1`'s inline regexes (migration 0026:69-71) | 6,220 orgs: **3,528 fail the business-entity gate** (57% — mostly person names, legitimate), **57 junk-named** (`SAME AS OWNER`, `TBD`, `PER PLANS`, 3+ digit runs) |
| D2 | Review queue mixes actionable with structurally-unactionable | **2,490 pending**: 1,622 `proximity_org` + 815 `address_name` + 53 `parcel_overlap`. Inside address_name sit the **784 category-error rows** (permit titles compared as if company names — round 1 measured 0/784 collapse, 100% `none`) |
| D3 | Trade-tag NULLs unreadable as a metric | 13,537/16,231 NULL (83%) — but decomposed: **3,126 untaggable** (no public permitType at all) + **12,470 with unmatched types**, and the residue top-N is `BUILDING` 3,573, `BF` 853, `RIGHT-OF-WAY` 678, `NEW STRUCTURE` 541, `BK` 462, `REMODEL` 407… — generic classes carrying **no trade signal**. The number is mostly LEGITIMATE; what's missing is visibility, not tags |
| D4 | Priority opportunities with no stated valuation from any active public record | **1,090** — source reality (many permits publish none), needs per-source visibility, never fabrication |
| D5 | Org name-collision groups (normalized) | **26** — small; owner-review note, NOT a merge pipeline (registry precedent: 853 groups shared 0 UBIs; merges disproven) |
| D6 | This audit itself | hand-run SQL in a chat session — unrepeatable |

### Prior-round DO-NOTs that still bind (from memory, verified against round-1 plan)

- **No containment auto-resolution for the 784** — measured 0% collapse; they are a
  category error (permit titles, not company names). They need org-role names or parcel
  evidence, or an honest "awaiting evidence" tag.
- **Never write `applied_at`/`applied_action`/`trust_score` on applied `partner_observations`** from this repo.
- Drizzle applies by journal timestamp — never edit an applied migration.
- New pursuit-child tables need a `global-setup.ts` MUTATION_TABLES entry (tripwire enforces it now) — no such tables this round, but 0039 must still reach `otn_e2e` (global-setup migrates it automatically since `523243c`).

---

## UX Design

Internal + one cockpit surface change:

| Touchpoint | Before | After |
|---|---|---|
| `/app/admin/review` | one undifferentiated pending list | actionable vs `awaiting_org_evidence` segmented (existing Phase-A1 filter machinery; new value) |
| Read models (cockpit view, GC radar, org league) | each re-implements (or omits) the junk gate | read `organizations.name_quality` — one source of truth |
| Operator | hand-run SQL to know data health | `pnpm audit:data [--json]`, non-zero exit on invariant breach |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `packages/db/migrations/0026_cockpit_easy_win.sql` | 50-78 | The regexes being centralized — lift VERBATIM, then the view swap in 0040 must keep every column's name/type/position (CREATE OR REPLACE rule) |
| P0 | `packages/resolution/src/resolver.ts` | org-upsert region (`INSERT INTO organizations`) | Where `name_quality` gets stamped at write time |
| P0 | `packages/resolution/src/review.ts` + `apps/worker/src/cli/review.ts` | all | The reclassify pass extends this CLI; `reevaluatePendingReviews` (dry-run default, `decided_by='system/reevaluation'`) is the discipline to mirror |
| P0 | `packages/resolution/src/google-name-agreement.ts` | all | `classifyNameAgreement` — reused against org-role names for T2; its round-1 misuse against permit titles is what created the 784 |
| P1 | `packages/resolution/src/project-trades.ts` | all (80 lines, quoted in plan) | Gains the unmatched-residue report; reset-then-derive semantics must not change |
| P1 | `apps/worker/src/cli/reap-runs.ts` | all | CLI pattern: `--dry-run`/`--json` flags, pnpm registration in BOTH package.jsons |
| P1 | `apps/worker/src/schedules.ts` | `runMaintenance` | Where nothing new gets added this round (audit is a command, not a cron) — read to confirm, not to edit |
| P2 | `apps/web/app/app/admin/review/page.tsx` | filter machinery | A1 filters gain the `awaiting_org_evidence` facet |
| P2 | `apps/worker/test/orphan-reap.test.ts` | 1-55 | Test fixture pattern (testDb, RUN-suffixed keys, FK-ordered cleanup) |

## External Documentation

None. GOTCHA recorded instead: the cryptic permit-type codes (`BF`, `BK`, `TJ`, `EA`) may
decode via official jurisdiction domain tables — that is **discovery-gated backlog** (find
the official lookup, never guess meanings), not this round.

---

## Patterns to Mirror

### THE_GATE_BEING_CENTRALIZED
```sql
-- SOURCE: packages/db/migrations/0026_cockpit_easy_win.sql:69-71 (verbatim)
AND og.canonical_name ~* '(LLC|INC|CORP|COMPANY|CO\.|LP|LLP|PLLC|LTD|GROUP|CONSTRUCTION|BUILDERS|HOMES|DEVELOPMENT|ELECTRIC|PLUMBING|MECHANICAL|ROOFING|SERVICES|ENTERPRISES|ASSOCIATES|PARTNERS|CITY OF|COUNTY|DISTRICT|AUTHORITY|CHURCH|SCHOOL)'
AND og.canonical_name !~* '^(NO |NOT |N/A|NA$|UNKNOWN|NONE|OWNER$|SAME AS|TBD|SEE |APPLICANT$|PER PLANS)'
AND og.canonical_name !~ '[0-9]{3,}'
```
Three tiers fall out of it: passes positive list → `business`; hits negative list or digit
rule → `junk`; neither → `person_or_unknown` (a sole proprietor is not junk — 3,528 rows sit
here and MUST NOT be filtered like the 57).

### SERVICE_FUNCTION / TYPED_ERROR / CLI / MIGRATION / TEST
Same patterns as the takeoff/field round, all verified this week in-repo:
`(db, id, input)` services with raw `sql` (pursuit.ts:240-249), typed error code unions
(pursuit.ts:52-69), CLI with dry-run default + `[sqz]`-safe JSON logs (reap-runs.ts),
additive `CREATE TABLE/ALTER ... IF NOT EXISTS` migrations with WHY-comments
(0036/0038 headers), vitest fixtures with `RUN` suffix + FK-ordered `afterAll`
(takeoff.test.ts). New code must be indistinguishable from those files.

### DERIVE_SUMMARY_SHAPE
```ts
// SOURCE: packages/resolution/src/project-trades.ts:19-23
export interface ProjectTradesSummary {
  distinctPermitTypes: number;
  permitTypesMatched: number;
  projectsTagged: number;
}
```
T3 extends this shape additively (`topUnmatched`) — never repurposes existing fields.

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `packages/db/migrations/0039_org_name_quality.sql` | CREATE | `organizations.name_quality text NULL` + CHECK (`business|person_or_unknown|junk`) + partial index on `junk` |
| `packages/db/migrations/0040_cockpit_view_name_quality.sql` | CREATE | 0026 view re-created reading the column — **applied only after backfill** (see T1 GOTCHA) |
| `packages/db/src/schema.ts` | UPDATE | column on `organizations` |
| `packages/resolution/src/org-name-quality.ts` (+ test) | CREATE | pure classifier, regexes lifted verbatim; the ONLY definition |
| `packages/resolution/src/resolver.ts` | UPDATE | stamp `name_quality` at org upsert |
| `packages/resolution/src/review.ts` (+ CLI) | UPDATE | `reclassifyComparanda` pass (T2) |
| `packages/resolution/src/project-trades.ts` | UPDATE | residue report (T3) |
| `apps/worker/src/cli/backfill-org-quality.ts` | CREATE | one-shot TS backfill over 6,220 rows |
| `apps/worker/src/cli/data-audit.ts` | CREATE | `pnpm audit:data` (T4) |
| `apps/worker/test/{org-name-quality,review-reclassify,data-audit}.test.ts` | CREATE | per task |
| `apps/web/app/app/admin/review/page.tsx` | UPDATE | awaiting-evidence facet |
| `package.json` + `apps/worker/package.json` | UPDATE | `audit:data`, `orgs:backfill-quality` |
| `docs/data-quality-audit-2026-07-28.md` | CREATE | baseline snapshot (T4 output, committed) |

## NOT Building

- **Containment auto-resolution for the 784** — measured 0% collapse in round 1; re-verified premise this round. Machine never merges/rejects them.
- **An org merge pipeline** — 26 collision groups is an owner-review list in the audit output, not a subsystem (registry precedent: merges disproven at 853 groups).
- **Valuation fabrication** — 1,090 priority rows lack source valuations; the audit reports per-source null-rates so parser work can be targeted; nothing invents a number.
- **Vocabulary stuffing** — `BUILDING`/`REMODEL`/`RIGHT-OF-WAY` carry no trade signal; tagging them would poison market aggregates. Cryptic-code decoding (`BF`/`BK`/`TJ`/`EA`) is discovery-gated backlog against official domain tables only.
- **Scoring-input changes** — `gc_quality`/`warm_gc` inputs untouched even where `name_quality` would "help"; that is a §12.3 calibration conversation, not a hygiene commit.
- **Deletions** — junk orgs keep their rows (append-only evidence ethos); they are flagged and filtered, never destroyed.
- **A cron** — the audit is a command + baseline doc; scheduling it is an owner call once it has run manually for a while.

---

## Step-by-Step Tasks

### Task 1: org `name_quality` — classifier, column, stamp, backfill, view swap
- **ACTION**: Centralize the 0026 gate as data.
- **IMPLEMENT**: `classifyOrgNameQuality(name: string | null): "business" | "person_or_unknown" | "junk"` — regexes verbatim from 0026 (junk checks FIRST: negative list or `[0-9]{3,}` → `junk`, else positive list → `business`, else `person_or_unknown`). Migration 0039 adds the nullable column + CHECK + `CREATE INDEX ... WHERE name_quality = 'junk'`. Resolver stamps it on every org INSERT/UPDATE-name path. `pnpm orgs:backfill-quality [--dry-run]` classifies all rows in one pass (batched UPDATEs, logs tier counts — expect ≈57 junk / ≈3,47x person / rest business against the D1 measurement; a wild divergence means the classifier drifted from the view, STOP).
- **MIRROR**: THE_GATE_BEING_CENTRALIZED; CLI pattern from reap-runs.ts.
- **GOTCHA (ordering)**: 0040 (view reads the column) must apply AFTER the backfill has run on that database, or the view's junk-filter drops rows whose `name_quality` is still NULL. Encode as: view predicate `COALESCE(og.name_quality, 'business') != 'junk'` PLUS the positive-gate fallback retained — so an unbackfilled row behaves exactly as today. Then the strict swap (predicate = `name_quality = 'business'`) is a THIRD step deferred to round 3 once prod has been stamped for a while. CREATE OR REPLACE VIEW keeps every existing column name/type/position (0026's own rule).
- **GOTCHA (scope)**: consumers that feed SCORING keep their current logic untouched.
- **VALIDATE**: unit tests (junk-first precedence, `CITY OF X` → business, `JOHN SMITH` → person, `SAME AS OWNER`/`555-1212` → junk, null → junk); backfill dry-run counts ≈ D1; view returns identical rowcount before/after 0040 on local corpus.

### Task 2: review-queue honesty — reclassify the category-error rows
- **ACTION**: Make the 784 (and any siblings) visibly non-actionable instead of noise.
- **IMPLEMENT**: `reclassifyComparanda(db, {dryRun})` in review.ts + `pnpm review reclassify` subcommand. For pending `address_name` reviews: detect permit-title-shaped comparanda (reuse the round-1 name-audit detection); where the candidate project carries org-role names, re-run `classifyNameAgreement` against THOSE — `exact|contained` upgrades the row's `features_json.comparanda = 'org_roles'` (stays pending, now genuinely actionable); where no org evidence exists, stamp `features_json.awaiting = 'org_evidence'` + `decision_note`. Status NEVER changes; `decided_by` untouched (nothing is decided). Review page facet splits on `features_json.awaiting`.
- **MIRROR**: `reevaluatePendingReviews` discipline — dry-run default, counts logged, machine never merges.
- **GOTCHA**: expect ≈784 tagged awaiting + a small upgraded set; if the tagged count is wildly off, the detection heuristic drifted — STOP and compare against `pnpm review name-audit` output rather than shipping.
- **VALIDATE**: unit test with three fixture reviews (org-evidence-agrees, org-evidence-disagrees, no-org-evidence); dry-run against local corpus; page facet renders both buckets.

### Task 3: trade-tag residue visibility
- **ACTION**: Make the 83% NULL readable without changing what gets tagged.
- **IMPLEMENT**: `ProjectTradesSummary` gains `topUnmatched: {permitType, projects}[]` (top 15, computed from the mapping residue already in memory during derivation) and `untaggableProjects` (no public permitType). Log line unchanged in shape, extended in fields. The audit (T4) surfaces both.
- **MIRROR**: DERIVE_SUMMARY_SHAPE — additive only.
- **GOTCHA**: reset-then-derive stays byte-identical for tagging; this task adds REPORTING only. No vocabulary edits (see NOT Building).
- **VALIDATE**: unit test: matcher that matches nothing → summary carries the full residue; existing derivation tests untouched and green.

### Task 4: `pnpm audit:data` — the codified audit + baseline
- **ACTION**: Turn this plan's GROUND TRUTH section into a command.
- **IMPLEMENT**: `apps/worker/src/cli/data-audit.ts` running the exact queries from planning (geometry/corroboration/dedupe/unresolved invariants; org tier counts; review composition incl. awaiting facet; trade residue; priority-no-valuation per account + per-source valuation null-rate; org collision groups listed). Output: human table + `--json`. Exit non-zero ONLY on hard invariants: `corroboration_null > 0`, dedupe residual > 0, `unresolved_not_in_review > 10`. Everything else is reported, never fatal (a 57% person-name rate is a fact, not a failure). First run's output committed as `docs/data-quality-audit-2026-07-28.md` with the D-table from this plan as the baseline column.
- **MIRROR**: reap-runs.ts CLI shape; `[sqz]`-safe single-line JSON logs.
- **GOTCHA**: every query account-scoped or graph-global exactly as measured here — a "priority" count that forgets `state != 'archive'` will never reconcile with this plan's numbers.
- **VALIDATE**: run against local corpus (invariants pass); run `--json` parses; run against hosted reproduces this plan's numbers ±drift.

### Task 5: junk-org verification sweep (the 57)
- **ACTION**: Prove the junk tier is safe to filter everywhere.
- **IMPLEMENT**: inside data-audit: assert no `name_quality='junk'` org carries `registry_ref`, organization_identifiers rows, or an account relationship — list violators verbatim if any (owner decision, not machine). No deletions ever.
- **VALIDATE**: hosted run lists zero violators (or the report exists and the plan's assumption is corrected in history).

### Task 6: close-out
- Full `pnpm test` + `pnpm test:e2e` (global-setup auto-migrates otn_e2e — no manual step since `523243c`), `pnpm typecheck`, **`pnpm eval:run` byte-identical** (precision 1, recall 0.9609375, Solis 22/22 — any drift means a scoring input moved and the round STOPS), hosted apply 0039 → backfill → 0040 in that order, re-run `pnpm audit:data` against hosted and commit the baseline doc, STATUS row, memory updates (retire the stale lint claim in `data-quality-phases-1235`; record trade-NULL decomposition), archive plan + report.

---

## Testing Strategy

| Test | Input | Expected | Edge |
|---|---|---|---|
| classifier precedence | "SAME AS OWNER LLC" | junk (negative list beats positive) | ✔ the ordering IS the spec |
| classifier digits | "PERMIT 20260190" | junk | 3+ digit rule |
| classifier person | "JOHN SMITH" | person_or_unknown | 3,528 rows must NOT read junk |
| reclassify: org evidence agrees | review w/ role org matching | features_json.comparanda='org_roles', still pending | no status change ever |
| reclassify: no org evidence | bare review | awaiting='org_evidence' stamped | idempotent second run |
| residue report | matcher matching nothing | full top-N residue | additive summary |
| audit invariants | corpus with 1 planted unresolved stray >10 | exit 1 naming the invariant | soft metrics never fatal |

Edge checklist: null/empty names (junk); already-stamped rows (backfill idempotent); dry-run everywhere writes nothing (assert rowcounts); concurrent stamp vs backfill (last-write-wins on same value — benign).

## Validation Commands

```bash
pnpm typecheck
```
```bash
pnpm test
```
```bash
pnpm test:e2e
```
```bash
pnpm eval:run
```
EXPECT byte-identical gates — hard stop otherwise.
```bash
pnpm db:migrate && pnpm orgs:backfill-quality --dry-run
```
```bash
pnpm audit:data --json
```
Manual: review page facets; hosted backfill counts ≈ D1; baseline doc committed.

## Acceptance Criteria
- [ ] All six tasks; all commands pass; eval byte-identical
- [ ] Backfill counts reconcile with D1 (≈57 junk); divergence investigated before apply
- [ ] The 784 visibly segmented; zero machine decisions on them
- [ ] `docs/data-quality-audit-2026-07-28.md` committed from a real hosted run
- [ ] Stale memory (lint claim) corrected

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Classifier drifts from view regex during translation | Medium | High (rows vanish from cockpit) | Regexes lifted verbatim + COALESCE fallback predicate + rowcount-identical view test |
| View swap before backfill | Low (encoded) | High | 0040's predicate tolerates NULL; strict swap deferred to round 3 |
| Reclassify touches something scoring reads | Low | High | features_json only; status/decided_by never written; eval gate |
| Audit numbers drift from plan by the time of implementation | Certain (live DB) | Low | Audit reports, plan records planning-time baseline; only invariants are assertions |

## Notes

Round-3 seeds surfaced by this round's measurements, deliberately deferred: strict view
predicate swap; cryptic permit-code decoding against official domain tables; per-source
valuation parser work ranked by the audit's null-rate table; owner review of the 26 org
collision groups; SEPA-class stage mapping (861 unknown-stage projects — structural since
M3.4).

## Plan history

**2026-07-28 — v1.** Written measurement-first against hosted production. Two planning
assumptions died mid-flight and are recorded so they stay dead: (1) "trade-tag NULLs mean
un-evaluated" — false, derivation is reset-then-derive over everything; the NULLs decompose
into 3,126 untaggable + 12,470 whose permit types (`BUILDING`, `RIGHT-OF-WAY`, letter codes)
carry no trade signal, so the fix is visibility, not vocabulary; (2) "phase 5.3's 28 lint
errors remain" — false, lint is clean; the memory claim is stale and gets corrected at
close-out.
