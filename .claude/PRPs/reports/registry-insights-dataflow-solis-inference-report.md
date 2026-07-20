# Implementation Report: Registry ⇄ Insights dataflow for Solis inference

## Summary
Implemented the **non-gated Insights-side subset** of the combined dataflow PRP — the highest-leverage inference win plus the read-widen and Solis bind-readiness. Registry identity now reaches the Solis scorer (it never did before), the contract read consumes the full 21-column view lineage-safely, the observation-loop trust is registry-corroborated, and Solis's own L&I identity is seeded bind-ready. The outward-facing merge (WS-C), the resolution-dedup design (WS-B.4), and the externally-gated items (WS-D, WS-E.2/E.3/E.4) are **not** implemented and are documented as remaining.

## Assessment vs Reality
| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | XL (whole plan) | This increment = Medium (Insights-only, additive) |
| Confidence | 7/10 overall | 9/10 for the shipped subset (all validated) |
| Files Changed | ~14 Insights-side | 6 source + 2 test files, this increment |

## Tasks Completed (this increment)
| # | Task | Status | Notes |
|---|---|---|---|
| WS-B.1 | Registry identity into scoring features | ✅ | `score-run.ts` org rollup widened with `registry_ref`/`registryVerified` |
| WS-B.2 | Registry-aware `orgIdentified` | ✅ | Additive — a governed binding lifts even a bare person name; no legal-name regression |
| WS-B.3 | Solis `gc_identified` component + signal | ✅ | Score-neutral under §12.3 (weight-absent); `verified_gc_on_project` signal |
| WS-B.5 | Nightly ordering: link before score | ✅ | Fresh binds reach `scoreAll` in-run |
| WS-A.1 | Widen contract read to 21 cols | ✅ | `status, record_count, root_domain, first_minted_at` (optional) |
| WS-A.2 | Lineage guard on `status` | ✅ | Defense-in-depth (view already pre-filters to active) |
| WS-A.4 | Registry-corroborated trust | ✅ | Bounded `registryCorroborationBonus`; live-only lift |
| WS-E.1 | Solis identity bind-ready | ✅ (E.1a) | Seeded strong keys; bind (E.1b) fires once registry connected (WS-C) |

## Validation Results
| Level | Status | Notes |
|---|---|---|
| Static Analysis (typecheck) | ✅ Pass | 4 plan packages: db, resolution, intelligence, worker |
| Unit Tests | ✅ Pass | +7 new (4 scoring, 3 corroboration); 96 intelligence + 16 pure resolution green |
| Integration (local DB :5433) | ✅ Pass | registry-link (4), registry-observations (10), velocity/loadFeatures (7) |
| Seed | ✅ Pass | Idempotent; Solis org bind-ready, `registry_ref` null, exactly one row |
| Build | ⏭️ Not run | Typecheck used as the static gate (repo pattern) |

## Files Changed
| File | Action | Commit |
|---|---|---|
| `packages/intelligence/src/scoring.ts` | UPDATE | f67ec11 |
| `packages/intelligence/src/score-run.ts` | UPDATE | f67ec11 |
| `packages/intelligence/src/eval/harness.ts` | UPDATE | f67ec11 |
| `packages/intelligence/src/scoring.test.ts` | UPDATE (+4 tests) | f67ec11 |
| `apps/worker/src/schedules.ts` | UPDATE | f67ec11 |
| `packages/resolution/src/registry-link.ts` | UPDATE | 163aa7c |
| `packages/resolution/src/registry-observations.ts` | UPDATE | 163aa7c |
| `packages/resolution/src/registry-observations.test.ts` | UPDATE (+3 tests) | 163aa7c |
| `packages/db/src/seed.ts` | UPDATE | d999bca |

## Deviations from Plan
- **Scoped to the non-gated Insights-side subset.** Given session cost and that the remainder is either outward-facing (WS-C touches the shared `release/trades-staging` trunk + Codex's branch + the registry) or externally gated, I implemented and shipped the code that delivers Solis inference value now and left the rest as explicit checkpoints. The user selected this scope.
- **Plan NOT archived** — the plan remains active; several workstreams are outstanding.
- **E.1 split** into E.1a (seed bind-ready — done) and E.1b (actual bind — needs the registry connection from WS-C).

## Remaining Work
- **WS-C** — merge the already-built registry write-back seam (`origin/claude/insights-integration-seam` `ae80f657`) into `release/trades-staging` + provision the `otn_insights` login role. **Outward-facing; needs explicit go-ahead.** Unblocks E.1b (Solis bind), the export loop, and live-seam scoring.
- **WS-B.4** — resolver dedup on `registry_ref`. Needs a design decision (ingest-time key without inline binding) before touching resolution correctness.
- **WS-E.2** — lift warm-network (co-appearing bound GCs) from digest-only into a Solis scoring signal.
- **WS-D** — trade-code convergence: gated on the registry ER PRP Phase 5 seeding `registry_trade_taxonomy` (the loader already routes trade_evidence, just skips on an unseeded code).
- **WS-E.3/E.4** — home-metro source flips (capture-gated) and Solis weight finalization (Solis calibration, §12.3).

## Next Steps
- [ ] Authorize WS-C (registry-side merge) to light up the live seam + Solis bind
- [ ] `/code-review` this branch before it merges onward
- [ ] Design WS-B.4 for review
