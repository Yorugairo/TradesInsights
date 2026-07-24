# Plan: Opportunity payload — link the evidence, bind the contractors

## Summary
Solis has 477 high-scoring opportunities and almost nothing to act on: **346 of
them name no company at all**, the system holds **zero contacts**, and **zero of
88,407 evidence rows are linked to an opportunity**. The scoring works (218
distinct scores); the payload behind it does not. This plan links the evidence
that already exists to the opportunities that need it (Phase 2), and binds the
one org population that actually matters to a subcontractor — **the 215 primary
contractors, of which 0 are bound** (Phase 3).

## User Story
As Solis Interiors opening the product for the first time, I want each priority
opportunity to tell me **who is building it, how to reach them, and why I should
believe it**, so that my first session ends with a call rather than a shrug.

## Problem → Solution
A ranked list of projects with no company, no contact and no visible evidence →
opportunities that name the general contractor, carry their registry-verified
phone, and cite the A-grade record every claim rests on.

## Metadata
- **Complexity**: Large (two independent tracks; Phase 2 ships alone)
- **Source PRD**: N/A — follows `identifier-graph-scoring-calibration.plan.md` (complete)
- **Estimated files**: ~12

---

## Measured baseline (2026-07-24 — do NOT re-derive, re-verify only)

### Evidence exists; nothing links it
| Table | Rows | Shape |
|---|---|---|
| `evidence_items` | **88,407** (100% grade `A`) | `id, source_record_id, raw_artifact_id, fact_path, evidence_text, page_or_section, source_url, authority_grade, parser_version` |
| `opportunity_evidence` | **0** | `opportunity_id, evidence_item_id, claim_type, confirmed, confidence` |

The join path already exists and is already exercised by the publication gate:
`opportunities.project_id` → `record_resolutions` (`status='active'`) →
`source_record_id` → `evidence_items`.

### Org population — the binding ceiling is mostly structural
| Top role | Orgs | Bound | 2+ projects |
|---|---|---|---|
| applicant | 3,115 | 19 | 664 |
| other role | 467 | 1 | 72 |
| **primary_contractor** | **215** | **0** | 68 |

Most unbound "organizations" are **people**, not companies — a random sample of
unbound names: `BYRON MORALES`, `SERGIU PORTARU`, `CARLA GOCHICOA`,
`CHRISTINE L MISKIN`, `BLAGIKH IGOR`. They are homeowners pulling residential
permits and can never match a WA L&I contractor. Chasing the 3,797 is the wrong
target.

The 215 primary contractors are the right one — for an interiors subcontractor
the GC *is* the buyer — and **not one of them is bound**:
- 46 already have a pending candidate in the review queue (accept ⇒ 46 binds)
- **169 have no candidate at all**

Primary-contractor name sample: `WOLF INDUSTRIES INC`, `ADAIR HOMES INC`,
`ELEVATE PNW LLC`, `NEWAUKUM CONSTRUCTION LLC`, `BETTER WORKS CONSTRUCTION LP`,
`EMERALD CITY CONSTRUCTION & RENOVATIONS`, `FRANKLIN ROOFING` — real companies
that should exist in L&I — mixed with `LISA L PRICE`, `LUIS VERA`,
`TENANT: DESTINY SIMPSON`.

### Contacts
`organization_contacts` = **0 rows**. Contacts are written at
`packages/resolution/src/registry-observations.ts:1712` when a **phone-adoption
observation is accepted**. 23 are pending and none has ever been accepted, so
the table has never had a row. (Working those 23 is Phase 1, done by hand.)

### Solis opportunity bands
477 `priority_review` (80.0–98.5) · 786 `weekly_digest` · 1,782 `archive`.
Of the 477, **131 have any project role**; only 2 changed in the last 7 days.

---

## Mandatory Reading
| Priority | File | Why |
|---|---|---|
| P0 | `packages/intelligence/src/gate/gate.ts` (94–145) | The evidence join Phase 2 must reuse verbatim — `checkAGradeCoreEvent`, `checkFactsEvidenced` |
| P0 | `.claude/skills/evidence-gate/SKILL.md` | Authority grades, the "no claim without a source" rule, what may never be published |
| P0 | `packages/delivery/src/roi.ts` (96) | The ONLY existing reader of `opportunity_evidence` — its expectations define the shape |
| P0 | `packages/resolution/src/normalize.ts` (204–229) | `crossNameKey` (already folds `&`→`AND`) and `isGenericName` — Phase 3 must extend, not replace |
| P1 | `packages/resolution/src/registry-observations.ts` (729–1030) | The binding rules and where a person-shaped name must be refused |
| P1 | `apps/worker/src/cli/strict-bind.ts` | CLI shape: preview (dryRun, writes nothing) then `--apply` |
| P1 | `packages/intelligence/src/corporate-family.ts` | `personCoreKey` — the existing person-vs-business shape test to invert |

## Patterns to Mirror

### PURE_GATE — exported pure classifier + its own test file
// SOURCE: packages/resolution/src/registry-identifiers.ts + .test.ts
Policy lives in a pure, dependency-free function so it is testable without a
database; the script only gathers rows and applies it.

### PREVIEW_THEN_APPLY
// SOURCE: apps/worker/src/cli/strict-bind.ts
`strict-bind:preview` computes everything and writes NOTHING; `--apply` writes.
Both idempotent, both print the same counters, so preview numbers mean what
apply numbers mean.

### MEASURE_BEFORE_CHANGING
// SOURCE: this plan's predecessor, Phase 0
`strict-bind:preview` returning all-zero is what proved staleness was NOT the
cause and stopped a wasted week. Phase 3 opens with a diagnostic for the same
reason.

### SKIP_SAFE_READ
// SOURCE: packages/resolution/src/google-place-review.ts
Swallow only `42P01`; rethrow everything else so a permission error never
masquerades as "no data".

### IDEMPOTENT_UPSERT
// SOURCE: packages/resolution/src/registry-observations.ts (INSERT … ON CONFLICT)
Reruns are no-ops. Where a row may legitimately be recomputed, `DO UPDATE`
guarded by a `WHERE` that protects decided/human-touched state.

---

## NOT Building
- **No new evidence extraction.** 88,407 rows already exist; this links them.
- **No model calls.** The Phase 2 linker is a deterministic join. Model-assisted
  claim typing is explicitly out of scope (`evidence-gate` §13 keeps scores
  deterministic).
- **No auto-binding widening.** `evaluateStrictBind` stays untouched; Phase 3
  produces *candidates* for review, never silent binds.
- **No person→entity matching.** Person-shaped names are refused, not matched
  (standing governance: a principal is never a name match key).
- **No customer-facing UI in this plan.** Rendering evidence on the opportunity
  detail page is a follow-on once the data exists.
- **No contact scraping.** Contacts arrive only via the accepted-observation lane.

---

## Step-by-Step Tasks

### PHASE 2 — Link the evidence that already exists

#### Task 2.1: `claim_type` vocabulary (pure, testable)
- **ACTION**: New `packages/intelligence/src/opportunity-evidence.ts` exporting
  `classifyClaim({ factPath, authorityGrade })` → `{ claimType, confirmed, confidence }`.
- **IMPLEMENT**: Map `evidence_items.fact_path` onto the claim vocabulary the
  digest needs (`identity`, `stage`, `event_date`, `geography`, `value`,
  `organization_role`, `other`). `confirmed = true` ONLY for grade `A`; grade `C`
  is never confirmed alone; grade `D` is refused outright (discovery-only).
- **MIRROR**: PURE_GATE.
- **GOTCHA**: All 88,407 rows are currently grade `A`. Do NOT let that collapse
  the grade logic into `confirmed = true` — the D/C branches must exist and be
  tested, because the moment a non-A source lands they are the safeguard.
- **VALIDATE**: `vitest`; one case per grade and per fact-path family.

#### Task 2.2: The linker
- **ACTION**: New `packages/intelligence/src/link-opportunity-evidence.ts` +
  `apps/worker/src/cli/link-evidence.ts` (`--dry-run`, `--limit`, `--account=`).
- **IMPLEMENT**: For each opportunity, walk `project_id → record_resolutions
  (status='active') → evidence_items`, classify each row via Task 2.1, and insert
  into `opportunity_evidence` with `ON CONFLICT (opportunity_id, evidence_item_id)
  DO NOTHING`. Cap rows per opportunity (start 50, highest-grade first) so one
  noisy project cannot dominate the table.
- **MIRROR**: PREVIEW_THEN_APPLY + IDEMPOTENT_UPSERT.
- **GOTCHA**: Confirm the PK/unique constraint on `opportunity_evidence` before
  writing the `ON CONFLICT` target — the table has no rows and its constraints
  have never been exercised. Check `pg_constraint` first, exactly as the
  `partner_observations` CHECK had to be checked.
- **VALIDATE**: dry-run count ≈ opportunities × evidence-per-project; live run
  then rerun inserts 0; `roi.ts`'s query returns non-zero for a linked account.

#### Task 2.3: Reconcile against the publication gate
- **ACTION**: Add a `link-evidence --audit` mode reporting opportunities whose
  linked evidence would FAIL `checkAGradeCoreEvent` / `checkFactsEvidenced`.
- **WHY**: The gate says nothing may be published without A-grade support on the
  core event. If published opportunities fail that check, the gate is not being
  enforced on the publish path — a correctness defect worth knowing about, and
  cheaper to find now than after Solis reads a digest.
- **VALIDATE**: the audit reconciles: `linked + unlinkable = total`, with the
  unlinkable reasons enumerated, not lumped into "other".

---

### PHASE 3 — Bind the 215 primary contractors

#### Task 3.1: Diagnose the 169 with no candidate (measure first)
- **ACTION**: New `apps/worker/src/cli/binding-audit.ts` — read-only. For every
  primary-contractor org with no registry candidate, bucket the reason:
  `person_shaped` · `prefix_noise` (`TENANT:`, leading `*`) · `generic` ·
  `no_registry_name_match` · `ambiguous_multi_match`.
- **WHY**: MEASURE_BEFORE_CHANGING. "Improve matching" is unfalsifiable; "38 of
  169 are prefix noise" is a task. The split decides whether Task 3.3 is worth
  building at all.
- **VALIDATE**: buckets sum to 169; print 10 sample names per bucket for eyeballing.

#### Task 3.2: Refuse person-shaped org names (pure)
- **ACTION**: Export `isPersonShapedOrgName(name)` from
  `packages/resolution/src/normalize.ts`; skip those orgs in the binding loop.
- **IMPLEMENT**: Invert the existing `personCoreKey` test in
  `corporate-family.ts` (which already returns null for business-shaped names).
  A name with no business token (`LLC INC CORP LP PLLC CONSTRUCTION ROOFING …`)
  that parses as 2–3 personal-name tokens is person-shaped.
- **GOTCHA**: `LISA L PRICE` is person-shaped; `WOLF INDUSTRIES INC` is not;
  `FRANKLIN ROOFING` is NOT person-shaped despite looking like a surname — the
  trade token decides. Test all three.
- **WHY IT MATTERS BEYOND MATCHING**: it stops the queue proposing a homeowner↔
  contractor bind, which is both noise and a privacy hazard.
- **VALIDATE**: `vitest`; the refusal count matches Task 3.1's `person_shaped` bucket.

#### Task 3.3: Targeted matching improvements (SCOPE SET BY 3.1)
- **ACTION**: Only build what the diagnostic justifies. Candidates in likely order:
  strip prefix noise (`TENANT:`, `*`, `DBA `); try the registry ALIAS index for
  primary contractors (already loaded, currently only used after the canonical
  path fails); relax the suffix set in `orgNameKey`.
- **MIRROR**: extend `crossNameKey`, never fork it — a second normalizer that
  drifts is how match keys silently stop matching.
- **GOTCHA**: `crossNameKey` ALREADY folds `&`→`AND` and strips punctuation, so
  `EMERALD CITY CONSTRUCTION & RENOVATIONS` is not failing on the ampersand.
  Do not "fix" that.
- **VALIDATE**: rerun the observation generator; new candidates appear ONLY for
  primary contractors; `strict-bind:preview` still reports 0 auto-binds.

#### Task 3.4: Surface the primary-contractor lane in review
- **ACTION**: Add a "primary contractors" filter/select-group to
  `/app/admin/registry-review`, mirroring the existing `selectTier` grouping.
- **WHY**: 46 candidates are already sitting in a 278-row queue with no way to
  find the ones that matter most. This is the same one-click grouping argument as
  "select N address matches" on the Place queue.
- **MIRROR**: `RegistryReviewTable.selectTier` (registry-review/actions.tsx).
- **VALIDATE**: the group selects exactly the orgs Task 3.1 counts as primary
  contractors with a pending candidate.

---

## Testing Strategy
| Test | Expectation | Edge case |
|---|---|---|
| `classifyClaim` | grade A ⇒ confirmed | D refused; C unconfirmed without corroboration |
| linker dry-run | matches measured baseline | rerun inserts 0 |
| linker cap | ≤ N rows per opportunity, highest grade first | project with 500 evidence rows |
| `isPersonShapedOrgName` | `LISA L PRICE` true | `FRANKLIN ROOFING` false; `WOLF INDUSTRIES INC` false |
| binding audit | buckets sum to the input count | no bucket is a silent "other" |
| generator after 3.3 | new candidates are primary-contractor only | strict-bind preview still 0 |

## Validation Commands
```bash
pnpm -r run typecheck && pnpm exec eslint packages apps && pnpm exec vitest run packages/intelligence/src packages/resolution/src && pnpm --filter @otn/web run build
```
```bash
pnpm --filter @otn/worker exec tsx src/cli/link-evidence.ts --dry-run
```
```bash
pnpm --filter @otn/worker exec tsx src/cli/binding-audit.ts
```

## Acceptance Criteria
- [ ] `opportunity_evidence` is populated; `roi.ts`'s count query returns non-zero
- [ ] Every linked row's `confirmed` flag follows the authority grade, not the row count
- [ ] The gate audit reconciles and names every unlinkable reason
- [ ] Person-shaped org names are refused from binding, with the count matching the diagnostic
- [ ] Primary-contractor binding candidates are findable in one click in review
- [ ] `evaluateStrictBind` unchanged; `strict-bind:preview` still reports 0
- [ ] No new evidence extraction and no model calls introduced

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Linking 88k rows makes the detail page slow | Medium | Medium | Per-opportunity cap + index on `(opportunity_id)`; measure before rendering |
| The gate audit reveals published opportunities lacking A-grade support | **Medium** | **High** | That is a finding, not a failure — report it; do not silently "fix" by relaxing the gate |
| Task 3.3 yields few new binds because the 169 genuinely are not in L&I | **High** | Medium | 3.1 measures this FIRST; if `no_registry_name_match` dominates, stop after 3.2 and say so |
| Accepting 46 candidates binds a wrong entity | Low | High | Review-only; the 46 are human-decided, and Phase 2 of the last plan made those rows rankable |

## Notes
Phase 2 and Phase 3 are independent and can ship in either order. Phase 2 is the
surer value — the data is already there and the join is already written inside
the gate. Phase 3's ceiling is genuinely unknown until Task 3.1 runs, which is
exactly why 3.1 is read-only and comes first.

The 23 pending phone-adoption observations (Phase 1, worked by hand) are the
only path to the first `organization_contacts` row. Neither phase below creates
contacts; they make the *opportunity* legible and bind the *company*. "Who to
call" needs Phase 1 to have happened.
