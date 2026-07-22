# Implementation Report: Roadmap Wave 2 — Tracks E–H

## Summary
All unblocked E/F/G/H items shipped: trade-scoped Bid Clock (owner amendment honored), corroboration panel, GC Copilot working history, outcome attribution, live-web source-expansion audit, methodology/never-pay-to-rank page, contractor badge, claim CTA band, and the WA Construction Pulse page. No migrations; §12.3 proven frozen (eval byte-identical) despite touching the intelligence package.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Large | Large (but smaller than planned — E1's core lib already existed) |
| Confidence | 7.5/10 | Held; one impl-time bug (column home), caught by existing DB tests |
| Files Changed | ~19 | 18 (15 code + 3 docs) |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1–2 | Bid Clock lib + panel | ✅ | **Major discovery:** `bid-window.ts` already existed and was RICHER than planned (per-trade drywall/paint clocks, PNW season caveat, confirmed-fact precedence) — wired into digest/export/alerts but with NO web surface. Wave added the trade-scoping API (`accountBidWindows` et al., per the owner's directive) + 7 tests + the opportunity-page panel. |
| 3 | Corroboration panel | ✅ | opportunityDetail + page section; contradictions show both values |
| 4 | GC Copilot | ✅ | workingHistory in getOrganizationView + org-page table + warm-GC badge |
| 5 | Outcome attribution | ✅ | roi.ts + ROI page/API; win rate hidden <5 decided |
| 6 | Source audit | ✅ | Live-verified: Snohomish Excel P1, Clark weekly PDF P2, Spokane City GIS P3, County SmartGov P4, WEBS owner-gated |
| 7 | Methodology + directory line | ✅ | Pledge pinned; existing pins byte-intact |
| 8–9 | Badge + embed + claim CTA | ✅ | Deviated: embed snippet on /methodology, not /for-owners (see below) |
| 10 | Construction Pulse | ✅ | noindex-initial; H3 jurisdiction speed table folded in |
| 11 | Close-out | ✅ | This report |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis | ✅ | Insights `pnpm -r typecheck` 11/11; registry `tsc` 0 errors |
| Unit Tests | ✅ | Insights **706/706** (was 699; +7 trade-scoping tests in bid-window, 28 in file) |
| Eval gates | ✅ **byte-identical** | precision 1.0 / recall 0.9609375, same 5 missed ids — §12.3 frozen holds through the intelligence-package touch |
| pSEO gate | ✅ | clean with **7 new pins** (pledge, unscored-never-zero, directory link, pulse noindex/basis/suppression/views) |
| Security suite | ✅ | 64/64 |
| Builds | ✅ | both site keys; `/methodology`, `/trades/pulse`, `/api/badges/contractor/[slug]` present |

## Files Changed

**Insights** (`claude/tmux-install-320aiz`)
| File | Action |
|---|---|
| `packages/intelligence/src/bid-window.ts` | UPDATED — trade-scoping API (CAPABILITY_TRADE_WINDOWS, windowTradesFor, accountBidWindows) |
| `packages/intelligence/src/bid-window.test.ts` | UPDATED — +7 scoping tests (28 in file) |
| `packages/intelligence/src/relationships.ts` | UPDATED — workingHistory on getOrganizationView |
| `packages/delivery/src/roi.ts` | UPDATED — outcomeAttribution() |
| `apps/web/lib/queries.ts` | UPDATED — opportunityDetail: corroboration + bidText + latestIssueDate |
| `apps/web/app/app/opportunities/[id]/page.tsx` | UPDATED — Bid Clock + corroboration panels |
| `apps/web/app/app/organizations/[id]/page.tsx` | UPDATED — Working history section |
| `apps/web/app/app/roi/page.tsx` + `apps/web/app/api/app/roi/route.ts` | UPDATED — Outcomes section/field |
| `docs/source-expansion-audit-2026-07.md` | CREATED |
| `docs/STATUS.md` | UPDATED |

**Registry** (`release/trades-staging`)
| File | Action |
|---|---|
| `apps/registry/src/app/methodology/page.tsx` | CREATED |
| `apps/registry/src/app/[state]/[city]/page.tsx` | UPDATED — never-sold link line (pins intact) |
| `apps/registry/src/app/api/badges/contractor/[slug]/route.ts` | CREATED |
| `apps/registry/src/app/trades/pulse/page.tsx` | CREATED |
| `apps/registry/src/app/contractor/[slug]/page.tsx` | UPDATED — claimable prop |
| `apps/registry/src/components/ContractorProfilePage.tsx` (+ module.css) | UPDATED — claim band |
| `scripts/pseo-quality-gate.mjs` | UPDATED — 7 pins |

## Deviations from Plan

1. **E1 was an extension, not a build.** GateGuard's read-first check surfaced an existing `bid-window.ts` richer than the planned one (per-trade windows already split drywall vs paint — partially anticipating the owner's trade-scoping directive). Kept it; added only the account-capability scoping layer and the missing web surface. The planned `stage-lag`-based design was discarded in favor of the incumbent.
2. **Owner amendment honored structurally:** window claims are keyed to `CAPABILITY_TRADE_WINDOWS`; an account whose trades carry no stated model renders NOTHING. Existing digest/export callers still emit drywall/paint unconditionally — behaviorally correct while Solis is the only account; migrating them to the scoped API is the recorded E1-digest backlog item (digest renderer frozen until the first Monday send).
3. **Badge embed snippet on `/methodology`, not `/for-owners`.** The for-owners page has zero vertical branching (shared BJJ-ladder copy served to trades — a pre-existing content mismatch out of this wave's scope). The methodology page is trades-gated and already the claims anchor. The profile claim CTA still points at `/for-owners` per the nav convention.
4. **Pulse build-time fetch fails honestly** in envs without the `insights_public` views (try/catch → 404) and ISR-refetches hourly against the live DB — same posture as the activity/score reads.

## Issues Encountered
- `p.last_material_change_at` → the column lives on `opportunities` (workingHistory query) — caught by the 5 pre-existing relationships DB tests, fixed, 706/706.
- GateGuard first-touch denials (~6) — cleared by stating facts; twice its read-first/redundancy checks did real work (existing bid-window lib + existing test file, both would otherwise have been clobbered).

## Backlog (recorded in the archived plan)
F1 second design-partner account (**owner decision — highest leverage**), F2b county adapters (audit priorities: Snohomish → Clark → Spokane City), F3 wizard, H2 owner-verified facts loop (needs claims), G3-full OTN-9 claim flow, E1-digest scoped windows. Wave-1 backlog carries unchanged.

## Next Steps
- [ ] Owner: F1 partner decision; review queue + first digest (Wave-1 runbook)
- [ ] On first-send stability: migrate digest bid-window lines to `accountBidWindows` (E1-digest)
- [ ] C4/pulse index flip after the human content pass
