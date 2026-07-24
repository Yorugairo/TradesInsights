# Plan: Evidence audit, person-shaped refusal, and Google re-score plumbing

## Summary

Three independent tracks that can all land while the Google Place scrape drains,
none of which depends on its output: an audit that checks linked evidence against
the publication gate's OWN functions instead of a reimplementation; a refusal that
stops the binding queue proposing homeowner↔contractor matches; and the registry
contract view + Insights reader that make the reject re-score a one-command job
once the scrape finishes.

## User Story

As the operator of the OTN/Insights seam, I want the gate cross-check, the
person-shaped refusal, and the Google re-score plumbing built and tested tonight,
so that the morning's re-score is a single command against a complete dataset
rather than a build.

## Problem → Solution

| Current | Desired |
|---|---|
| Gate conformance only measurable via hand-written SQL that duplicates `gate.ts` | An `--audit` mode calling the gate's own checks |
| Binding loop proposes person-shaped orgs (privacy hazard + noise) | Person-shaped names refused before candidate generation |
| Re-score needs a build before it can run | Plumbing ready; morning is one command |
| `opportunity_evidence_opp_ix` documented as "redundant" | Documented accurately — it is NOT redundant (measured) |

## Metadata
- **Complexity**: Medium
- **Source PRD**: N/A — continues `opportunity-payload-evidence-and-binding.plan.md`
  (Phase 2 Tasks 2.1/2.2 complete and live; this covers 2.3, 3.2, and re-score plumbing)
- **Estimated files**: ~11 (2 registry, 9 Insights)
- **Scope note**: Tasks 3.1, 3.4 and the ROI-metric fix were offered and NOT selected.

---

## RESOLVED BEFORE PLANNING: the index question

The instruction was "drop `opportunity_evidence_opp_ix` **if it's genuinely
without value**." It is not. **Do not drop it.**

I claimed it was redundant because `opportunity_id` leads the new unique index.
That reasoning is theoretically sound and empirically wrong. Measured live:

| Index | Size | Role |
|---|---|---|
| `opportunity_evidence_opp_ix` | 960 kB | Chosen for full-row lookups by opportunity |
| `opportunity_evidence_opp_item_ux` | 4,504 kB | `ON CONFLICT` arbiter; index-only scans |

`EXPLAIN (ANALYZE)` on `SELECT claim_type, confirmed, confidence … WHERE
opportunity_id = $1` picks **`opp_ix`**, because the unique index does not cover
those columns and is 4.7× wider to traverse. That query is precisely the follow-on
this data exists for — rendering evidence on an opportunity detail page.

The unique index still wins where it covers the projection (`SELECT
opportunity_id, evidence_item_id` → index-only scan, 0 heap fetches). Two indexes,
two jobs, both earning their keep.

**Consequence**: Task A below corrects the two comments that assert redundancy.
Leaving known-false documentation in a migration is worse than the original error.

---

## UX Design

**Internal change — no user-facing UX transformation.** All three tracks are CLI,
library, and database-contract work. Task D deliberately builds no UI; the Place
review UI is out of scope here.

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `packages/intelligence/src/gate/gate.ts` | 95–178 | The two checks Task B must call, not reimplement |
| P0 | `packages/resolution/src/principal-person.ts` | 37–133 | `BUSINESS_TOKENS`, `parsePersonName`, `personCoreKey` — Task C is a wrapper over these |
| P0 | `packages/resolution/src/registry-identifiers.ts` | 176–219 | `classifyGoogleConfirmation` — the ONE authority Task D must score through |
| P0 | `<registry>/apps/registry/supabase/migrations/20260725020000_trades_identifiers_contract_view.sql` | all | The exact contract-view + GRANT pattern Task D mirrors |
| P0 | `packages/resolution/src/google-place-review.ts` | 1–96 | SKIP_SAFE_READ; the reader shape Task D mirrors |
| P1 | `packages/resolution/src/registry-observations.ts` | 750–760 | The binding loop Task C guards |
| P1 | `packages/intelligence/src/link-opportunity-evidence.ts` | all | Where `--audit` plugs in |
| P2 | `apps/worker/src/cli/link-evidence.ts` | all | CLI flag/logging shape |

**Registry worktree**: `C:\Users\Snipe\Downloads\WA JiuJitsu Registry-20260608T183757Z-3-001\.claude\worktrees\trades-google-place-integration-v2`, branch `release/trades-staging`.

## External Documentation

No external research needed — every pattern is established internally.

---

## Measured baseline (2026-07-24 — re-verify, do not re-derive)

### Gate conformance is already clean
| Measure | Value |
|---|---|
| Distinct projects behind opportunities | 6,007 |
| Opportunities whose project has no event | **0** |
| Active resolutions carrying no evidence | **0** |
| Projects whose core event lacks A-grade evidence | **0** |
| Projects passing the core-event check | **6,007 / 6,007** |

**Task B will report zero failures.** That is the finding, not a reason to skip it:
the number above came from SQL that *duplicates* `gate.ts`'s logic, which is the
drift this task exists to remove. Its lasting value is reconciliation and
regression detection once non-A sources land.

### `personCoreKey` already decides every case Task C needs
Run against the real function, not asserted:

| Input | Verdict |
|---|---|
| `LISA L PRICE` | PERSON → `PRICE|LISA` |
| `WOLF INDUSTRIES INC` | business |
| `FRANKLIN ROOFING` | business (trade token decides) |
| `ADAIR HOMES INC`, `ELEVATE PNW LLC`, `NEWAUKUM CONSTRUCTION LLC` | business |
| `EMERALD CITY CONSTRUCTION & RENOVATIONS` | business |
| `LUIS VERA`, `BYRON MORALES`, `CHRISTINE L MISKIN` | PERSON |
| `CHEHALIS SHEET METAL`, `SOUTH SOUND SOLAR`, `COLUMBIA POOLS`, `BUTLER SURVEYING` | business |
| `TENANT: DESTINY SIMPSON` | PERSON → **`SIMPSON|TENANT`** ← defect, see Task C GOTCHA |

### Google scrape state (live, still climbing)
| Measure | Value |
|---|---|
| Candidate rows / distinct places | 49,849 / 27,621 |
| Places with a scraped name | 16,495 |
| Rows with name AND phone | 33,187 |
| Rows with `entity_id` set | 40,607 |
| **Scorable rows** (`entity_id` + `scraped_name`) | **29,081** |
| Still pending | 14,978 |
| Blocked | **0** |

---

## Patterns to Mirror

### CONTRACT_VIEW_AND_GRANT
// SOURCE: registry `20260725020000_trades_identifiers_contract_view.sql:39-67`
```sql
CREATE OR REPLACE VIEW registry_public.trades_identifiers_v1
WITH (security_invoker = false) AS
SELECT ...
 WHERE i.vertical_key = 'trades'
   AND e.vertical_key = 'trades'
   AND e.status = 'active';

COMMENT ON VIEW registry_public.trades_identifiers_v1 IS '...';

-- Least-privilege read for the seam. Deliberately NO grant to
-- anon/authenticated/public — see the header.
GRANT USAGE ON SCHEMA registry_public TO otn_insights_reader;
GRANT SELECT ON registry_public.trades_identifiers_v1 TO otn_insights_reader;
```

### SKIP_SAFE_READ
// SOURCE: `packages/resolution/src/google-place-review.ts:10-14, 22, 94-96`
```ts
/** Postgres `undefined_table` — the only error this module swallows. */
const UNDEFINED_TABLE = "42P01";

function isMissingRelation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === UNDEFINED_TABLE;
}
```
A missing view degrades to empty because the Insights deploy and the registry
migration are not atomic. EVERY other error rethrows.

### PURE_GATE
// SOURCE: `packages/resolution/src/registry-identifiers.ts:198-219`
```ts
export function classifyGoogleConfirmation(input: {
  lniPhone: string | null | undefined;
  googlePhone: string | null | undefined;
  lniName: string | null | undefined;
  googleName: string | null | undefined;
}): GoogleConfirmation {
  ...
  if (phoneAgrees && nameAgrees) return "phone_and_name";
  if (phoneAgrees) return "phone_only";
  ...
}
```

### PREVIEW_THEN_APPLY
// SOURCE: `apps/worker/src/cli/link-evidence.ts:35-40`
```ts
const apply = process.argv.includes("--apply");
const logger = createLogger({ app: apply ? "link-evidence-apply" : "link-evidence-preview" });
```

### BINDING_LOOP_GUARD_POINT
// SOURCE: `packages/resolution/src/registry-observations.ts:750-755`
```ts
const unbound = (await loadOrgFacts(db)).filter((o) => o.registry_ref === null);
for (const org of unbound) {
  ...
  const key = crossNameKey(org.canonical_name);
```

### TEST_STRUCTURE
// SOURCE: `packages/intelligence/src/opportunity-evidence.test.ts:1-30`
```ts
import { describe, expect, it } from "vitest";
const MEASURED_FACT_PATHS = [ ["statusRaw", "stage"], ... ] as const;
describe("claimTypeForFactPath", () => {
  it.each(MEASURED_FACT_PATHS)("types %s as %s", (factPath, expected) => { ... });
});
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `packages/db/migrations/0033_opportunity_evidence_indexes.sql` | UPDATE | Correct the false redundancy claim |
| `packages/db/src/schema.ts` | UPDATE | Same correction on the declaration |
| `packages/intelligence/src/gate/gate.ts` | UPDATE | Export the two checks |
| `packages/intelligence/src/link-opportunity-evidence.ts` | UPDATE | `auditOpportunityEvidence` |
| `packages/intelligence/src/link-opportunity-evidence.test.ts` | UPDATE | Reconciliation tests |
| `apps/worker/src/cli/link-evidence.ts` | UPDATE | `--audit` flag |
| `packages/resolution/src/principal-person.ts` | UPDATE | `isPersonShapedOrgName` |
| `packages/resolution/src/principal-person.test.ts` | UPDATE | Refusal tests |
| `apps/worker/src/cli/person-shape-report.ts` | CREATE | Read-only report; replaces the binding-loop guard |
| `<registry>/apps/registry/supabase/migrations/20260726010000_google_place_scrape_contract_view.sql` | CREATE | Expose scraped observations |
| `packages/resolution/src/google-place-scrape.ts` | CREATE | Insights reader + scorer |
| `packages/resolution/src/google-place-scrape.test.ts` | CREATE | Scorer tests |

## NOT Building

- **No re-score RUN.** Plumbing only; the run wants all 27,621 places, not tonight's partial 16,495.
- **No auto-binding.** `evaluateStrictBind` untouched. The re-scorer produces review candidates.
- **No UI.** Neither the Place review page nor Task 3.4's primary-contractor lane.
- **No index drop.** Resolved above — it is not valueless.
- **No changes to `scrape-google-place-batches.mjs` or `google-place-watchdog.ps1`.**
  The watchdog relaunches dead workers every 15 minutes and would pick up edits mid-run.
- **No ROI-metric fix**, no Task 3.1, no Task 3.3 — not selected.

---

## Step-by-Step Tasks

### Task A: Correct the redundancy claim (do first — it is a known falsehood)
- **ACTION**: Rewrite the "NOTE ON REDUNDANCY" block in
  `0033_opportunity_evidence_indexes.sql` and the matching comment at
  `packages/db/src/schema.ts` (the `opportunityEvidence` index array).
- **IMPLEMENT**: State the measured truth — the narrow index is chosen for
  full-row lookups by `opportunity_id`; the unique index wins where it covers the
  projection. Cite the sizes (960 kB vs 4,504 kB) and both roles.
- **GOTCHA**: `0033` is already applied. Its DDL must NOT change — comments only.
  It is `CREATE UNIQUE INDEX IF NOT EXISTS`, so a re-run stays a no-op.
- **VALIDATE**: `pnpm db:migrate` reports success and adds nothing;
  `pg_indexes` still shows exactly two indexes.

### Task B: `--audit` against the gate's own checks (Task 2.3)
- **ACTION**: Export `checkAGradeCoreEvent` and `checkFactsEvidenced` from
  `gate.ts`; add `auditOpportunityEvidence(db, opts)` to
  `link-opportunity-evidence.ts`; add `--audit` to the CLI.
- **IMPLEMENT**: Resolve each opportunity's `project_id`, dedupe to the 6,007
  distinct projects, call BOTH checks per project (memoised by `projectId`), and
  report: opportunities passing, failing per check with the check's own `detail`
  string, and a reconciliation block asserting
  `linked + unlinkable = pairsConsidered` with `unlinkable` broken out by reason
  (`discovery_only_grade`, `unknown_grade`, `capped`).
- **MIRROR**: PREVIEW_THEN_APPLY for the flag/logging shape; the existing
  `LinkEvidenceSummary` field naming.
- **IMPORTS**: `import { checkAGradeCoreEvent, checkFactsEvidenced } from "./gate/gate.js";`
- **GOTCHA 1**: `checkFactsEvidenced` takes a third argument
  `extraction: ModelExtraction | null`. Pass `null` — the audit tests the
  deterministic layer. Passing a fabricated extraction would test nothing real.
- **GOTCHA 2**: Memoise by `projectId`. 9,128 opportunities map to 6,007 projects;
  without memoisation this is ~18k queries instead of ~12k, for identical answers.
- **GOTCHA 3**: Expect **zero failures**. Do not "fix" anything if the audit is
  clean — clean is the measured, correct answer today.
- **VALIDATE**: `pnpm --filter @otn/worker link-evidence:audit` reports
  6,007 projects checked, 0 failing, and a reconciliation that balances exactly.

### Task C: MEASURE person-shaped org names — refuse nothing (Task 3.2, descoped)

> **DESCOPED FROM REFUSAL TO REPORT-ONLY (owner decision, 2026-07-24).** The
> original task skipped person-shaped orgs in the binding loop. Measurement showed
> that filter would destroy **12.9% of every available name match** — 33 of 256 —
> and the safeguard that would have made it safe is structurally unavailable at
> today's L&I coverage. See "Why this is report-only" below. **Turning refusal on
> is gated on the full L&I load** (roadmap P6).

- **ACTION**: Export `isPersonShapedOrgName(name, knownSurnames?)` from
  `principal-person.ts`. Add a read-only `person-shape-report` CLI. **Do NOT
  modify the binding loop.**
- **IMPLEMENT**:
  ```ts
  export function isPersonShapedOrgName(
    raw: string | null | undefined,
    knownSurnames?: ReadonlySet<string>,
  ): boolean {
    return personCoreKey(raw, knownSurnames) !== null;
  }
  ```
  Plus `apps/worker/src/cli/person-shape-report.ts` — read-only. Classify every
  unbound org, cross-reference the registry name index, and print: how many are
  person-shaped, how many of those WOULD have matched a registry entity (the cost
  of refusing), and the matched names so the denylist gaps are visible.
- **MIRROR**: PREVIEW_THEN_APPLY (report has no apply); the `strict-bind.ts`
  registry-pool-null guard.
- **DEVIATION FROM THE PARENT PLAN**: the parent plan put this in
  `normalize.ts`. It belongs in `principal-person.ts`, where `parsePersonName`,
  `BUSINESS_TOKENS` and `personCoreKey` already live. A wrapper in `normalize.ts`
  would import across for no benefit and split one decision across two modules.

#### Why this is report-only (measured 2026-07-24 — do not re-derive)

| Measure | Value |
|---|---|
| Unbound orgs | 3,777 |
| Person-shaped | 2,376 (62.9%) |
| Person-shaped **that match a registry entity by name** | **33** |
| Non-person-shaped that match | 223 |
| **Share of all name matches a refusal would destroy** | **12.9%** |
| Primary contractors refused | 21 of 215 (9.8%) |

The 33 are overwhelmingly real companies — `JOHNSON CONTROLS`, `CINTAS FIRE
PROTECTION`, `JH KELLY`, `RESCUE ROOTER` (9 projects), `WASHINGTON GENERATORS`
(7), `APEX TREE EXPERTS` (6). Exactly one (`FERNANDO RAMIREZ`) reads as a person.
**Seven of the 33 are "X FIRE PROTECTION"** — the same trade as the Patriot/Smith
Fire case that started this workstream.

Cause: more `BUSINESS_TOKENS` gaps — `PROTECTION`, `GENERATORS`, `ROOTER`,
`FURNACE`, `CONTROLS`, `EARTHWORK`, `TECHNOLOGIES`, `ALARM`, and `ROOF`
(singular; `ROOFING` is present). `BUILDINGS` and `SIGN` are missing while
`BUILDING` and `SIGNS` are present.

**The safeguard is unavailable at today's coverage.** "A registry name match
proves it is a business" only fires for companies already loaded. L&I is at
**26,934 / 75,364 = 35.7%**, and the dropped 48,290 were CC:01 generals — the
registry holds **3,074 general_contractor entities out of ~51,000, roughly 6%**.
Phase 3's target population IS general contractors, so coverage is thinnest
exactly where the safeguard is needed most. Extrapolating 33 matches at 35.7%
coverage implies **~92 real businesses** among the refusals; only 33 are visible
today, and the GC skew makes the true figure worse than linear.

**The refusal is a standing filter, not a destructive act** — it re-evaluates on
every run and deletes nothing. But it is also NOT self-healing: it reads the
*Insights* org name, while Google enrichment improves *registry* entity names, so
a refused org never reaches the matcher no matter how good the registry gets.
That is the reason to leave it off rather than "turn it on and fix it later".

- **GOTCHA 1 — `TENANT: DESTINY SIMPSON`**: `cleanNameChars` strips the colon,
  yielding `SIMPSON|TENANT` — "TENANT" parsed as the given name. Report it; do NOT
  fix the prefix noise here. That is Task 3.3's job and changing the key would
  move rows in the principal lane.
- **GOTCHA 2**: `FRANKLIN ROOFING` must stay a business despite the surname —
  `ROOFING` is in `BUSINESS_TOKENS`. Test it, it is the one people get wrong.
- **GOTCHA 3**: when refusal is eventually enabled, pass `knownSurnames`. The
  module states the denylist "can never be finished" and the surname ALLOWLIST is
  "what actually makes the gate sound". It rescues `HEROES`, `CREW`, `BUILDINGS`,
  `EXTERIORS`, `SPA` — but NOT `PROJECTS BY PIPER`, since Piper is a real surname.
  It narrows the tail; it does not remove it.
- **VALIDATE**: `vitest` covers the parent-plan cases plus the live names that
  slipped the denylist; the report runs read-only; **`registry-observations.ts` is
  untouched** and `strict-bind:preview` still reports 0 auto-binds.

### Task D: Google scrape contract view + Insights scorer (item 5)
- **ACTION**: Registry migration exposing scraped observations; Insights reader
  and pure scorer. **No run.**
- **IMPLEMENT (registry)**: `registry_public.google_place_scrape_v1`, one row per
  `(google_place_id, lni_license_number)` candidate carrying `entity_id`,
  `scraped_name`, `scraped_phone`, `scrape_status`, `fetched_at`, scoped
  `vertical_key='trades'`, `entity_id IS NOT NULL`, `scraped_name IS NOT NULL`.
  Then `COMMENT ON VIEW` + both GRANTs.
- **IMPLEMENT (Insights)**: `packages/resolution/src/google-place-scrape.ts`
  exporting `GOOGLE_PLACE_SCRAPE_VIEW`, a `loadGooglePlaceScrapeRows(pool)`
  reader, and `scoreGooglePlaceCandidates(rows, identityRows)` that pairs each
  scraped row with its registry entity's L&I name/phone and calls
  `classifyGoogleConfirmation`. Return counts by verdict plus the
  `phone_and_name` rows as review candidates.
- **MIRROR**: CONTRACT_VIEW_AND_GRANT; SKIP_SAFE_READ; PURE_GATE.
- **IMPORTS**: `import { classifyGoogleConfirmation } from "./registry-identifiers.js";`
- **GOTCHA 1 — THE WHOLE POINT**: score ONLY through
  `classifyGoogleConfirmation`. The triage numbers I quoted earlier came from SQL
  that re-implemented `crossNameKey`; a second normalizer that drifts is how match
  keys silently stop matching. No name comparison in SQL.
- **GOTCHA 2 — `CREATE OR REPLACE VIEW` cannot insert a column mid-list.** New
  columns append LAST, and a replace can drop privileges — always re-assert the
  GRANTs, as the existing migration does.
- **GOTCHA 3**: `registry_public` is NOT web-public. Grant to
  `otn_insights_reader` ONLY — never anon/authenticated/public.
- **GOTCHA 4**: the view is over a table being written continuously by four
  scrapers. `CREATE VIEW` takes no meaningful lock, but the row counts will move
  between runs — assert on shape, never on a frozen total.
- **GOTCHA 5 — `phone_only` is circular.** 2,962 of 2,980 existing links were made
  BY matching that phone. Only `phone_and_name` is real confirmation; report
  `phone_only` separately and never treat it as identity.
- **VALIDATE**: migration applies; as `otn_insights`, `SELECT` on the new view
  succeeds and `registry_internal` still denies with **42501**; the Insights reader
  returns rows; `vitest` covers the scorer including the circular case; **no
  re-score is run**.

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected | Edge? |
|---|---|---|---|
| refuses person-shaped | `LISA L PRICE` | `true` | |
| keeps business | `WOLF INDUSTRIES INC` | `false` | |
| trade token beats surname | `FRANKLIN ROOFING` | `false` | ✓ |
| denylist survivors stay business | `COLUMBIA POOLS`, `BUTLER SURVEYING` | `false` | ✓ |
| allowlist narrows refusal | `LUIS VERA` + surname set without `VERA` | `false` | ✓ |
| prefix noise still refused | `TENANT: DESTINY SIMPSON` | `true` | ✓ |
| null/empty | `null`, `""` | `false` | ✓ |
| audit reconciles | linked + unlinkable | `= pairsConsidered` | |
| scorer: real confirmation | phone + name agree | `phone_and_name` | |
| scorer: circular | phone agrees, name differs | `phone_only` | ✓ |
| scorer: comma/case variance | `Smith Fire Systems Inc` vs `Smith Fire Systems, INC` | `phone_and_name` | ✓ |

### Edge Cases Checklist
- [ ] Empty input (`null`, `""`, whitespace) to the refusal
- [ ] View absent → reader returns empty, does not throw (42P01 only)
- [ ] Permission error (42501) → **rethrows**, never silently empty
- [ ] Opportunity with 0 evidence rows in the audit
- [ ] Row counts shift mid-run because the scrape is still writing
- [ ] Re-running the audit changes nothing (read-only)

---

## Validation Commands

### Static Analysis
```bash
npx tsc --noEmit -p packages/resolution/tsconfig.json
```
EXPECT: zero errors (repeat for `packages/intelligence`, `packages/db`, `apps/worker`)

### Unit Tests
```bash
npx vitest run packages/resolution packages/intelligence
```
EXPECT: all pass, including the new refusal and scorer tests

### Database Validation
```bash
pnpm db:migrate
```
EXPECT: success, nothing new applied (Task A is comments only)

### Seam Validation
```bash
pnpm --filter @otn/worker link-evidence:audit
```
EXPECT: 6,007 projects checked, 0 failing, reconciliation balances

### Manual Validation
- [ ] As `otn_insights`: `SELECT` on `google_place_scrape_v1` succeeds
- [ ] As `otn_insights`: `registry_internal` still denies with 42501
- [ ] `strict-bind:preview` still reports 0 auto-binds
- [ ] Four scraper workers still alive; `blocked` still 0

---

## Acceptance Criteria
- [ ] Task A: no comment anywhere claims `opp_ix` is redundant
- [ ] Task B: audit uses the gate's exported checks, not a reimplementation
- [ ] Task C: report-only — `registry-observations.ts` is NOT modified, nothing is refused
- [ ] Task D: every name comparison goes through `classifyGoogleConfirmation`
- [ ] No re-score executed; no auto-binding widened; no scraper file touched
- [ ] Types, lint, and tests clean; both repos committed and pushed

## Completion Checklist
- [ ] Patterns mirrored, not reinvented
- [ ] GRANTs re-asserted after any view replace
- [ ] No hardcoded values; thresholds named
- [ ] No `TODO`/debug statements
- [ ] Commits pushed immediately (shared origin is the handoff point)

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Refusal drops a real contractor from the queue | **Measured: certain** | High | **Eliminated — Task C refuses nothing.** Enabling refusal is gated on the full L&I load (roadmap P6) |
| Report-only leaves homeowner noise in the queue | High | Low | Accepted. Noise is visible and reviewable; a silent drop is not. 2,343 of the 2,376 match nothing anyway, so they generate no name-lane candidate to be noisy with |
| Exporting gate internals invites reuse that skips `evaluateGate` | Low | Medium | Export the two checks only; document that `evaluateGate` remains the entry point |
| Contract view replace silently drops privileges | Medium | High | Re-assert both GRANTs in the same migration; verify as `otn_insights` |
| SQL name comparison creeps into the scorer | Medium | High | No name logic in SQL; the view ships raw `scraped_name` and TS decides |
| Watchdog relaunches a worker into edited scraper code | Low | High | Those two files are explicitly out of scope |
| Audit numbers shift because the scrape writes concurrently | High | Low | Task B touches no registry table; Task D asserts shape, not totals |

## Notes

- **Task B's headline answer is already known and clean** (0/6,007 failing). Its
  value is replacing hand-written SQL with the authority, plus the reconciliation
  and regression detection. If that is not worth the build, Task B is the one to cut.
- **Task C is much smaller than the parent plan implies** — `personCoreKey` already
  decides every case correctly, and the task is now report-only. Budget accordingly.
- **Task C's real output is a backlog argument, not a filter.** It quantifies what
  the L&I gap costs: at 35.7% coverage (6% for GCs) a name-shape heuristic cannot
  be made safe, because the evidence that would overrule it is not loaded. That is
  now roadmap **P6**, and this measurement is its justification.
- **Task D is the long pole** and the one with real morning value.
- Recommended order: **A → C → D → B**. A is a correction and cheap; C is small and
  self-contained; D is the long pole and wants the most runway; B is last because
  its answer is already measured.
- Insights trunk `claude/tmux-install-320aiz`; registry trunk `release/trades-staging`.
  Never target `main`.
