# Plan: Identifier graph + scoring calibration

## Summary
Every independent Insights and Registry source should meet on a shared
**identifier**. Today they mostly don't: the registry carries `contractor_number`,
`ubi`, and 105 `root_domain` rows — while **100% of entities have a registered
address and 99.95% have an L&I phone that are not identifiers at all**, and 2,941
enrichment websites sit unpromoted. That gap is also why the trust score cannot
rank: its `identifier` component is pinned at a constant, and `ruleHistory` is
frozen at the 0.5 prior because no human decision has ever been recorded.

This plan (a) promotes the missing signals into the identifier graph with
noise-damping, (b) rewires the confidence bands onto real evidence, and (c) makes
the human queues navigable by cluster rather than by row.

## User Story
As the operator of the Registry↔Insights seam, I want every source to converge on
shared identifiers and a confidence score that actually discriminates, so that the
review queues can be worked in priority order instead of as one undifferentiated
pile.

## Problem → Solution
Signals live in per-source columns and a near-constant trust score ranks nothing →
signals become first-class identifiers, and confidence is computed from evidence
that varies.

## Metadata
- **Complexity**: XL (spans both repos + live DB; phased)
- **Source PRD**: N/A — follows `queue-cockpit.plan.md` (complete)
- **Estimated files**: ~16

---

## Measured baseline (2026-07-24 — do NOT re-derive, re-verify only)

### Identifier coverage, registry (25,545 entities)
| Signal | Coverage | Identifier today | Entities linked if promoted |
|---|---|---|---|
| registered address | 25,545 (100%) | none | **3,008** (1,189 shared addresses) |
| L&I phone | 25,533 (99.95%) | none | 253 (122 shared phones) |
| website → root_domain | 2,941 distinct | **105** | 81 (25 shared domains) |
| google phone | 3,596 | none | 24 (12 shared) |
| google place_id | 3,817 profiles | none | 12 (6 shared) |
| aliases (DBA) | 253 | separate table (correct — names, not ids) | — |

Registry identifier types today: `contractor_number` (26,934), `ubi` (25,545),
`root_domain` (105). Insights types: `address` (128), `phone` (58),
`contractor_number` (32), `ubi` (19).

### Why the score cannot rank
| Rule | Pending | Trust range | Distinct trust values |
|---|---|---|---|
| `binding_name_exact` | 254 | 0.653–0.825 (σ 0.035) | 9 |
| `phone_from_lni` | 19 | 0.860 | 1 |
| `phone_from_google_divergent` | 4 | 0.860 | 1 |
| `binding_address_match` | 1 | 0.590 | 1 |
| `proximity_org` (resolution queue) | 1,518 | 0.600 | 1 |

Component variance on the 254-row bulk (`binding_name_exact`):
`name` 1 value (1.000 — tautological on an exact-match rule) · `identifier` 1 value
(0.500) · `ruleHistory` 1 value (0.500) · `locality` 2 values (0.300 on ~96%) ·
`role` 2 values · `corroboration` 4 values.

**Decisions ever recorded: 19 — all `auto:strict-bind`. Zero human decisions.**
So `ruleHistory` is the untouched Laplace prior everywhere, and the one rule with a
"track record" is the auto-binder grading its own work.

### Queue shape
Resolution review: 2,278 rows = **826 clusters**; **91 clusters cover 50%**;
364 cover 80%; 463 singletons (20% of rows); biggest cluster 73.
Registry review: 278. Google Place actionable: 201.

---

## Mandatory Reading
| Priority | File | Why |
|---|---|---|
| P0 | `packages/resolution/src/registry-observations.ts` (61–120, 620–1000, 1150–1210) | trust components, generation, insert/auto-accept gates |
| P0 | `packages/resolution/src/identifiers.ts` | how Insights identifiers are loaded/normalized; `addressMatchKeyCandidates` |
| P0 | `<registry>/apps/registry/supabase/migrations/20260724000000_registry_entity_principals.sql` | migration house style + the agent-filter lesson (belt AND braces) |
| P0 | `packages/resolution/src/review.ts` (`triageReviewQueue`) | the cluster grouping the UI already uses |
| P1 | `packages/resolution/src/entity-corroboration.ts` | graded signal precedent (`points`/`verdict`) |
| P1 | `<registry>/apps/registry/scripts/geo-corroborated-phone-promote.mjs` | AUTO_RESOLVER_SHAPE + pure-gate testing |
| P1 | `apps/web/app/app/admin/registry-review/actions.tsx` | `classifyReviewTier` consumer, batch UI |

## Patterns to Mirror
- **PURE_GATE**: exported pure classifier + `node --test` (geo-promote, lineage-consolidate).
- **BUCKET_DAMPING**: `shared_address_bucket_size` already exists as review evidence — reuse the concept for `is_strong`.
- **AGENT_FILTER (belt AND braces)**: `is_agent_principal` uses structural + denylist checks because one bad group fuses hundreds of entities. Address promotion needs the same paranoia.
- **CONTRACT_VIEW + RE-GRANT**: `otn_insights_reader` only; verify `anon` has no USAGE.
- **SKIP_SAFE_READ**: swallow only `42P01`, rethrow everything else.

---

## NOT Building
- No new auto-binding. `evaluateStrictBind` is untouched; new identifier types are
  **review-only** in this plan.
- Principals never become identifiers or match keys (standing governance).
- No Insights-side website enrichment (that is backlogged Phase A).
- No change to L&I identity/phone authority.
- No ML/model scoring — determinism is required in a review queue.

---

## Step-by-Step Tasks

### PHASE 0 — Measure before changing anything

#### Task 0.1: Baseline the trust distribution
- **ACTION**: Re-run `generateRegistryObservations` against current data and snapshot
  the before/after trust histogram per rule (no weight changes yet).
- **WHY**: the newest pending row is 2026-07-23 while the principals/relationship
  work landed 07-23/24, so some signal may already be unreflected. Distinguish
  "stale queue" from "bad weights" before touching weights.
- **VALIDATE**: record counts + distinct trust values per rule in the report; if the
  distribution changes materially, staleness was a contributing cause.

---

### PHASE 1 — Promote the missing identifiers (registry)

#### Task 1.1: `is_strong` damping policy (pure, testable)
- **ACTION**: New `<registry>/apps/registry/scripts/entity-resolution/identifier-strength.mjs`
  exporting `classifyIdentifierStrength({type, value, bucketSize})`.
- **IMPLEMENT**: `is_strong = false` when the value is shared by more than
  `MAX_STRONG_BUCKET` entities (start at 4, the corporate-family cap reasoning);
  always false for known-junk values (PO boxes, suite-less shared towers, the
  registered-agent address denylist, `000-000-0000`-style phones, and domains on a
  free-host/aggregator denylist e.g. `wixsite.com`, `facebook.com`, `godaddysites.com`).
- **MIRROR**: AGENT_FILTER — structural test AND denylist, because one bad bucket
  fuses hundreds of entities.
- **GOTCHA**: 1,189 addresses are already shared by 2+ entities; the long tail will
  include registered agents and office parks. Damping is the whole point — an
  undamped address identifier would be worse than none.
- **VALIDATE**: `node --test`; plus a report of the top 25 buckets by size with
  their entity counts, eyeballed before enabling.

#### Task 1.2: Migration — new identifier types
- **ACTION**: `20260725010000_identifier_type_expansion.sql`. Widen the
  `registry_entity_identifiers` type CHECK to add `phone`, `google_phone`,
  `address`, `google_place_id` (keep `contractor_number`, `ubi`, `root_domain`).
  Add an index on `(identifier_type, value_normalized)` for the shared-value lookup.
- **GOTCHA**: confirm the existing CHECK's exact name first (`pg_constraint`), as
  with `partner_observations`.
- **VALIDATE**: insert one row of each new type in a transaction, roll back.

#### Task 1.3: Backfill script
- **ACTION**: `<registry>/apps/registry/scripts/entity-resolution/backfill-identifiers.mjs`
  (`--dry-run`, `--limit`, `--type=`). Sources: L&I phone and registered address from
  the entity's normalized records; `google_phone`, `root_domain` (from
  `website_url`), and `google_place_id` from **accepted** external-profile links only.
- **IMPLEMENT**: normalize per type (phone → digits; domain → registrable root,
  strip `www.`; address → the existing address match-key normalizer, NOT a new one);
  compute bucket size per normalized value; write `is_strong` from Task 1.1;
  `ON CONFLICT DO NOTHING`.
- **GOTCHA**: reuse the SQL/normalizers that already exist — a second address
  normalizer that drifts from the first is how match keys silently stop matching
  (the same reason `normalize_principal` is a DB function).
- **VALIDATE**: dry-run counts match the baseline table above (±small drift);
  live run then rerun inserts 0.

#### Task 1.4: Expose identifiers on the contract view
- **ACTION**: Extend `registry_public.trades_identity_v1` (or a sibling
  `trades_identifiers_v1`) with the promoted identifier set + `is_strong`, granted
  to `otn_insights_reader` only.
- **MIRROR**: CONTRACT_VIEW + RE-GRANT.
- **VALIDATE**: read it as the `otn_insights` role; confirm `anon` still has no USAGE.

---

### PHASE 2 — Rewire the confidence bands (Insights)

#### Task 2.1: Stop scoring on a frozen prior
- **ACTION**: In `registry-observations.ts`, exclude `ruleHistory` from the trust
  computation until a rule has ≥`MIN_HUMAN_DECISIONS` (start 10) **human** decisions;
  auto-decisions (`decided_by LIKE 'auto:%'`) must not count toward that history.
- **GOTCHA**: today's only history is 19 `auto:strict-bind` accepts — letting the
  auto-binder's own output feed its trust is a self-reinforcing loop.
- **VALIDATE**: unit — a rule with only auto-decisions scores identically to one with
  no history; trust values change for all 278 pending rows.

#### Task 2.2: Graded locality from geo
- **ACTION**: Replace the binary 0.3/1.0 `locality` with distance bands from
  `geo_distance_meters` / `geo_corroboration` (already on the links table and used by
  geo-promote). Keep 0.3 as the floor when geo is unknown.
- **VALIDATE**: unit over band boundaries; the 254-row bulk must show >2 distinct
  locality values afterwards.

#### Task 2.3: A real `identifier` component
- **ACTION**: Compute `identifier` from actual identifier agreement between the org
  and the entity (strong ids weigh more than damped ones), consuming Task 1.4's view.
  Replace the constant 0.5.
- **GOTCHA**: an agreeing `is_strong=false` identifier is weak evidence, not none —
  score it low rather than dropping it.
- **VALIDATE**: unit; distinct trust values across the bulk rule must rise from 9.

#### Task 2.4: Evidence-defined tiers
- **ACTION**: Redefine `classifyReviewTier` on facts, not the float: tier1 = exact
  name + same city + shared trade + (phone|address|domain agrees); tier2 = exact name
  + exactly one corroborator; tier3 = name only. Keep the score as a tiebreak within
  a tier.
- **WHY**: a float pretending to rank 254 rows that differ by 0.03 is false precision;
  a reviewer can check a fact.
- **VALIDATE**: unit per tier; the registry-review page's tier counts become non-degenerate.

---

### PHASE 3 — Make the queues navigable

#### Task 3.1: Cluster-first resolution review
- **ACTION**: Default `/app/admin/review` to the cluster view sorted by size; show
  "N clusters to clear 50% / 80%"; collapse the 463 singletons behind a toggle.
- **VALIDATE**: page renders the same totals; 91-cluster figure reproduces.

#### Task 3.2: `review_state` for the resolution queue
- **ACTION**: Apply the Phase D pattern — split human-decidable from
  needs-machine-work-first. Candidate rule: `proximity_org` with no second signal
  (1,518 rows at a single score) is not a human decision.
- **GOTCHA**: fail CLOSED, exactly as `google_place_review_v1` does — an unclassified
  rule must land in the non-actionable bucket, never in the operator's queue.
- **VALIDATE**: counts reconcile to 2,278; the actionable subset is materially smaller.

#### Task 3.3: Cockpit reflects the new bands
- **ACTION**: Surface tier mix and "clusters to clear 50%" on the cockpit cards.
- **VALIDATE**: `queueSummary` unit tests updated; build clean.

---

## Testing Strategy
| Test | Expectation | Edge case |
|---|---|---|
| `classifyIdentifierStrength` | oversized bucket ⇒ `is_strong=false` | denylisted agent address, PO box, free-host domain |
| backfill dry-run | matches measured baseline | rerun inserts 0 |
| ruleHistory gate | auto-only history ⇒ no history credit | exactly at threshold |
| graded locality | band boundaries | geo unknown ⇒ floor |
| identifier component | strong > damped > none | damped-only agreement still > 0 |
| tiers | one case per tier | contradicted evidence never tier1 |

## Validation Commands
```bash
pnpm -r run typecheck && pnpm exec eslint . && pnpm exec vitest run packages/resolution/src packages/intelligence/src && pnpm --filter @otn/web run build
```
```bash
node --test apps/registry/scripts/entity-resolution/identifier-strength.test.mjs
```

## Acceptance Criteria
- [ ] Registry identifiers include address/phone/domain/place_id with `is_strong` damping
- [ ] Distinct trust values on the 254-row bulk rule rise well above 9
- [ ] No rule scores on `ruleHistory` without human decisions
- [ ] Tiers are evidence-defined and non-degenerate
- [ ] Resolution review defaults to clusters with a 50%/80% indicator
- [ ] `evaluateStrictBind` unchanged; no new auto-binding
- [ ] `anon` still has no USAGE on `registry_public`

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Shared-address identifier fuses unrelated companies | **High** | **High** | bucket damping + denylist + review-only; eyeball top 25 buckets before enabling |
| New identifiers silently widen auto-binding | Medium | High | strict-bind explicitly untouched; identifiers marked review-only |
| Re-scoring invalidates operator intuition mid-queue | Medium | Medium | Phase 0 snapshot; announce the recalibration; keep score as tiebreak only |
| Domain promotion picks up aggregator/free hosts | High | Medium | denylist in Task 1.1, verified against the 2,941 domains |

## Notes
Insights-side overlap remains thin (0/3,797 orgs have a website; the 61 party phones
have zero registry overlap), so Phase 1's near-term value is the **registry-internal
graph** — entity↔entity links that feed the corporate-family/relationship tier shipped
in queue-cockpit Phase B — not immediate binding lift. Phase 2's value is immediate
and independent of that.
