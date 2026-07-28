# Implementation Report: Cockpit UI — Phase 3 (retrofit)

Executed 2026-07-27. **Phase 3 complete. The plan is now fully delivered.**

## Summary

Every page in `apps/web` now renders through the shell and the proof primitives.
The measurable target — static inline styles — went from **281 to 2**, and both
survivors are dynamic values with comments saying why.

The retrofit was supposed to be a re-skin. It surfaced four real defects instead,
three of them live in production, and each was found by doing the conversion
rather than by looking for bugs.

| Metric | Plan | Actual |
|---|---|---|
| Tasks | 3.1–3.9 | all complete |
| Commits | one per page | 8 (one deviation, recorded) |
| `style={{` | → 0 | **281 → 2**, both justified |
| e2e | 28 green after each | 28/28, every commit |
| Unit | — | 1237/1237 (50 in apps/web) |

## Commits

| SHA | Task | Page |
|---|---|---|
| `4864cfe` | 3.1 | Opportunities list |
| `d9a1790` | 3.2 | Opportunity detail |
| `63f76af` | 3.3 | Pipeline |
| `475028d` | 3.4 | Pursuits |
| `d197935` | 3.5, 3.6 | Radar, Map |
| `c281b2d` | 3.7 | ROI |
| `1e2a93f` | 3.8a | Queue cockpit, Sources |
| `dc2b716` | 3.8b, 3.9 | Admin queues + the sweep |

## Defects found by doing the work

**1. `corroboration` was typed wrong, and the detail page had been lying.**
`apps/web/lib/queries.ts` declared `{ sources: string[] }`. The writer
(`resolution/src/corroboration.ts:96`) emits `sourceCount: number`, and so do
both other consumers (`delivery/src/digest.ts:718`,
`intelligence/src/score-run.ts:181`). The field was therefore always `undefined`,
the `>= 2` branch on the detail page was unreachable, and **every project
rendered "Single public source so far"** regardless of how many sources
corroborated it. Measured against production: 500 of 500 rows carried a real
corroboration record; 0 rendered as measured.

The general lesson is worth more than the instance: a hand-written TS type over a
`jsonb` column is an unverified claim. The cast succeeds, the optional field
reads `undefined`, and the UI takes the "we have nothing" branch forever. It is
now pinned by a test containing a verbatim production row.

**2. Two pages held both database connections at once.** The pool max is 2. The
opportunities list (my own change) and the ROI page (pre-existing, four reads)
each used `Promise.all`, so one page held every connection for the duration of
its slowest query and starved everything else. This is documented in detail
below because the diagnosis went wrong first.

**3. Three live contrast failures on admin pages.** All the same shape as the
`Badge` fix in Phase 2 — values authored for a white page:

- `registry-review`: tier pills as pastel fills, and `FOCUS_BG = "#eef6ff"`
  painting the keyboard-focused row near-white. The one row an operator steers
  with `j`/`k` was the one row they could not read.
- `corporate-families`: a corroboration signal that AGREES rendered `#111`
  (near-black), one that disagrees `#a00`. On a dark surface the agreeing case
  vanished — and weighing agreement against disagreement is the whole job there.
- `source-runs` / `google-place`: `#f7f7f7` code blocks, `#137333` success text.

**4. A component declared inside a render.** `TriState` lived in `FeedbackForm`'s
body, so every keystroke in the notes field created a new component type and
React remounted all four selects, dropping focus.

## The diagnosis I got wrong

Worth recording because the wrong answer was plausible for two runs.

Task 3.1's e2e came back with three failures — a login POST that never returned,
`/app/radar` that never navigated, and `/app/admin/cockpit` returning **500 via
`statement_timeout` (57014)**. None of those pages import anything the change
touched. I called it environmental.

It was not. Stashing the work and running the same suite on `HEAD` in the same
minute gave **28/28 in 1.2m**. The failures were mine: `Promise.all` on a pool of
2. Sequential reads plus dropping an unnecessary `projects` join restored 1.3m
and 28/28.

Two things to carry forward. **"The failure is on a page I didn't touch" is
evidence about the mechanism, not evidence of innocence** — on a shared
connection pool that is exactly the signature. And the control run is cheap:
seven minutes bought certainty that two more speculative re-runs would not have.

## Deviations from plan

**1. Tasks 3.5 and 3.6 share one commit.** The plan says one page per commit.
Radar and Map were converted and gated in a single e2e run. They are small and
touch disjoint testids, but this is a real reduction in bisectability and it was
a speed decision.

**2. `ScoreBar` is a new component; `RangeBar` was not used on the list.** The
plan asked for the score to render as a number plus a `RangeBar`. RangeBar draws
low → typical → high. A score has no spread — it is one number on a fixed 0–100
scale. Feeding it through RangeBar would draw a band that does not exist. The
replacement plots the score against the **account's own configured**
`priority_review_min` / `weekly_digest_min`, so the bar explains the banding
instead of decorating it.

**3. No `SourceChip` per row on the opportunities list.** The list has no source
list to name — the corroboration jsonb stores a count, not publishers. A
`ConfidenceMeter` renders what is actually stored. SourceChips did land on the
detail page's evidence chain, where each row has a real named publisher.

**4. Valuation stayed off the list.** `max_valuation` is not a column; it is a
lateral aggregate over `source_records`. Running it for 100 rows to add one
nice-to-have column is the wrong trade on the flagship page.

**5. `PageHeader` gained `titleTestId`, `StatTile` gained `valueTestId`.**
Two testids (`opportunity-title`, `pursuit-count`) name a specific element.
Parking them on a wrapper would keep the tests green while changing what they
point at. `StatTile.value` deliberately stayed `string | number | null` — widening
it to `ReactNode` so a caller could pass a `<span>` would also let a caller route
around the em-dash-for-absent rule.

## Honesty fixes carried along

The retrofit kept turning up places where the UI said something it could not
support. None were in scope; all were one-line:

- The first empty state I wrote **lied**: it read "no rows in this scope" as
  "this account has never been scored", so a mistyped search told an operator
  their account had no data. `EmptyState` requires a `reason` so an empty table
  cannot be silent — a confidently wrong reason is worse than the silence. Now
  extracted to `empty-reason.ts` with six tests.
- Pursuits: an empty board says pursuits are opened by hand, so empty means none
  were started — not that none were found.
- ROI: the outcomes ledger, the first-look sample floor ("withheld, not absent"),
  and "no recent records" styled apart from a real zero lag.
- Sources: "never succeeded" is its own tile, not folded into amber/red.
- Radar: unstated valuation is an em dash, not `$0`.
- The facts-vs-inferences panel no longer describes a two-column contrast when
  there is no extraction to contrast.

## Still outstanding

- [ ] **e2e runs against the hosted production database.** `workers: 1` remains a
      compensating control, not a fix. This is the last piece of the Phase 1
      finding and it needs a seeded local corpus.
- [ ] **`/app/admin/cockpit` takes 9.6–21s and 500s rather than degrading** when
      it crosses `statement_timeout`. Pre-existing and independent of this work —
      my extra query was merely enough to tip it during one run. The page's own
      doctrine ("seam offline, never a fake zero") already covers the case; a
      timeout should render as "we could not measure this in time".
- [ ] Facts-vs-inferences was verified against real extractions (5 of 8 sampled
      opportunities carry them, with inferences), but no opportunity in the
      sample had a generated `brief`, so the inference-inside-prose treatment is
      unverified against live data.
