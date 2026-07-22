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

## Phase 4 — pending (§12.3-gated for scoring-adjacent parts)
