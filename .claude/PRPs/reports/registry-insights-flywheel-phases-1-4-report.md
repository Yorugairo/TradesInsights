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

## Phase 2 — pending
## Phase 3 — pending
## Phase 4 — pending
