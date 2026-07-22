# Implementation Report: Registry ↔ Insights Data Flywheel

**Plan**: `.claude/PRPs/plans/registry-insights-flywheel-phases-1-4.plan.md` (stays in place until Phase 4 completes; per-phase execution).

---

## Phase 1 — Corroboration + decision labels (COMPLETE, commit `4e5b8fb`)

### Summary
Confidence derived from cross-references the corpus already stored, plus an append-only label ledger so §12.3 calibration runs on what humans actually saw. Applied to the hosted production DB the same day: **11,987 projects derived — 209 corroborated by ≥2 public sources, 483 carrying material same-fact contradictions**; score distribution byte-identical after rescoring (Solis 3,044 opps / 473 priority — neutrality confirmed in production, not just in tests).

### Assessment vs Reality
| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity (Phase 1) | Small-Medium | Small-Medium — as planned |
| Confidence | 8/10 | Landed single-pass; 2 test-harness surprises (below) |
| Files Changed | ~11 | 16 (+ vitest guard, digest.test fixture, render.ts) |

### Tasks
| # | Task | Status | Notes |
|---|---|---|---|
| 1.1 | Migration 0027 (decision_labels + corroboration + view cols) | done | Applied local + hosted; journal idx 27 |
| 1.2 | deriveCorroboration maintenance pass | done | Set-based single UPDATE; reset-then-derive (no stale summaries) |
| 1.3 | Score-neutral signals + digest disclosure | done | Signals appended AFTER router scoring → neutral by construction; automation policy 1.1.0 adds disclosed `fact_contradiction` review reason |
| 1.4 | Decision-label capture | done | Snapshot SELECT runs BEFORE the state UPDATE (label = what the human saw); promotes now recorded (previously evaporated) |
| 1.5 | Close-out | done | Suite 664/664; eval GATES PASS byte-identical (precision 1.0 / recall 0.9609); hosted migrate + maintenance + digest rebuild |

### Validation
| Level | Status | Notes |
|---|---|---|
| Typecheck | Pass | 0 errors, all packages |
| Unit/DB tests | Pass | 664/664 (13 new/extended: corroboration view test, neutrality ×2, decision_labels CHECK + round-trip) |
| Eval gates | Pass | Metrics byte-identical to pre-change — §12.3 freeze proven |
| Hosted migrate | Pass | 0027 idempotent, ledger-recorded |
| Production derivation | Pass | 11,987 derived / 209 multi-source / 483 contradictions |

### Deviations
1. **Corroboration DB test lives in `apps/worker/test/cockpit-views.test.ts`**, not a new `packages/resolution` harness — resolution tests are pure-unit by convention; the worker file already owned the exact fixtures needed.
2. **State route not unit-tested directly** — `apps/web` is outside the vitest include globs (pre-existing harness scope). The `decision_labels` contract (CHECK constraint, snapshot round-trip) is tested at the DB layer instead.
3. **`lifecycle_progressing` emits on stageDepth ≥ 2 alone** (plan sketched "+ recent transition") — recency is already carried separately by `last_material_change_at`/timing; duplicating it in the signal would blur its meaning.
4. **Unplanned fix**: vitest now blanks `OTN_CAPTURE_DIR` — the operator's staged captures in `.env` were making the 3 capture-fed adapter gate tests resolve instead of dead-letter (pre-existing failure surfaced by the full-suite run, not introduced by this phase).

### Issues Encountered
- Drizzle wraps pg errors (`DrizzleQueryError.cause.code`) — CHECK-violation assertion adjusted.
- `CandidateRow` gained a required field → digest.test.ts fixture builder updated (`corroboration: null`).

## Phase 2 — Fact propagation + GC Radar (COMPLETE; Insights `9d3400b`, registry `ffb0f284`)

### Summary
The verifier now carries **priors with provenance**; the dormant address-binding rule is **live end-to-end**; and the cockpit gained **GC Radar** (migration 0028 `insights_public.cockpit_orgs_v1` + registry `/dashboard/insights/orgs`).

### Tasks
| # | Task | Status | Notes |
|---|---|---|---|
| 2.1 | Verified-fact propagation (A3) | done | `matchVerifiedPriors`/`loadVerifiedPriorRuns`: earlier SUPPORTED verdicts (same path + identical value, confidence ≥ 0.9) injected as labeled CANDIDATES (same_evidence / sibling_evidence); model verdicts never overridden (rejected-prior tested); `propagated_from` provenance stored beside verdicts; prompt v1.1.0; budget gates untouched. Live `verify:run` clean (1 remaining candidate, `priors:0` — no earlier run existed; correct). |
| 2.2 | Address-binding activation (A5) | done | Dormancy root-caused LIVE: comma-less mailing strings kept their inline city so org keys never met the registry's street-only form (0 candidates despite real overlap). `addressMatchKeyCandidates` peels trailing city tokens (stops at suffixes/directionals/digits; validity floor; fails closed). Hosted re-generation: 1 `binding_address_match` candidate — spot-checked genuine ("NW MECHANICAL" ↔ "Northwest Mechanical", same street+zip, trust 0.59, human-review queued; the other SQL-probe overlaps were correctly pruned by the name-agreement/unique-address gates or already name-matched). |
| 2.3 | GC Radar (B1) | done | 0028 view: cached registry-identity snapshot (name/UBI/license/trades/Google rating+reviews) + permit velocity (12mo/90d) + account overlap, under the 0025 PII gates + ≥2-project floor; zero new cross-schema grants (snapshot, not registry_public join). Registry: `fetchCockpitOrgs` + `OrgsTable` + orgs page (views-only, zero POSTs) + overview link. Insights org page enriched (velocity line, rating/trades) — **deviation**: plan's `/app/orgs/[id]` CREATE became enrichment of the pre-existing `organizations/[id]` page. |

### Validation
Typecheck 0 errors both repos · Insights suite 678/678 · eval GATES PASS byte-identical (precision 1.0 / recall 0.9609) · registry test:security 64/64 + trades-key build green · 0028 applied local + hosted · bounded live verify spend ≈ $0.0004.

## Phase 3 — Claim flywheel + public data products (see close-out numbers below)

### Tasks
| # | Task | Status | Notes |
|---|---|---|---|
| 3.1 | `trades_activity_v1` + profile badge (B2) | done | Insights export rollup gains `project_count_12m`; registry migration `20260722090000` + byte-identical baseline patch **28** + census row; view exposes UBI so the contractor profile route joins from `settings.ubi` without touching `registry_internal`. Badge: "N permits in the last 12 months (via OTN Insights)", all-time fallback when the 12m field predates the export, **no badge at zero** (honest empty). |
| 3.2 | Market aggregate views (0029) | done | **Deviation (design)**: instead of a fragile SQL port of the shared trade matcher, the nightly chain derives `projects.trade_codes` in TS (`deriveProjectTrades`, permitType-only, SHARED WS-T vocabulary, reset-then-derive) and the views aggregate stored codes. `market_demand_v1` (county×trade×month; combo-level n≥5 gate so trend lines stay honest) + `market_permit_speed_v1` (median application→issue days per jurisdiction, ≥5 samples). |
| 3.3 | pSEO market pages (C1/C2) | done | `/trades/market/[county]/[trade]` — trades-site-gated, JSON-LD Dataset, disclosure copy + suppression disclosure pinned in the pSEO gate. **Deviation**: `MARKET_ROBOTS` noindex-initially and NO sitemap entry — mirrors the repo's own BJJ market-cluster verify-first precedent (plan said sitemap; indexing flips after a human content pass). |
| 3.4 | Projects-near-you teaser (C3) | done | Trades dashboard home gains an `IS_TRADES` branch (BJJ path untouched): aggregate counts ONLY from the suppressed demand view (6-month window, top counties), "no card" on zero/error; insights-module holders deep-link, others get the module upsell copy. Tenant settings carry no county → statewide + top-counties copy (deviation from "near you" county precision, honest about basis). |

### Phase 3 validation (commits: Insights `8735f17`, registry `0328b9b0`)
| Level | Status | Notes |
|---|---|---|
| Typecheck | Pass | 0 errors both repos |
| Insights suite | Pass | 681/681 (market view gate ×2 + trade-derivation tests added) |
| Eval gates | Pass | Byte-identical (precision 1.0 / recall 0.9609) — §12.3 intact through all three phases |
| Registry | Pass | test:security 64/64 · pSEO gate zero failures · BOTH site-key builds green |
| Hosted migrate | Pass | Insights 0028+0029 (local + hosted); registry `20260722090000` applied live, ledger-recorded |
| Production derivation | Pass | 176 distinct permitTypes → 54 matched → **1,595 projects trade-tagged**; live views serve **21 county×trade combos** (King mechanical 770, Thurston electrical 190, …) + **3 jurisdiction speed medians** |

**Known data limitation (not a bug):** `market_demand_v1` months bucket on `first_seen_at`, and the corpus was rebuilt 2026-07-21/22 — so every combo currently shows ONE month. Trend lines accrue forward from now; history is never fabricated backwards.

## Phase 4 — COMPLETE (owner-approved scope: 4A + 4B matching-strength + root-domain enablement)

**Plan**: `.claude/PRPs/plans/registry-insights-flywheel-phase4.plan.md` (self-contained Phase 4 PRP integrating the original 4A scope with the owner-accepted 4B package and the root-domain override — "the integration of these two projects into one is your perogative").

### Tasks
| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Migration 0030 `identifier_lanes` | done | +`root_domain` identifier class; +`provenance` (`source_evidence`\|`registry_accept`); `source_record_id` nullable ONLY for registry_accept rows (row CHECK — the no-claim-without-a-source invariant is narrowed, not dropped). Applied local + hosted (journal idx 30). |
| 2 | 4B.1 phone extension strip | done | Trailing `x102`/`ext. 5`/`#12` stripped before digit reduction — the 13-digits→null bug is dead; implausible counts still rejected. |
| 3 | 4B.3 address keys round 2 | done | Placeholder rejection (`NONE`/`N/A`/`UNKNOWN`/`SAME`/`TBD`); ONE trailing unit-looking token peeled when preceded by a street-tail token, over every candidate (comma'd strings included), floor enforced, Set-deduped. |
| 4 | Root-domain lane | done | `normalizeRootDomain` (scheme/userinfo/path/port/www stripped; NO eTLD+1 — both sides fold identically, fail-closed; platform-host denylist incl. subdomains); optional `website` on parser organizations[] (skip-safe, no adapter emits yet) → `root_domain` identifier rows; `loadOrganizationDomains`. |
| 5 | 4B.3 shared-bucket matching | done | `buildRegistryAddressIndex` → candidate keys on the REGISTRY side too, buckets kept (dedup by entityId); `matchOrgByAddress` single-row keeps the ≥0.3 gate, shared rows need best ≥0.5 AND ≥0.2 dominance margin; `shared_address_bucket_size` in payload. |
| 6 | 4B.2 + domain rules | done | `buildRegistryGooglePhoneIndex` (unique-only, poisoned vs ANY other entity's L&I phone) → `binding_google_phone_match`, identifier 0.75 (de-rated, `phone_from_google` precedent); `buildRegistryDomainIndex` → `binding_domain_match`, identifier 1, name-gated. Both ride observation type `binding_name_match` ⇒ structurally excluded from auto-accept; branch order L&I name/phone → google phone → address → domain; dedupe key unchanged. |
| 7 | 4B.4 accept-side backfeed | done | `backfeedAcceptedIdentity` in `decideRegistryObservation` accept: NULL-only `organizations.ubi`/`contractor_registration` + identifier upserts with `provenance='registry_accept'`, `source_record_id NULL`. DB test proves stamp + provenance + no-overwrite (org2's pre-existing UBI survives a later conflicting accept — conflicts stay for review). |
| 8 | 4B.5 telemetry + `match:audit` | done | `GenerateSummary.belowFloor` + `byRule`; new worker CLI prints per-rule queued/pending/accepted/rejected/auto, HUMAN Laplace rate (= the live ruleHistory component), trust min/median/max, near-floor band. Ran read-only against hosted: 261 `binding_name_exact` + 1 `binding_address_match` pending. |
| 9 | 4A.2 pursuit outcomes | done | `transitionPursuit` won/lost/no_bid → append-only `decision_labels kind='pursuit_outcome'` (kind was already CHECK-admitted by 0027) with the decision-time snapshot (opp score/route/signals/county/stage/corroboration + pursuit values); HUMAN_ONLY already guarantees a human actor; UI affordance already existed (pursuits/[id]/actions.tsx transition select). Test: won ⇒ exactly one label with snapshot; non-outcome transitions ⇒ none. |
| 10 | 4A.3 calibration prep | done | `docs/calibration-prep-solis.md` gained §5–7 (label-ledger queries, per-account precision readout, match:audit walkthrough, §12.3 weight-change protocol + freeze-lift criteria) APPENDED — the owner's 2026-07-17/20 decided sections untouched. Queries validated executable against the hosted DB (ledger currently empty — honest: labels accrue as the owner reviews). |
| 11 | 4A.1 Contractor Activity Score | done | `registry_internal.contractor_activity_score_v1` (migration `20260722120000` + byte-identical baseline patch 29 + census row; APPLIED LIVE, ledger-recorded): round(100×(0.5·permit + 0.3·credential + 0.2·web)) per trades tenant via settings-UBI → identity → activity contract views; INNER join = sample gate (no rollup ⇒ no row ⇒ unscored, never 0). Directory: LEFT JOIN + `activity_score DESC NULLS LAST` (non-trades verticals byte-order-identical — their join is all NULLs), disclosure line, per-card chip; profile: score panel with per-component basis inside the Permit activity section; 4 pSEO-gate pins. NEVER read by Insights. |
| 12 | Close-out | done | Hosted: 0030 verified live (provenance column + nullable source_record_id), registry view applied + probed; ONE maintenance pass (Governance #7) — clean, no score drift (Solis 3,044/477 unchanged from pre-pass), new rules 0 new candidates (correct: no org domain evidence yet; dedupe holds), export honestly 0 facts. Both trunks committed + pushed; STATUS + memory updated. |

### Validation
| Level | Status | Notes |
|---|---|---|
| Typecheck | Pass | 0 errors, 11/11 packages (one pre-existing Phase 3 test stub missing `TradeMatcher.codes` fixed in passing) |
| Insights suite | Pass | **699/699** (88 files) — +9 identifiers tests, +8 registry-observations pure tests, +1 backfeed DB assertion block, +1 pursuit-outcome label test |
| Eval gates | Pass | **Byte-identical** (precision 1.0 / recall 0.9609375, same 5 missed ids) — §12.3 frozen through all four phases |
| Registry | Pass | tsc clean · test:security 64/64 · pSEO gate zero failures (4 new pins) · BOTH site-key builds green |
| Hosted | Pass | 0030 + `20260722120000` applied, ledger-recorded; `match:audit` live output captured |

### Deviations
1. **Registry migration named `20260722120000`** (date-accurate) instead of the plan's `20260723090000`.
2. **Test placement**: the old "shared address dropped" pure test was REWRITTEN to the new dominance contract (planned behavior change); google-phone/domain rule coverage ships as exported pure index builders (`buildRegistryGooglePhoneIndex`/`buildRegistryDomainIndex`) + tests, mirroring how the address matcher is tested — the DB-coupled branch wiring is covered by typecheck + the hosted pass, same as Phase 2.2's precedent.
3. **`calibration-prep-solis.md` was appended, not created** — the file already existed with owner-decided content (2026-07-17/20 sections preserved verbatim).

### Known live-state fact (not a bug)
`trades_activity_v1` and therefore the Activity Score view are currently **0 rows**: the only bound org is SOLIS INTERIORS itself (the customer's own org, 0 permit roles), so the facts export honestly exports nothing. The whole loop is wired: each owner accept from the **262-candidate review queue** now (a) binds, (b) backfeeds strong keys (4B.4), (c) exports partner facts on the next pass → profile badge + Activity Score light up. The human review gate is the flywheel's crank, by design.
