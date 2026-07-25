# Implementation Report: surfacing unbindable orgs (Phase B, then Phase A)

Plan: `.claude/PRPs/plans/ambiguous-binding-observations.plan.md`, sequenced B → A at owner
direction. Both phases shipped. One acceptance item deliberately not executed — see
**Not done, and why**.

## Summary

An organization whose name matched several registry entities produced **no record of any
kind** — not bound, not queued, not counted. Phase B made the whole binding gap countable;
Phase A gave the ambiguous slice a review row per candidate. B was built first so A's
fan-out cap came from the real distribution rather than from one anecdote, and that
sequencing paid: **the anecdote was wrong by 4x.**

## What the measurement changed

| Claim carried into this work | Measured (whole population, 2026-07-25) |
|---|---|
| "FASTSIGNS matches **16** entities, so a fan-out cap is required" | It matches **4**. The 16 came from a SQL `LIKE`, not the binder's `crossNameKey`. |
| Worst case unknown; cap of 5 proposed | 15 ambiguous orgs, mean 2.4 candidates, **p95 = 4, max = 4**. |
| "`B & R PLUMBING` is likely **absent**, not ambiguous" (my earlier retraction) | Also wrong — it is `exact_match_ambiguous`, 2 candidates: `B & R Plumbing Inc`, `B R Plumbing`. `crossNameKey` does normalize the `&` and the suffix. |

So the cap is **headroom, not a filter**: `AMBIGUOUS_FANOUT_CAP = 10` never fires on any
organization that exists today. Had Phase A shipped first with a cap of 5 sized off
FASTSIGNS-16, the number would have been wrong in both directions — too low to be safe if
the anecdote were right, and pure ceremony given it wasn't.

## The bigger finding Phase B surfaced

`exact_match_no_candidate` = **237 orgs** — each matches **exactly one** registry entity by
the binder's own key, and has **zero** observations of any status. Not rejected: never
generated.

Cause is not a code defect. `strict-bind:preview` (read-only) says a run right now would
queue **264** candidates — the generator simply has not run since the registry grew to
72,952 entities. Command, when the owner wants it:

```bash
cd apps/worker && pnpm strict-bind:apply
```

That is 16x the ambiguous bucket, and it is the single largest binding win currently
available. Left for a deliberate decision because it populates a live review queue with 264
rows this plan did not ask for.

## Tasks

| # | Task | Status | Notes |
|---|---|---|---|
| B1 | `insights.org_binding_gap` | Complete | Migration `0034`, applied live; drizzle ledger was in sync (34 rows, newest `when` matched `0033`) so exactly one migration ran. |
| B2 | `--persist` on `binding-audit` | Complete | Buckets restructured to a single `GapRow` classification; log line and DB row are two renderings of one pass. |
| B3 | Read the distribution | Complete | p95 = 4 for the ambiguous bucket. Fed A2's cap. |
| A1 | `binding_name_ambiguous` rule key | Complete | Deliberately absent from `evaluateStrictBind`. |
| A2 | One observation per candidate | Complete | Emission body wrapped in a per-candidate loop. |
| A3 | Scoring + review tier | Complete | Deviated from the plan's recommendation — see below. |
| A4 | Governance test | Complete | 58 tests green in `packages/resolution`. |

## Deviations from the plan

**1. `candidates_json` stores `{entityId, name}`, not bare entity ids.** The Insights role
is denied `registry_internal` (42501), so a registry entity id in this table can *never* be
resolved to a name by SQL from here. Either the name is captured at write time or the row is
unreadable.

**2. `--persist` refuses `--scope=primary`.** A subset snapshot is not a point on a
whole-population trend line, and the table has no column saying which population a run
covered. Refusing is cheaper and stricter than adding one; `--scope=primary` remains a
log-only view.

**3. `candidate_count = 0` for `absent_from_registry`,** even when a sub-floor near-miss
exists. "Candidate" has to mean one thing — something that could plausibly bind — or the
percentile that sizes the cap gets inflated by non-candidates. The near-miss stays in
`detail`.

**4. The name component is `1/n`, not the plan's "LOW trust score" nor the 1.0 I first
wrote.** `StrictBindGateInput` documents this component as *"1.0 for a **unique** exact
cross-key name match"* — uniqueness is part of what the number means, so 1.0 for a
non-unique match misstates a field reviewers read. `1/n` is the honest reading (given only
the name, the chance this candidate of n is the right one), falls naturally as ambiguity
widens, and keeps the rule outside `classifyReviewTier`'s `(c.name ?? 0) >= 1` test even if
a future edit adds the key to that list.

**5. The ambiguous lane is last-resort, not an `else if` peer.** The plan implied setting
`hit` in the `:802` branch. That would have been a regression: every rule from line 832
down (google-phone, **address**, **domain**, **alias**) is guarded on `!hit`, so claiming
the org there would steal it from rules that are *unique identifier* matches — strictly
better evidence than an n-way name tie. Candidates are held in `ambiguousHits` and emitted
only when nothing else matched. This makes the lane **purely additive**, which the dry run
then proved.

**6. The queue floor is per-ORG for this lane, per-row for every other rule.** Not in the
plan; found by measurement. `MIN_QUEUE_TRUST` asks "is this worth operator time?" — for a
normal rule that is a question about the row, but for an ambiguous name it is a question
about the org, because the reviewer's job is to *choose* among candidates. A per-row floor
split the sets: **11 of 39 rows survived**, leaving orgs showing one row labelled "1 of 4"
with the other three silently deleted — worse than emitting nothing, because it looks like
an answer. Set-aware floor: **15 rows, whole sets**, 24 rows belonging to orgs whose best
candidate is below the floor (those orgs stay countable in `org_binding_gap`).

## Validation

**Additive property, proven at production scale.** `strict-bind:preview` runs the real
`generateRegistryObservations` over 3,797 orgs and 72,952 registry rows, dry-run:

| rule | before | after |
|---|---|---|
| `binding_name_exact` | 246 | **246** |
| `binding_name_exact_single_token` | 14 | **14** |
| `binding_address_match` | 3 | **3** |
| `binding_phone_match` | 1 | **1** |
| `binding_name_ambiguous` | — | **15** |
| `strictAutoBound` | 0 | **0** |

Not one existing rule's count moved. Nothing auto-binds.

| Level | Status | Notes |
|---|---|---|
| Typecheck | Pass | `pnpm typecheck`, all packages |
| Lint | Pass | `eslint` on all changed files |
| Unit tests | Pass | 58 in `packages/resolution`, 9 new |
| DB-backed tests | **Not run** | Docker Desktop is not running; `apps/worker/test/*` needs the local DB on :5433. 768 non-DB tests pass. The production dry run above covers the same code path far more broadly. |
| B2 idempotence | Pass | Two `--persist` runs → two distinct `run_id`s, identical bucket counts across all six reasons |
| B2 known orgs | Pass | All three plan-named orgs present with `reason='exact_match_ambiguous'` |

## Not done, and why

The plan's final SQL check ("Before: 0. After: >0, and `auto_accepted` MUST be 0") requires
the observations to be **written**. Writing them means running `strict-bind:apply`, which in
one pass also queues the **264 unrelated backlog rows** described above — a visible change
to what an operator sees, outside this plan's scope.

The property that check exists to prove is already proven more strongly: the dry run reports
`strictAutoBound: 0` and `autoAccepted: 0` at full scale, and `AMBIGUOUS_NAME_RULE`'s
absence from `evaluateStrictBind` is asserted by a unit test that fails if anyone adds it.

## Files changed

| File | Action |
|---|---|
| `packages/db/migrations/0034_org_binding_gap.sql` | CREATED |
| `packages/db/migrations/meta/_journal.json` | UPDATED |
| `packages/db/src/schema.ts` | UPDATED — `orgBindingGap` |
| `apps/worker/src/cli/binding-audit.ts` | UPDATED — `--persist` |
| `packages/resolution/src/registry-observations.ts` | UPDATED — rule key, cap, `buildAmbiguousCandidates`, per-candidate emission, tier, set-aware floor |
| `packages/resolution/src/registry-observations.test.ts` | UPDATED — 9 tests |

## Next

- [ ] Owner decision: `pnpm strict-bind:apply` — queues 264 + 15 rows, none auto-binding
- [ ] Re-run `binding-audit --persist` after any apply; the ambiguous bucket should shrink
- [ ] Places chain: 34,273 tenants have candidates on disk, unloaded
