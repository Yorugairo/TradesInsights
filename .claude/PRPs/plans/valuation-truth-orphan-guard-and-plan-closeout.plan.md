# Plan: Valuation truth, orphan regression guard, and plan close-out

> **Working doc + source of truth.** Every number below was measured against hosted
> production (`arbmeioglflvzoffgtii`) on **2026-07-28** during planning. Where a measurement
> contradicts an earlier claim — including one I made an hour ago — the measurement wins and
> the earlier claim is named and retired here.

## Summary

Two of this round's three requested workstreams **do not exist as defects**. There is no
valuation parser bug in any of the five sources I ranked last turn: every null is the source
publishing nothing, a zero, or a permit fee. And the 31 orphan projects + 15 mis-merged parcel
matches have **already self-healed** — production carries zero split permits. What is left is
real but different: the audit's own per-source table *ranks absence as if it were failure* and
must stop doing that; the orphan repair needs a standing invariant so it cannot silently
return; Bellevue has a genuine valuation-coverage question that is about ingestion scope, not
parsing; and nine shipped plans are still sitting in `plans/` reading as open work.

## User Story

As **the operator**, I want the audit to point only at things that are actually broken, the
healed split-permit defect to be guarded rather than remembered, and the plan directory to tell
the truth about what is done — so that the next round's priorities come from evidence instead
of from a table that mistakes silence for failure.

## Problem → Solution

An audit that ranks `bellevue 100% null` next to a real extraction gap sends the next session
to write a parser for a field the city does not publish. → A per-source split into **stated /
not published / DROPPED**, where only the third is a bug, plus a hard invariant on split
permits and an honest plans directory.

## Metadata

- **Complexity**: Medium (~9 files, 6 tasks, **0 migrations**)
- **Source PRD**: N/A — standalone, from the `data-hygiene-round-2` baseline
- **Repo**: TradesInsights — **pnpm**. Branch `claude/tmux-install-320aiz`.
- **Scoring**: nothing here touches a scoring input. `pnpm eval:run` must stay byte-identical.

---

## GROUND TRUTH — production measurements, 2026-07-28

### The valuation "backlog" is not a backlog

Per-source, `source_records` joined to its `raw_fields_json`:

| Source | records | `valuationUsd` stated | what the RAW record actually carries |
|---|---|---|---|
| `bellevue_permits_arcgis` | 4,018 | **0** | `VALUATION` key present on every row, **non-empty on 1**, and that one is `0` |
| `puyallup_permits_arcgis` | 1,228 | **0** | only `FeeAmount` (1,166 rows) — a **permit fee**, not construction value |
| `olympia_smartgov_reports` | 1,023 | **0** | **no** valuation-shaped field at all |
| `pierce_permits_arcgis` | 6,423 | 1,596 | `buildingValuation` on 1,655 → **96% of what exists is captured** |
| `king_permit_reports` | 1,920 | 469 | `jobValue` on all 1,920 — **every null is a literal `"0"`** |
| `tacoma_permits_arcgis` | 4,393 | 3,031 | (control — healthy) |

The King breakdown is decisive. Every one of the 1,451 nulls is `jobValue = "0"` on a trade
permit the county prices at zero:

```
jobValue "0"  Building/Mechanical/Residential/NA                767
jobValue "0"  Building/Residential Building/Addition-Improvement/NA  110
jobValue "0"  Fire/Fire Permit Systems/Sprinkler/Residential     89
jobValue "0"  SiteDevCA/Critical Areas Designation/Formal/NA     57
```

The adapters are already right, and deliberately so — `king-permit-reports.ts:277` reads
`jobValue > 0 ? jobValue : null`, and `arcgis-permits.ts:143` documents the rule: *"0/negative
valuation is 'not stated' (unknown), never $0."* Mapping Puyallup's `FeeAmount` to
`valuationUsd` would be outright fabrication.

**RETIRED CLAIM (mine, 2026-07-28, same day):** *"Valuation parsers… the biggest single lever
on lead quality"* with those five sources ranked by null rate. The ranking was produced by
`docs/data-quality-audit-2026-07-28.md`'s per-source table, which counts `valuationUsd IS NULL`
without asking whether anything was published to extract. **That table is the defect this round
fixes.**

### The split-permit defect is gone

| Check | Result |
|---|---|
| PALS records originally resolved `new_project` | 31 — **all 31 now sit on the same project as their ArcGIS twin** |
| PALS records originally resolved `parcel_overlap` | 15 — **all 15 now sit on the same project as their twin** |
| PALS records resolved `official_id` | 392, all converged |
| **External ids mapping to >1 active project (graph-wide, all public sources)** | **0** |
| `project_external_ids` rows conflicting across projects | **0** |
| Projects with no active resolution (stranded shells) | **0** |

Pass 1b (`pendingReviewForSamePermit`) plus `reevaluatePendingReviews` did exactly what their
headers claimed: *"self-heals both ways."* `matched_rule` is the rule recorded **at resolution
time** and is now historical — the current `project_id` is what matters, and it agrees
everywhere.

**RETIRED CLAIM:** `docs/STATUS.md` — *"OPEN, owner call: the 31 existing orphan projects and
the 15 mis-merged parcel matches are left in place… each a latent split."* No longer true. There
is nothing to repoint and nothing to delete.

### Plans that are shipped but still filed as open

Report present, plan un-archived: `cockpit-ui-first-class-product` (phases 0–3),
`gym-market-comparator-windowed-peers`, `puget-sound-source-expansion`, `queue-cockpit`
(A0/B/C/D), `registry-insights-dataflow-solis-inference`,
`registry-insights-golive-taxonomy-warmnet-sources`, `source-fleet-flow-verification`,
`webs-omwbe-solicitation-ingestion`, and `cockpit-seam-performance-and-degradation` (its report
is named `cockpit-seam-performance-report.md` — **prefix matching misses it**).

**`trades-read-model-verticalization` is NOT closeable**: its only report is
`…-task1-report.md`. A report is not proof of completion.

Genuinely open, no report: `bid-timing-strike-zone`, `calibration-question-audit`,
`e2e-local-corpus`, `insights-registry-integration-solis`,
`opportunity-payload-evidence-and-binding`, `registry-insights-parity-and-activation`,
`solis-onboarding-single-surface`.

---

## UX Design

Internal + one operator-facing report change.

| Touchpoint | Before | After |
|---|---|---|
| `pnpm audit:data` valuation section | per-source `% without valuation` — ranks silence as failure | three buckets per source: **stated / not published / DROPPED**, with only DROPPED framed as work |
| `pnpm audit:data` invariants | 3 invariants | 4 — split permits joins them, so the healed defect fails loudly if it returns |
| `.claude/PRPs/plans/` | 17 files, 9 of them finished | 8 files, all genuinely open |
| `docs/STATUS.md` | carries an "OPEN, owner call" item that is closed | closed with the evidence that closed it |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `apps/worker/src/data-audit.ts` | all (~390) | Tasks 1 and 4 both edit it; the invariant/metric split is its whole design |
| P0 | `apps/worker/test/data-audit.test.ts` | 1-70 | The `healthy()` fixture must gain every new field; the "metrics never fail" property is the test that matters |
| P1 | `packages/adapters/src/arcgis-permits.ts` | 138-150, 275-290, 430-470 | `positive()` (the 0-is-unknown rule), `firstPositive` use, and `BELLEVUE_CONFIG`'s `valuation: "VALUATION"` mapping — proof the mapping is already correct |
| P1 | `packages/adapters/src/king-permit-reports.ts` | 205-215, 270-315 | `jobValue > 0 ? jobValue : null` and the evidence row it emits — the same rule, independently implemented |
| P1 | `config/sources.yaml` | the `bellevue_permits_arcgis` block (~179-215) | The claim Task 3 tests: *"VALUATION (35,468 rows carry it all-time; populated at/after issuance)"* and the 120-day trailing window |
| P2 | `apps/worker/src/cli/data-audit.ts` | all (48) | Thin entrypoint — keep it thin |
| P2 | `docs/data-quality-audit-2026-07-28.md` | all | The baseline being corrected; Task 6 regenerates it |
| P2 | `.claude/PRPs/reports/data-hygiene-round-2-report.md` | all | Where the retired claims came from, so the correction lands in the right place |

## External Documentation

None. **GOTCHA recorded instead:** Bellevue's ArcGIS FeatureServer honours
`returnCountOnly=true` with a `where` clause, so Task 3's coverage question can be answered with
count-only requests — no bulk fetch, no ingestion change, nothing written. Do not "just backfill
and see".

---

## Patterns to Mirror

### THE_RULE_THAT_MAKES_THE_NULLS_CORRECT
```ts
// SOURCE: packages/adapters/src/arcgis-permits.ts:143-146 (verbatim)
/** Positive-or-null: 0/negative valuation is "not stated" (unknown), never $0. */
function positive(n: number | null): number | null {
  return n !== null && n > 0 ? n : null;
}
```
```ts
// SOURCE: packages/adapters/src/king-permit-reports.ts:277 (verbatim)
valuationUsd: Number.isFinite(jobValue) && jobValue > 0 ? jobValue : null,
```
Two adapters, one rule, independently written. **Nothing in this plan changes it.** The audit
must be taught to agree with it instead of reporting its correct output as a gap.

### AUDIT_SECTION_SHAPE
```ts
// SOURCE: apps/worker/src/data-audit.ts (collect(), verbatim shape)
const valuationBySource = await many(
  db,
  sql`SELECT s.key AS source,
             count(*) AS records,
             count(*) FILTER (WHERE sr.normalized_json ->> 'valuationUsd' IS NULL)
               AS without_valuation
      FROM source_records sr
      JOIN sources s ON s.id = sr.source_id AND s.account_profile_id IS NULL
      GROUP BY 1 ORDER BY 2 DESC`,
);
```
This is the query being replaced. Same helpers (`one`/`many`/`num`/`str`/`pct`), same
`FILTER (WHERE …)` idiom, same `account_profile_id IS NULL` public-source scoping.

### INVARIANT_SHAPE
```ts
// SOURCE: apps/worker/src/data-audit.ts:345-365 (verbatim)
export function failedInvariants(a: DataAudit): string[] {
  const failures: string[] = [];
  if (a.invariants.corroborationNull > 0) {
    failures.push(
      `corroboration NULL on ${a.invariants.corroborationNull} project(s) — the derivation pass has not run`,
    );
  }
  …
  return failures;
}
```
Every message names **what broke and what it means**, never just a number. Task 4 adds one
entry in exactly this shape.

### TEST_FIXTURE_SHAPE
```ts
// SOURCE: apps/worker/test/data-audit.test.ts (verbatim)
/** A clean audit: every invariant satisfied, every metric deliberately ugly. */
function healthy(over: Partial<DataAudit> = {}): DataAudit { … }

it("passes a graph whose metrics are ugly but whose invariants hold", () => {
  expect(failedInvariants(healthy())).toEqual([]);
});
```
The new fields go into `healthy()` at their **worst real production values**, so the "metrics
never fail" property is tested against reality rather than against zeros.

### CLI_SHAPE
```ts
// SOURCE: apps/worker/src/cli/reap-runs.ts:19-31 (verbatim)
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  …
  const logger = createLogger({ app: "reap-runs-cli" });
  const pool = createPool();
  const db = createDb(pool);
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `apps/worker/src/data-audit.ts` | UPDATE | Valuation three-bucket split (T1); `splitExternalIds` invariant (T4) |
| `apps/worker/test/data-audit.test.ts` | UPDATE | New fields in `healthy()`; DROPPED-is-not-fatal; split-permit IS fatal |
| `docs/data-quality-audit-2026-07-28.md` | UPDATE | Regenerated from a fresh hosted run + a correction block |
| `docs/STATUS.md` | UPDATE | Close the orphan item with its evidence; record this round |
| `config/sources.yaml` | UPDATE | Bellevue notes gain the valuation-coverage measurement (T3) — **notes only unless T3's gate says otherwise** |
| `.claude/PRPs/plans/*.plan.md` → `completed/` | MOVE | 9 shipped plans (T5) |
| `.claude/PRPs/reports/valuation-truth-orphan-guard-and-plan-closeout-report.md` | CREATE | Round report |
| `~/.claude/.../memory/data-hygiene-round-2.md` | UPDATE | Retire the valuation-parser recommendation it records |
| `~/.claude/.../memory/data-quality-phases-1235.md` | UPDATE | Retire the orphan/mis-merge open item |

## NOT Building

- **No adapter changes.** Not one of the five sources has an extraction bug. Touching
  `positive()` or a field map to "improve coverage" would fabricate valuations.
- **No `FeeAmount → valuationUsd` mapping.** A permit fee is not construction value. If a
  future round wants fee-derived estimates they belong in a separate, clearly-labelled field
  that scoring does not read.
- **No orphan remediation script.** There are zero orphans. Writing a repair tool for a healed
  defect is how you get a tool that damages healthy data the next time it runs.
- **No Bellevue backfill in this round.** T3 measures and decides; ingestion-window changes are
  a separate plan with its own fixtures and health gates.
- **No scoring changes.** Valuation feeds scoring; every number here is reporting only.
- **Not the GitHub Actions secrets**, and not the `source-fleet.yml` step-gating bug (the guard
  fails, then later steps still run and hit `pnpm: command not found`). Both are real, both are
  out of scope here — the secrets are owner-only, and the gating fix belongs with them.
- **No archiving of `trades-read-model-verticalization`** — only task 1 has a report.

---

## Step-by-Step Tasks

### Task 1: teach the audit the difference between absence and failure
- **ACTION**: Replace the per-source valuation null-rate with a three-bucket split.
- **IMPLEMENT**: In `data-audit.ts`, `valuation.bySource` rows become
  `{source, records, stated, notPublished, dropped}` where:
  - `stated` = `normalized_json->>'valuationUsd' IS NOT NULL`
  - `dropped` = normalized is NULL **but** the raw record carries a positive numeric under a
    valuation-shaped key — the only bug bucket
  - `notPublished` = `records - stated - dropped`

  Detect the raw value generically so a new source is covered the day it lands:
  ```sql
  EXISTS (
    SELECT 1 FROM jsonb_each_text(sr.raw_fields_json) AS kv(k, v)
    WHERE (kv.k ILIKE '%valuation%' OR kv.k ILIKE '%jobvalue%'
           OR kv.k ILIKE '%projectvalue%' OR kv.k ILIKE '%constructioncost%')
      AND kv.v ~ '^[0-9]+(\.[0-9]+)?$'
      AND kv.v::numeric > 0
  )
  ```
  Render as `stated / not published / DROPPED`, sorted by `dropped` descending so the actionable
  bucket leads. Print the standing caveat next to it, mirroring the `person_or_unknown` note:
  *"`not published` is the source's choice, not our gap — a permit priced at $0 by the
  jurisdiction is not a missing valuation. Only DROPPED is work."*
- **MIRROR**: AUDIT_SECTION_SHAPE; the caveat-next-to-the-number style already in `render`.
- **IMPORTS**: none new.
- **GOTCHA**: the key pattern must **exclude** fee-shaped keys. `FeeAmount` must NOT count as a
  dropped valuation or Puyallup's 1,166 fee rows become a phantom 1,166-row backlog — the exact
  failure this task exists to prevent. The `ILIKE` list above is an allow-list for that reason;
  do not relax it to `%amount%` or `%cost%`.
- **GOTCHA**: `kv.v ~ '^[0-9]+…'` before `::numeric` — Bellevue stores `VALUATION` as text and an
  unguarded cast raises `22P02` on the first empty string.
- **VALIDATE**: hosted run shows **`dropped = 0` for all six measured sources**; Puyallup shows
  1,228 `not published` and 0 `dropped`; King shows 469 stated / 1,451 not published / 0 dropped.
  A non-zero `dropped` anywhere means the allow-list caught something real — investigate before
  shipping.

### Task 2: confirm the 59-row Pierce residue is the zero rule, not a gap
- **ACTION**: Explain the one gap the table shows: `buildingValuation` present on 1,655 Pierce
  rows, `valuationUsd` stated on 1,596.
- **IMPLEMENT**: No code. Run the query, record the answer in the round report:
  ```sql
  SELECT nullif(sr.raw_fields_json->>'buildingValuation','') AS raw, count(*)
  FROM source_records sr JOIN sources s ON s.id = sr.source_id AND s.key='pierce_permits_arcgis'
  WHERE sr.normalized_json->>'valuationUsd' IS NULL
    AND nullif(sr.raw_fields_json->>'buildingValuation','') IS NOT NULL
  GROUP BY 1 ORDER BY 2 DESC LIMIT 10;
  ```
- **MIRROR**: n/a — measurement.
- **GOTCHA**: if the 59 are **not** all `0`/negative, Task 1's `dropped` bucket will already have
  flagged them and this becomes a real adapter bug — in which case **STOP and re-plan**, because
  "no adapter changes" was premised on this being the zero rule.
- **VALIDATE**: the 59 reconcile as ≤0 values (expected), or the round's scope is corrected in
  writing before any code is touched.

### Task 3: answer the Bellevue coverage question without changing ingestion
- **ACTION**: Test the config's own claim — *"VALUATION (35,468 rows carry it all-time;
  populated at/after issuance)"* — against the fact that our 4,018-row slice carries **one**
  non-empty VALUATION, and that one is `0`.
- **IMPLEMENT**: Count-only probes against the live FeatureServer (no ingestion, nothing stored):
  total rows; rows with `VALUATION > 0`; rows with `VALUATION > 0` restricted to the trailing
  120-day `APPLIEDDATE OR ISSUEDDATE` window the adapter uses; and the same split by
  `PERMITSTATUS`. Use `returnCountOnly=true&f=json` with a `where` clause and the configured
  `SOURCE_USER_AGENT`. Write the four numbers into the `bellevue_permits_arcgis` `notes:` block
  in `config/sources.yaml`, dated, in the style of the existing 2026-07-27 correction note.
  **Then stop and state the decision**, one of:
  - *valuation fills long after issuance* → a widened window is a future plan with its own
    fixtures, and Bellevue's zero is honest today;
  - *valuation is present in-window and we are missing it* → Task 1's `dropped` bucket would
    already be non-zero, contradicting its validation, so re-plan.
- **MIRROR**: the existing dated-correction style in that same `notes:` block.
- **GOTCHA**: **read-only, count-only.** Do not run `source:backfill` to find out — a backfill
  writes artifacts and records and cannot be undone cheaply.
- **GOTCHA**: this is a live third-party endpoint. If it is unreachable, record that and move on;
  an unanswered question written down beats a guess.
- **VALIDATE**: four dated numbers in `config/sources.yaml` and a one-line decision in the round
  report. No adapter or window change ships in this round either way.

### Task 4: make the healed split-permit defect impossible to lose
- **ACTION**: Promote "no permit id maps to two projects" from a hand-run query to a hard
  invariant.
- **IMPLEMENT**: Add `invariants.splitExternalIds` to `DataAudit`, computed graph-wide over
  active resolutions of **public** sources:
  ```sql
  (SELECT count(*) FROM (
     SELECT sr.external_id
     FROM record_resolutions rr
     JOIN source_records sr ON sr.id = rr.source_record_id
     JOIN sources s ON s.id = sr.source_id AND s.account_profile_id IS NULL
     WHERE rr.status = 'active'
     GROUP BY sr.external_id
     HAVING count(DISTINCT rr.project_id) > 1) d) AS split_external_ids
  ```
  Add the matching `failedInvariants` entry:
  *"N permit id(s) resolve to more than one project — a split permit; pass 1b exists to prevent
  exactly this."*
- **MIRROR**: INVARIANT_SHAPE.
- **GOTCHA**: **`external_id` is only unique within a source.** Two jurisdictions can legitimately
  issue the same permit number, and grouping on `external_id` alone would then report a false
  split. Group on `(sr.source_id, sr.external_id)` and emit the pair in the failure message.
  *(The plain-`external_id` form above measured 0 in planning, so no such collision exists today —
  but "0 today" is not "impossible tomorrow", and this invariant will outlive the observation.)*
- **GOTCHA**: it must be an **invariant**, not a metric. This is the one place in the audit where
  a non-zero count is unambiguously a bug.
- **VALIDATE**: unit test — 0 passes, 1 fails with the permit id named; hosted run still reports
  `INVARIANTS OK`.

### Task 5: make the plans directory tell the truth
- **ACTION**: Archive the plans that are genuinely finished; leave the rest alone.
- **IMPLEMENT**: For each of the 17 files in `.claude/PRPs/plans/`, decide with **three** checks,
  not one: (a) a report exists — **search by content, not filename prefix**
  (`cockpit-seam-performance-and-degradation` → `cockpit-seam-performance-report.md`); (b)
  `docs/STATUS.md` describes it as shipped; (c) the plan's own Acceptance Criteria are met by
  what the report claims. All three ⇒ `git mv` to `completed/`. Expected set (9): the eight
  listed in GROUND TRUTH plus `cockpit-seam-performance-and-degradation`. For any plan that is
  partially done — **`trades-read-model-verticalization` at minimum**, whose only report covers
  task 1 — append a dated one-line status note at the top of the plan naming what remains, and
  leave it in `plans/`.
- **MIRROR**: `git mv` into `.claude/PRPs/plans/completed/`, as done for `data-hygiene-round-2`.
- **GOTCHA**: a report is not proof of completion. Multi-phase plans (`queue-cockpit` has A0/B/C/D
  reports; `cockpit-ui-first-class-product` has 0/1/2/3) are complete only if **every** phase the
  plan defines has one. `queue-cockpit` in particular is recorded elsewhere as "phases C/B/D
  shipped, **A+E backlogged**" — if the plan defines an E, it does not archive.
- **GOTCHA**: `git mv`, never `mv` — the rename must be one tracked operation.
- **VALIDATE**: `ls .claude/PRPs/plans/*.plan.md` lists only genuinely-open plans; every archived
  file has its report named in the round report; `git status` shows renames, not delete+add.

### Task 6: close-out
- Regenerate `docs/data-quality-audit-2026-07-28.md` from a fresh hosted `pnpm audit:data` and
  add a dated **"Correction"** block recording that the per-source null table was reframed and
  why (this plan's GROUND TRUTH, compressed).
- `docs/STATUS.md`: close the orphan/mis-merge item with the evidence that closed it
  (0 split external ids, 0 stranded projects, 46/46 PALS records converged); add this round.
- Memory: retire the valuation-parser recommendation in `data-hygiene-round-2`; retire the
  orphan open-item in `data-quality-phases-1235`. **Declared, not deleted** — both memories keep
  the reasoning and gain a `RETIRED <date>` line.
- Gates: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:e2e`, **`pnpm eval:run`
  byte-identical** (precision 1, recall 0.9609375, Solis 22/22).
- Round report; archive this plan.

---

## Testing Strategy

| Test | Input | Expected | Edge |
|---|---|---|---|
| valuation buckets partition | any source row | `stated + notPublished + dropped == records` | the assertion that catches a mis-scoped `dropped` |
| `dropped` is a METRIC | `healthy()` with `dropped: 99` | `failedInvariants` returns `[]` | a source-quality fact never exits 1 |
| fee keys excluded | raw `{FeeAmount: "450"}`, normalized null | counted `notPublished`, **not** `dropped` | Puyallup's 1,166 rows |
| zero excluded | raw `{jobValue: "0"}`, normalized null | `notPublished` | King's 1,451 rows |
| non-numeric excluded | raw `{VALUATION: ""}` | `notPublished`, no cast error | Bellevue's 4,017 empties |
| split permits IS an invariant | `splitExternalIds: 1` | one failure naming the permit | the healed defect returning |
| split permits clean | `splitExternalIds: 0` | `[]` | production today |
| render leads with DROPPED | `healthy()` | sorted by `dropped` desc; caveat text present | the operator reads top-down |

Edge checklist: empty `raw_fields_json`; a source with zero records (division guard in `pct`);
`dropped` non-zero (must not crash render); plans directory already empty of shipped plans
(Task 5 idempotent — a second run moves nothing).

## Validation Commands

```bash
pnpm typecheck
```
```bash
pnpm lint
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
pnpm audit:data
```
EXPECT `INVARIANTS OK`, `dropped = 0` across every source, and `split permits 0`.

Manual: `ls .claude/PRPs/plans/*.plan.md`; `git status` shows renames; the Bellevue numbers are
in `config/sources.yaml` with a date.

## Acceptance Criteria
- [ ] Six tasks done; all commands pass; eval byte-identical
- [ ] `dropped` is 0 on hosted for every source — and if it is not, the scope was re-planned in
      writing before any adapter was touched
- [ ] Split-permit invariant present, tested both ways, and green on hosted
- [ ] 9 plans archived; partially-done plans annotated, not archived
- [ ] Both retired claims corrected in STATUS **and** memory, with the evidence
- [ ] Zero adapter changes

## Completion Checklist
- [ ] No fabricated valuations; `positive()`/`> 0` rules untouched
- [ ] Audit still separates invariants from metrics — one new invariant, one reframed metric
- [ ] Bellevue probe was count-only; nothing ingested
- [ ] New code indistinguishable from `data-audit.ts` as it stands
- [ ] No scope added (secrets, workflow gating, ingestion windows all left out)

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| The `dropped` key allow-list catches a fee-shaped field and invents a backlog | Medium | High — this is the exact failure being fixed | Explicit allow-list, no `%amount%`/`%cost%`; a test asserts `FeeAmount` lands in `notPublished` |
| `external_id` collides across jurisdictions ⇒ false split-permit failure | Low today (measured 0) | High — a false invariant gets muted | Group on `(source_id, external_id)`; emit the pair in the message |
| A plan is archived while work remains | Medium | Medium — invisible backlog | Three-check rule; `trades-read-model-verticalization` and `queue-cockpit` named as traps |
| Bellevue endpoint unreachable at implementation time | Medium | Low | Record the failure; the decision is deferred, not guessed |
| Text-to-numeric cast on empty strings | High if unguarded | Medium — audit crashes | Regex guard before `::numeric`, with a test |

## Notes

This round's real product is **a report that stops lying about what is broken**. Round 2 shipped
an audit whose per-source valuation table I then used, within the hour, to recommend a week of
parser work against sources that publish nothing. The table was accurate and the inference from
it was wrong — which is the failure mode a metric has when it counts an outcome without counting
whether the input existed. Every bucket added here answers "was there anything to extract?"
before "did we extract it?".

The orphan finding is the happier version of the same lesson: a defect recorded as open in
STATUS had been fixed by machinery shipped for a different reason, and only a fresh measurement
revealed it. The guard in Task 4 exists so the next person does not have to re-derive that.

Round-4 seeds, deliberately deferred: the Bellevue ingestion window (pending Task 3's numbers);
`source-fleet.yml` step gating after the secrets guard fails; the junk-digit-rule narrowing from
round 2 (16 named false positives, still an owner call); the strict `name_quality = 'business'`
view predicate.

## Plan history

**2026-07-28 — v1.** Written measurement-first. Two of the three requested workstreams were
disproven during planning and are recorded as retired claims rather than quietly dropped: there
is no valuation parser defect (all five "100% null" sources publish nothing, a zero, or a fee),
and the 31+15 split-permit population has fully self-healed (0 split external ids graph-wide).
The plan that remains is the honest residue: fix the metric that produced the wrong
recommendation, guard the defect that fixed itself, answer the one real coverage question
without changing ingestion, and tell the truth in `plans/`.
