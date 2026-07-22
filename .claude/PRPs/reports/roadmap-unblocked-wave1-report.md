# Implementation Report: Roadmap Wave 1 — Unblocked A/B/C/D + Backlog

## Summary
Shipped every roadmap item that was actually unblocked once probed: A1 review-queue velocity UI (Insights), A3 recent-projects profile section (registry, view applied live), D3 agentic robots split + `/llms.txt` (registry), and two operator docs (first-digest/invite runbook, Codex domain handoff). C3 geo-hydration was **deferred to backlog on evidence** — the coordinate source is empty, so a hydration script would be dead code. No scoring surface was touched; §12.3 stays frozen by construction.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Medium | Medium |
| Confidence | 8/10 | Held — the one miss (C3) was a data-vs-schema gap the plan flagged as its residual unknown |
| Files Changed | ~14 | 12 (C3 script not created — deferred) |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | A1 review page data layer | ✅ Complete | `?limit=` (1–200/50) + per-rule filter over the fetched window |
| 2 | A1 evidence display | ✅ Complete | dense evidence cell for `binding_name_match` rows; missing fields render nothing |
| 3 | A1 selection + batch + keyboard | ✅ Complete | client sequential loop over the per-id endpoint; skipped ≠ error; j/k/x/a/r |
| 4 | A2/B1 first-digest runbook | ✅ Complete | commands verified against package.json; env names only |
| 5 | C1 Codex domain handoff | ✅ Complete | real tables/columns; read-only boundary; adapter grep recorded |
| 6 | A3 registry view + profile | ✅ Complete | migration + baseline 30 (byte-identical) + census; applied live (10 cols, 0 rows) |
| 7 | C3 geo-hydration | ⚠️ Deferred → backlog | evidence-based: no coordinate source data exists (see Deviations) |
| 8 | D3 robots split + llms.txt | ✅ Complete | fixed a real live-assist-blocking defect; site-key-aware llms.txt route |
| 9 | Close-out | ✅ Complete | validation, live apply, STATUS/report/memory, commits/push, archive |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis | ✅ Pass | Insights `pnpm -r typecheck` 11/11; registry `tsc --noEmit` 0 errors |
| Unit Tests | ✅ Pass | registry `test:security` 64/64; no new unit tests (A1 is UI — no unit harness; decision endpoint unchanged so its DB tests still cover it) |
| Build | ✅ Pass | registry BOTH site keys (`onetradenetwork` + `bjj`) — `/robots.txt` + `/llms.txt` render |
| Eval gates | ✅ Byte-identical (by construction) | no scoring code changed (only admin UI + docs); §12.3 frozen |
| pSEO gate | ✅ Pass | 0 failures (no pinned copy changed) |
| Hosted apply | ✅ Verified | `trades_activity_v1` now 10 cols incl. `recent`; 0 rows (honest-empty) |

## Files Changed

**Insights** (`claude/tmux-install-320aiz`)
| File | Action |
|---|---|
| `apps/web/app/app/admin/registry-review/page.tsx` | UPDATED — searchParams limit/rule, per-rule counts, evidence extraction, client table |
| `apps/web/app/app/admin/registry-review/actions.tsx` | UPDATED — `RegistryReviewTable` (selection, keyboard, sequential batch), evidence cell |
| `docs/runbooks/first-digest-and-invite.md` | CREATED |
| `docs/handoff-codex-domains.md` | CREATED |
| `docs/STATUS.md` | UPDATED — Wave-1 entry |

**Registry** (`release/trades-staging`, worktree `trades-google-place-integration-v2`)
| File | Action |
|---|---|
| `apps/registry/supabase/migrations/20260722130000_trades_activity_recent.sql` | CREATED (applied live) |
| `db/baseline-v1.2/30_trades_activity_recent.sql` | CREATED (byte-identical mirror) |
| `db/baseline-v1.2/README.md` | UPDATED — census row 30 |
| `apps/registry/src/app/contractor/[slug]/page.tsx` | UPDATED — select/parse `recent` |
| `apps/registry/src/components/ContractorProfilePage.tsx` | UPDATED — recent-projects list |
| `apps/registry/src/components/ContractorProfilePage.module.css` | UPDATED — recent list classes |
| `apps/registry/src/app/robots.ts` | UPDATED — live-assist/training split |
| `apps/registry/src/app/llms.txt/route.ts` | CREATED — site-key-aware |

## Deviations from Plan

1. **C3 geo-hydration deferred to backlog (evidence-based).** The plan's premise was "`registry_entity_locations` already stores per-entity lat/lng — hydration is one cheap projection script." A hosted probe (`arbmeioglflvzoffgtii`) showed the opposite of the *data*: `registry_entity_locations` = **0 rows**, `trades_identity_v1.lat/lng` = **100% null**, **0 hydratable tenants**. The columns exist; the data does not. Separately, GateGuard's "no existing file" check surfaced `scripts/geo-hydration-{dry-run,second-pass,third-pass,domain-discovery}.mjs` — an incumbent pipeline that geocodes `tenants` from Census county centroids. Shipping a new projection script would be dead code that reads empty columns and overlaps existing tooling. Per the "verify the evidence supports the action" rule, I built nothing and moved C3 to the plan backlog with the real gate: an upstream **trades geocoding pass** (owner/design decision — precise per-entity geocode vs. extending the Census-centroid pipeline).

2. **D3 corrected a real defect, not just added a comment.** The plan expected to "split" the blocklist; the live blocklist actually had `ChatGPT-User` and `Claude-SearchBot` **blocked**, directly contradicting the recorded owner decision "allow live-assist agents, block training scrapers." The fix removes them from the blocklist and adds an explicit allow rule so a future edit can't silently re-block them.

3. **`test:security` script location.** The plan's `cd apps/registry && npm run test:security` was wrong — it's a repo-root script. Ran from root; 64/64 pass.

## Issues Encountered

- GateGuard fact-forcing fired on the first write to three new registry paths (migration, geo script, llms.txt route); each cleared after restating importers/purpose/schema/instruction. On the geo script the redundancy check did real work — it surfaced the incumbent geo-hydration scripts that reframed C3.
- Migration/baseline byte-identity guaranteed by `cp` + `diff` rather than re-typing.

## Tests Written

| Test File | Tests | Coverage |
|---|---|---|
| (none new) | — | A1 is a client UI over an unchanged endpoint (no unit harness for these components; existing worker DB tests still cover `decideRegistryObservation`). A3 view proven by the live hosted probe. Registry `test:security` 64/64 unchanged. |

## Backlog recorded (with gates)

A2-send (SMTP envs + owner review), B1 Solis invite (owner-run), B2 stated pricing (owner sets the number), B3 billing flip, B4 paid ladder, C2 PALS operator captures, **C3 geo-hydration (upstream trades geocoding pass — reclassified here)**, C4 market index flip (content pass), C3-b map UI, D1 capture cadence, D2 S3 keys, §12.3 calibration (≥50 labels — unblocked by this wave's A1 + the owner review pass).

## Next Steps
- [ ] Owner: work the 262 binding queue in the new A1 UI (this is the flywheel crank; every accept backfeeds strong keys)
- [ ] Owner: run the first digest + invite per the new runbook
- [ ] Codex: populate `root_domain` identifiers per the handoff doc to arm `binding_domain_match`
