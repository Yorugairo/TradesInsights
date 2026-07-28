# Implementation Report: Data hygiene round 2

**Plan**: `.claude/PRPs/plans/completed/data-hygiene-round-2.plan.md`
**Branch**: `claude/tmux-install-320aiz`
**Date**: 2026-07-28
**Baseline artifact**: `docs/data-quality-audit-2026-07-28.md` (generated from a live hosted run)

## Summary

Org-name quality became one classifier and one column instead of five copied
regexes; the `same_address_name_mismatch` review bucket got labelled by what
evidence it actually has; the trade-tag NULL count became readable; and the
hand-run audit became `pnpm audit:data` with a committed baseline. Applied to
hosted production in the designed order, with the view proven unchanged at every
step.

## Assessment vs reality

| Metric | Predicted (plan) | Actual |
|---|---|---|
| Complexity | Medium-Large, ~14 files, 6 tasks, 2 migrations | 6 tasks, 2 migrations, **17 files** |
| Files changed | ~14 | 17 (7 created, 10 updated) |
| Tests | per-task | **+34** (1,261 → 1,295), 125 files green |
| Confidence | — | Single pass; three plan premises corrected mid-flight (below) |

## Tasks completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | `name_quality` classifier, 0039, resolver stamp, backfill, 0040 view | Complete | Deviated — see D1, D2 |
| 2 | `reclassifyComparanda` + CLI + review-page facet | Complete | Deviated — see D3, D4 |
| 3 | Trade-tag residue visibility | Complete | As planned (additive summary) |
| 4 | `pnpm audit:data` + baseline doc | Complete | Deviated — see D5, D6 |
| 5 | Junk-org verification sweep | Complete | **Found 16 violators** — the assumption of zero was wrong |
| 6 | Close-out: suites, eval, hosted apply, docs | Complete | — |

## Validation results

| Level | Status | Notes |
|---|---|---|
| Type check | Pass | `pnpm typecheck`, zero errors |
| Lint | Pass | `pnpm lint`, zero errors — confirms the plan's note that the "28 real errors" memory was stale |
| Unit + integration | Pass | 1,295/1,295 across 125 files |
| E2E | Pass | 33/33 Playwright, including the admin review-queue spec |
| Eval gate | **Byte-identical** | precision 1, recall 0.9609375, Solis 22/22 — no scoring input moved |
| Hosted apply | Pass | 0039 → 0040 → backfill → reclassify; view unchanged at every step |

### The acceptance measurement that mattered

`insights_public.cockpit_opportunities_v1`, hosted, three times:

| Stage | rows | with `gc_name` | distinct GCs |
|---|---|---|---|
| Before 0039/0040 | 4,251 | 1,100 | 551 |
| After 0040, **0 rows stamped** | 4,251 | 1,100 | 551 |
| After backfill (6,220 stamped) | 4,251 | 1,100 | 551 |

The middle row is the one the migration was designed to produce: applying the
view swap ahead of the backfill changes nothing, so apply-order is a preference
rather than a hazard.

## Deviations from plan

**D1 — the gate had five definitions, not one.** The plan's D1 said the regexes
were encoded "ONLY in `cockpit_opportunities_v1`". They are byte-identical in
migrations 0025 (twice: the cockpit view and `cockpit_gc_league_v1`), 0026, 0027
and 0028, plus a TypeScript transcription in
`packages/intelligence/src/org-activity.ts`. This strengthened the round's
premise rather than weakening it. The sibling views were left untouched
deliberately — one view proves the column in production before the rest follow.
`packages/intelligence/src/scoring.ts` also carries the entity token list and was
**not** touched: it is a scoring input, and the plan forbids that.

**D2 — the cockpit view's current owner is 0027, not 0026.** The plan's P0
reading pointed at 0026. 0027 re-created the same view to append the three
corroboration columns. Rebuilding 0040 from 0026 would have silently dropped
`corroborated_source_count`, `stage_depth` and `has_contradiction` from the
cockpit. 0040 is built from 0027's definition with the WHERE clause changed and
the SELECT list byte-identical.

**D3 — the review queue is mostly comparable, not evidence-starved.** The plan
expected ≈784 rows tagged `awaiting org_evidence`. Measured on hosted: 776 rows
(8 decided since planning), of which **596 (77%) carry organization names on the
candidate project** and were left actionable, **164** have no organization at all,
and **16 upgraded**. The plan's GOTCHA said a wildly-off count means the
detection drifted and to cross-check with `pnpm review name-audit` — done: it
reports the identical 776 rows and still 100% `none`, so the population is right
and only the composition assumption was wrong.

**D4 — `close` accepted alongside `exact`/`contained`.** The plan listed
`exact|contained` as the upgrade condition. A 0.85 similarity is stronger
evidence than token containment, and since the pass decides nothing, admitting it
can only put more evidence in front of a human. In the event, all 16 upgrades
were `contained` and every one is correct on inspection (`"City of Ruston Grid
Resilience Project"` ↔ `CITY OF RUSTON`; `"FRITTS, JUDITH DIANE …"` ↔ `FRITTS
JUDITH DIANE`).

**D5 — the audit CLI was split in two.** `apps/worker/src/data-audit.ts` holds
the queries and judgements; `apps/worker/src/cli/data-audit.ts` is the
entrypoint. A test cannot import a module whose `main()` fires on import.

**D6 — the pure classifier test lives beside its source.** The plan put
`org-name-quality.test.ts` under `apps/worker/test/`; every other pure test in
`packages/resolution` sits next to the module. DB-touching tests stayed in
`apps/worker/test/`.

**D7 — "never geocode-attempted" was three facts.** The audit's first version
reported a single conflated 554 and read like a fleet failure. Split into
never-asked-with-address (**2** — the only backlog, and exactly the plan's
figure), no-address-to-geocode (552) and asked-no-match (646). A test asserts the
four coverage buckets sum to the project count.

## Issues encountered

- **Drizzle expands a JS array binding into N placeholders**, so `= ANY($2..$366)`
  failed outright. Ids now travel as one `jsonb` parameter through
  `jsonb_array_elements_text` — the `project-trades.ts` idiom.
- **`jsonb_build_object` takes `"any"`**, so an untyped bind parameter fails
  analysis with 42P18. Every value passed to it is cast `::text`.
- **A JS template literal eats `\.`**, which would have sent `CO.` (matching
  COX/COM) to Postgres instead of `CO\.` in the backfill's self-check. Escaped
  and commented at the site.
- **`db.execute<T>` constrains `T` to `Record<string, unknown>`**, which
  interfaces do not satisfy implicitly. Row shapes are type aliases.

## Findings that outlive this round

**The junk tier is not clean.** T5 assumed zero violators. Hosted found **16
junk-classified organizations carrying identifiers, 2 registry-bound** —
`123 ELECTRIC SERVICE INC`, `365 PLUMBING`, `AUBURN SCHOOL DISTRICT NO 408`,
`BETHEL SCH DIST #403`, `KENT SCHOOL DISTRICT 415`, `SNOQUALMIE VALLEY SCHOOL
DISTRICT #410`, and eight more. All are false positives of the inherited
`[0-9]{3,}` rule: real companies and school districts whose names contain a
number. **Not a regression** — the same regex has excluded them from GC surfaces
since migration 0025 — but the exclusion is now named instead of buried in a view
body. Left as an owner decision per the plan's "no deletions, ever"; the violator
list is the test set for narrowing the rule in round 3.

## Files changed

| File | Action |
|---|---|
| `packages/resolution/src/org-name-quality.ts` | CREATED |
| `packages/resolution/src/org-name-quality.test.ts` | CREATED |
| `packages/db/migrations/0039_org_name_quality.sql` | CREATED |
| `packages/db/migrations/0040_cockpit_view_name_quality.sql` | CREATED |
| `apps/worker/src/cli/backfill-org-quality.ts` | CREATED |
| `apps/worker/src/data-audit.ts` | CREATED |
| `apps/worker/src/cli/data-audit.ts` | CREATED |
| `apps/worker/test/review-reclassify.test.ts` | CREATED |
| `apps/worker/test/data-audit.test.ts` | CREATED |
| `docs/data-quality-audit-2026-07-28.md` | CREATED |
| `packages/db/migrations/meta/_journal.json` | UPDATED |
| `packages/db/src/schema.ts` | UPDATED |
| `packages/resolution/src/index.ts` | UPDATED |
| `packages/resolution/src/resolver.ts` | UPDATED |
| `packages/resolution/src/review.ts` | UPDATED |
| `packages/resolution/src/review-triage.test.ts` | UPDATED |
| `packages/resolution/src/project-trades.ts` | UPDATED |
| `apps/worker/src/cli/review.ts` | UPDATED |
| `apps/worker/test/cockpit-views.test.ts` | UPDATED |
| `apps/web/app/app/admin/review/page.tsx` | UPDATED |
| `package.json`, `apps/worker/package.json` | UPDATED |
| `docs/STATUS.md` | UPDATED |

## Tests written

| Test file | Tests | Area |
|---|---|---|
| `packages/resolution/src/org-name-quality.test.ts` | 11 | Classifier precedence, anchoring, digits, absent names |
| `packages/resolution/src/review-triage.test.ts` | +1 | `awaiting` tag overrides a decidable reason |
| `apps/worker/test/review-reclassify.test.ts` | 5 | Three outcomes, dry-run purity, idempotency, never-decides |
| `apps/worker/test/cockpit-views.test.ts` | +1 | Residue ranked and partitioned; tagging unchanged |
| `apps/worker/test/data-audit.test.ts` | 9 | Invariants fail, metrics never do; coverage buckets sum |

## Next steps

- Owner call on narrowing the `[0-9]{3,}` junk rule (16 named false positives).
- Valuation parser work, ranked by the audit's per-source null-rate table.
- Strict view predicate swap (`name_quality = 'business'`), round 3.
- Re-run `pnpm audit:data` and diff against the committed baseline.
