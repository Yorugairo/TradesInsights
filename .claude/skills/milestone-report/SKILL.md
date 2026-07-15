---
name: milestone-report
description: Produce the required milestone/task report and check exit gates before advancing. Use when completing any M0–M4 task, reporting progress, or deciding whether the next milestone may begin.
---

# Milestone reporting and exit gates

The backlog is `docs/BUILD_SPEC.md` §21 and must be worked strictly in numbered order. **Do not begin a later stage until the prior exit gate passes.** Tests and acceptance checks are completed with each task, never deferred.

Before reporting, confirm the durable docs are current (CLAUDE.md "Durable docs are deliverables"): `docs/STATUS.md` always; architecture / data-dictionary / source-policy / operations when the pass touched them. A task is not complete until its docs are.

## Report format (exactly these six items, nothing else)

1. **Outcome.**
2. **Files and migrations changed.**
3. **Tests run and exact results** (real command output, not paraphrase).
4. **Sources verified and sample counts.**
5. **Remaining blockers/assumptions.**
6. **Next task ID.**

## Exit gates

**M0 scaffold** — a fake adapter discovers, stores, hashes, parses, reruns idempotently, and reports health.

**M1 P0 adapters** (order: M1.1 Lacey → M1.2–1.3 Lewis → M1.4 Pierce → M1.5–1.6 King → M1.7 Seattle Socrata → M1.8 WA SEPA → M1.9 Thurston → M1.10 Tumwater) — ≥90-day backfill where available, golden fixtures, correct county/permitting-jurisdiction on every record, manual audit recorded, green health for all enabled P0 sources.

**M2 project graph** — seed cross-source projects resolve with evidence; ambiguous cases remain reviewable; no source records lost.

**M3 pilot intelligence** — zero unsupported facts; distinct routing for Lacey Home, Lacey Commercial, and Solis; complete feedback loop; pilot runs without spreadsheets. Includes 5–10 reviewed current samples per company.

**M4 controlled automation** — 200-example labeled eval set + holdout (50 Lacey Home / 25 Lacey Commercial / 50 Solis positives, 75 hard negatives); ≥90% priority precision; <3% duplicates; <2% expired; zero unsupported facts; 30–60 min review per account/week.

## Quality gates table (spec §19)

| Metric | Gate |
|---|---:|
| ID/address/date extraction | ≥98% |
| Priority precision before automation | ≥90% |
| Relevant opportunity recall | ≥80% |
| Correct project clustering | ≥95% |
| Duplicate deliveries | <3% |
| Expired deliveries | <2% |
| Working original-source links | ≥98% |
| Unsupported facts | 0 |

## Final acceptance (spec §23)

All P0 adapters evidenced/tested/backfilled/monitored; county + jurisdiction on every record; cross-source graph reviewable; account-specific routing; every fact evidenced (zero unsupported); permits never mislabeled as confirmed bids; digests change-aware and idempotent; feedback updates only versioned rules; red sources suppress unsafe deliveries; account-isolation tests pass; ≤2 hours human review per account/week.

## Calibration reminders (spec §22 — provisional, do not block M0–M2)

Pending answers from Lacey (King coverage, builder appetite, min lots/units, routing for apartments/townhomes, lead times) and Solis (entity/license renewal, detailed drywall/painting scope, capacity, min job size, preferred/blocked GCs, public-work constraints, invitation platforms). Keep affected rules provisional and versioned.
