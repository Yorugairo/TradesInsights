# Implementation Report: Go-live runbook + shared trade vocabulary + warm-network + home-metro sources

## Summary
Implemented the shared-trade-vocabulary loop end-to-end plus the warm-network Solis
signal and the go-live runbook. The registry trade taxonomy is now the **single
source of truth** for trades + keywords (seeded from WA L&I license specialties),
exposed on the contract surface, and **OTN Insights derives its permit-text matcher
from it** — replacing the hardcoded 7-keyword list and closing the finish-trade gap
(drywall/painting/glazing). WS-S (home-metro source flips) is **deliberately deferred**
to an operator gate (see Deviations). Shipped across both repos and pushed.

## Assessment vs Reality
| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Large (two repos) | Large — as predicted |
| Confidence | 8/10 | 9/10 for shipped work (all validated); WS-S deferred by governance |
| Files Changed | ~6 registry + ~6 Insights + 1 runbook | 7 registry + 7 Insights + 1 runbook = 15 |

## Tasks Completed
| # | Task | Status | Notes |
|---|---|---|---|
| RB.1 | Go-live runbook | ✅ | `docs/runbooks/registry-seam-golive.md` — login role, taxonomy seed, session-port env, loop, verification, rollback |
| T.1 | Seed `registry_trade_taxonomy` from L&I | ✅ | `seed-trade-taxonomy.mjs` + `trades-taxonomy-map.mjs` (23 curated trades, keyword dicts, unmapped-specialty reporting) |
| T.2 | Assign trades per entity from L&I | ✅ | `assign-license-trades.mjs` — `source='license_code'`, specialty1⇒primary, via `registry_match_decisions` |
| T.3 | Expose `trades_taxonomy_v1` contract view | ✅ | Migration + byte-identical baseline `25_…` + README census (guard passes) |
| T.4 | Insights derives matcher from taxonomy | ✅ | `trade-taxonomy.ts` (`fetchTradeTaxonomy`/`buildTradeMatcher`); trade_export scans permitType **and** description; description de-rated + review-gated; skip-safe fallback |
| T.5 | Loader `assignment_rank` vs CHECK | ✅ | `'partner'`→`'secondary'`; **plus** loader made PK-safe against `license_code` assignments (any-source dup check + `ON CONFLICT DO NOTHING`) |
| W.1/W.2 | Warm-network Solis signal | ✅ | `warm-network.ts` (`warmGcEntityIds`); `routeSolis` emits score-neutral `warm_gc_active` |
| S.1 | Home-metro source flips | ⏸️ Deferred | Governance gate — see Deviations |

## Validation Results
| Level | Status | Notes |
|---|---|---|
| Typecheck | ✅ Pass | db, resolution, intelligence, worker — all clean |
| Unit/integration tests | ✅ Pass | **70 tests** green (11 new trade-taxonomy + 3 new warm-network + 15 registry-observations + 34 scoring + 10 worker registry-obs) |
| Widened SQL (`scanDescription=true`) | ✅ Pass | Read-only smoke-tested on the live :5433 schema (both branches parse/execute) |
| Registry scripts | ✅ Pass | `node --check` all 4; taxonomy-map logic smoke test (23 trades, no dup codes, normalizer 9/9, GC keywords empty) |
| Registry census guard | ✅ Pass | `docs-manifest-audit.mjs` — baseline apply-order + docs index in parity |

## Files Changed
**Insights** (`claude/tmux-install-320aiz`)
| File | Action | Commit |
|---|---|---|
| `packages/resolution/src/trade-taxonomy.ts` | CREATE | 20299a4 |
| `packages/resolution/src/trade-taxonomy.test.ts` | CREATE | 20299a4 |
| `packages/resolution/src/registry-observations.ts` | UPDATE (rm TRADE_KEYWORDS; taxonomy matcher; permitType+desc) | 20299a4 |
| `packages/resolution/src/registry-observations.test.ts` | UPDATE | 20299a4 |
| `packages/resolution/src/index.ts` | UPDATE | 20299a4 |
| `apps/worker/src/schedules.ts` | UPDATE (fetch + pass taxonomy) | 20299a4 |
| `packages/intelligence/src/warm-network.ts` | CREATE | dc57032 |
| `packages/intelligence/src/scoring.ts` | UPDATE (warmGcRefs + warm_gc_active) | dc57032 |
| `packages/intelligence/src/score-run.ts` | UPDATE (compute warm set/account) | dc57032 |
| `packages/intelligence/src/index.ts` | UPDATE | dc57032 |
| `packages/intelligence/src/scoring.test.ts` | UPDATE (+3) | dc57032 |
| `docs/runbooks/registry-seam-golive.md` | CREATE | 185414e |

**Registry** (`release/trades-staging` — github.com/Yorugairo/BJJRegistry)
| File | Action | Commit |
|---|---|---|
| `apps/registry/scripts/entity-resolution/ingest-otn-insights.mjs` | UPDATE (rank fix + PK-safety) | 491014a7, 2e1f1e25 |
| `apps/registry/scripts/entity-resolution/trades-taxonomy-map.mjs` | CREATE | 2e1f1e25 |
| `apps/registry/scripts/entity-resolution/seed-trade-taxonomy.mjs` | CREATE | 2e1f1e25 |
| `apps/registry/scripts/entity-resolution/assign-license-trades.mjs` | CREATE | 2e1f1e25 |
| `apps/registry/supabase/migrations/20260720093000_registry_public_trades_taxonomy_v1.sql` | CREATE | 2e1f1e25 |
| `db/baseline-v1.2/25_registry_public_trades_taxonomy.sql` | CREATE | 2e1f1e25 |
| `db/baseline-v1.2/README.md` | UPDATE (census row + ranges) | 2e1f1e25 |

## Deviations from Plan
- **WS-S (home-metro source flips) deliberately deferred.** All three sources are
  `cadence: on_demand` (never auto-scheduled) and the author set `enabled: false`
  with a documented *"stays disabled"* rationale (live `fetch()` dead-letters;
  capture-fed only). Capture readiness differs — `olympia_smartgov_reports` has a
  real captured artifact (`permits-issued-last-30-days.pdf`) and is capture-ready,
  but `tumwater_sepa` / `tumwater_development_review` have only discovery-index
  fixtures, not document captures. Enabling external-gov data collection the author
  intentionally disabled, where "capture availability" is a runtime operator fact,
  is an outward-facing decision left to the operator. **One-line flip when ready:**
  set `enabled: true` for the capture-ready source(s) in `config/sources.yaml`.
- **T.5 widened** beyond the rank literal to also make the loader PK-safe against
  the new `license_code` assignments (the PK is `(entity_id, trade_code)`, one row
  per trade regardless of source; a plain INSERT would have PK-conflicted).
- **Registry seed/apply not run from here** — needs live registry credentials; the
  scripts are `node --check` + logic-validated and gated behind the go-live runbook.
- **Plan NOT archived** — WS-S remains an open operator gate.

## Issues Encountered
- **GateGuard fact-forcing** fired on every new-file Write; satisfied per file.
- **Latent PK-conflict** between T.2 (`license_code`) and the partner loader
  surfaced during design — fixed in the loader (any-source dup check + `ON CONFLICT`).

## Remaining / Operator-gated
- **RB / go-live:** provision the `otn_insights` login role, set `REGISTRY_DATABASE_URL`
  (session port 5432), run the seed (`seed-trade-taxonomy.mjs` → `assign-license-trades.mjs`)
  + apply the taxonomy view migration, then run the loop. All documented in the runbook.
- **WS-S:** operator flips `enabled` for capture-ready home-metro sources.
- **Solis calibration (§12.3):** `verified_gc_on_project` / `warm_gc_active` /
  description-trade matches stay signal-only / review-gated until Solis confirms scope.

## Next Steps
- [ ] `/code-review` both branches
- [ ] Owner: run the go-live runbook against the live registry
- [ ] Decide WS-S (enable Olympia capture-fed source?)
