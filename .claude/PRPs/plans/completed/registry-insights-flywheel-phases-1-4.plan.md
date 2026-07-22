# Plan: Registry ↔ Insights Data Flywheel (Phases 1–4)

## Summary
Compound the value of the co-located Registry + Insights system by (1) computing confidence from cross-references the corpus already stores (corroboration, lifecycle depth, contradictions), (2) making the identity seam bidirectional in *value* (GC Radar in the cockpit; permit-activity trust signals on registry profiles), (3) publishing aggregate demand data nobody else has (Trade Demand Index, jurisdiction speed benchmarks), and (4) capturing every human decision as a calibration label from day one. No new sources, no new scraping — every phase derives from data already flowing.

## User Story
As a trades customer (Solis), I want opportunities that carry independently-corroborated confidence and rich GC context, so I bid the right projects earlier than competitors.
As the registry owner, I want Insights activity to make trades profiles visibly alive, so contractors claim profiles and convert into Insights accounts.

## Problem → Solution
Evidence, multi-source clusters, registry identity, and human promote/dismiss decisions all exist but are not cross-computed → derive corroboration/stage-depth/contradiction signals, assemble GC dossiers, publish aggregates, and log every decision with a feature snapshot so §12.3 calibration runs on real labels.

## Metadata
- **Complexity**: XL (4 phases; execute and commit per-phase, each phase independently shippable)
- **Source PRD**: N/A (inline strategy plan approved in-session 2026-07-21)
- **Estimated Files**: ~30 across two repos
- **Repos / trunks** (Governance #9: commit → push immediately; NEVER main):
  - Insights: `C:\Users\Snipe\Downloads\TradesInsights`, branch `claude/tmux-install-320aiz`
  - Registry: `C:\Users\Snipe\Downloads\WA JiuJitsu Registry-20260608T183757Z-3-001\.claude\worktrees\trades-google-place-integration-v2`, branch `release/trades-staging`

---

## Governance constraints (verbatim, all phases — violations are plan failures)
1. **§12.3 scoring freeze**: weights FROZEN until Solis calibration. Every new input is a score-neutral `signals[]` entry ONLY. The single existing exception (clamped +3 `warm_gc_active` nudge, `scoring.ts:601`) must NOT gain siblings. `scoring.test.ts` pins scores — those pins must not change.
2. **No fabricated fields**: unknown = null, never guessed/zero. Contradiction handling NEVER picks a winner.
3. **Person-vs-business gate**: homeowner/individual PII never crosses into the registry bridge; address matching restricted to licensed-entity identifiers.
4. **Least-privilege seam**: Insights reads `registry_public.*` only, writes `registry_partner.*` only. Cockpit reads `insights_public.*` views only (definer views, `insights_cockpit_reader` grants).
5. **Registry is another party's production data**: additive DDL under `_v1` contract views; byte-equivalent baseline mirror patch per migration (next free patch number — 23/24 already consumed; CHECK before numbering).
6. **Small-n suppression** for all public aggregates: suppress below n≥5 (Registry Score sample-gate precedent); always disclose the ranking/index basis in copy (pSEO gate pins disclosure copy — extend pins, don't fight them).
7. **Never run two maintenance passes concurrently** (resolver races). Hosted DB = production; local vitest guard forces the Docker DB (PG_PORT=5433 on this machine).
8. **Weekly digest idempotency**: DELETE draft `delivery_items` + `deliveries` before `digest:run` re-runs, or the stale draft returns.
9. Migration ledgers stay disjoint: Insights = drizzle journal (`packages/db/migrations/meta/_journal.json`, next idx 27); Registry = supabase ledger. Never write FK refs qualified `"public".` (fresh-provision bug, fixed `efa8974`).

---

## UX Design

### Before
```
Cockpit opportunity row: [name] [band] [⚡easy-win] [county]        — no "why trust this"
Registry trades profile: L&I facts only                             — looks dead, no claim reason
Digest item: project facts                                          — no corroboration statement
Promote/dismiss: state flips; dismissals→feedback, promotes→nothing — labels evaporating
```

### After
```
Cockpit row: … [◆ 3 sources] [▲ progressing: NOA→applied] [GC: Acme Const. ★4.6 · active]
GC Radar page: /app/orgs/[id] — license status, permit velocity, active projects, contacts
Registry profile: "12 permits in the last 12 months (via OTN Insights)" → Claim CTA
Registry pSEO: /trades/market/thurston/glazing — demand index + permit-speed benchmark
Every promote/dismiss/pursuit-outcome → decision_labels row with feature snapshot
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| `cockpit_opportunities_v1` | is_easy_win only | + corroborated_source_count, stage_depth, has_contradiction | view-only, additive |
| Digest item render | facts + easy-win | + "seen independently in N sources" line | disclosure, not scoring |
| Opportunity state POST | dismissals→feedback | ALL decisions→`decision_labels` w/ snapshot | Phase 1 — before owner reviews the 25 queued items |
| Registry trades profile | static L&I | activity badge (registry_partner data) | claimed + unclaimed |
| Trades directory | alphabetical-ish | Contractor Activity Score rank (Phase 4, disclosed basis) | display-only |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `packages/intelligence/src/scoring.ts` | 84–110, 350–620 | signals[] contract; the ONE nudge exception at :601; DISPOSITION_REASONS export |
| P0 | `packages/delivery/src/digest.ts` | 25–40, 150–170, 760–870 | DigestItem, reviewQueue, suppressed-counts disclosure |
| P0 | `packages/delivery/src/deliver.ts` | easyWins block | metadata_json persistence pattern (single-source-of-truth rule) |
| P0 | `packages/db/migrations/0026_cockpit_easy_win.sql` | all | insights_public view evolution + re-GRANT pattern |
| P0 | `apps/web/app/api/app/opportunities/[id]/state/route.ts` | all | withAccount route + existing feedback insert — D1 extends THIS |
| P0 | `packages/resolution/src/registry-link.ts` | 70–235 | buildRegistryIndex / matchOrganizationToRegistry / linkRegistry |
| P0 | `packages/resolution/src/registry-observations.ts` | all | DORMANT address-binding rule — Phase 2 activates it |
| P1 | `apps/worker/src/schedules.ts` | runMaintenance | chain order: resolve→geocode→registry-link→score; new derivations slot in here |
| P1 | `apps/worker/test/cockpit-views.test.ts` | all | viewRows helper, RUN tag (letters-only — digit tags trip address-in-name guard), fixture style |
| P1 | `packages/db/migrations/meta/_journal.json` | tail | journal append (next idx 27) |
| P1 | Registry `apps/registry/src/lib/insightsCockpit.ts` | all | cockpit fetch/map pattern (bounded pool, honest empty/error panels, zero POSTs from registry side) |
| P1 | Registry `scripts/ingest-otn-insights.mjs` | all | registry_partner write path (B2 reads what this lands) |
| P2 | `docs/runbooks/registry-seam-golive.md` | Part C | two-ledgers rule, connection contract, posture SQL |
| P2 | Registry pSEO gate test (search `pseo` in `apps/registry/src/**/*.test.*`) | all | disclosure-copy pins to extend for C1/C2 |
| P2 | `packages/intelligence` extract/verify CLIs | all | verifier prior injection point (A3) |

## External Documentation
None needed — all phases use established internal patterns.

---

## Patterns to Mirror

### SCORE_NEUTRAL_SIGNAL
```ts
// SOURCE: packages/intelligence/src/scoring.ts:484-541 (abridged, real)
const signals: string[] = [];
if (c.isTi) signals.push("tenant_improvement");
// rationale/digest but score-neutral until customer calibration.
if (f.campusBlock) signals.push("active_campus");
if (/* registry-verified GC on project */) signals.push("verified_gc_on_project");
// finalScore computed from FROZEN weights; signals ride alongside.
```

### REVIEW_QUEUE_DISCLOSURE
```ts
// SOURCE: packages/delivery/src/digest.ts:158-166, 767-801
reviewQueue: DigestItem[];
suppressed: { gateFailed: number; blockedOnVerifier: number; customerSuppressed: number };
// gate?.status === "blocked_on_verifier" → suppressed.blockedOnVerifier++ …
// Withheld counts are DISCLOSED in section 5 — never silent.
```

### METADATA_SINGLE_SOURCE_OF_TRUTH
```ts
// SOURCE: packages/delivery/src/deliver.ts (easyWins block)
// Persisted so the co-located cockpit view shows exactly what this email showed —
// the digest stays the single source of truth; the view never re-derives it.
easyWins: model.easyWins.map((i) => i.opportunityId),
```

### INSIGHTS_VIEW_MIGRATION
```sql
-- SOURCE: packages/db/migrations/0026_cockpit_easy_win.sql
CREATE OR REPLACE VIEW insights_public.cockpit_opportunities_v1 AS ...;
GRANT SELECT ON insights_public.cockpit_opportunities_v1 TO insights_cockpit_reader;
-- + append {"idx": N, "tag": "00NN_name", ...} to meta/_journal.json
```

### ACCOUNT_SCOPED_ROUTE
```ts
// SOURCE: apps/web/app/api/app/opportunities/[id]/state/route.ts:17-33
export const POST = withAccount<{ id: string }>(async ({ db, session, account, params, req }) => {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "invalid state body");
  // ... UPDATE guarded by account_profile_id; feedback INSERT on dismiss
});
```

### DB_VIEW_TEST
```ts
// SOURCE: apps/worker/test/cockpit-views.test.ts
const rows = await viewRows<OppRow>(
  "SELECT ... FROM insights_public.cockpit_opportunities_v1 WHERE account_key = $1",
  [ACCOUNT_A],
);
// RUN tag must be LETTERS-ONLY: RUN.replace(/[0-9]/g, (d) => "ghijklmnop".charAt(Number(d)))
```

### REGISTRY_COCKPIT_FETCH
```ts
// SOURCE: registry apps/registry/src/lib/insightsCockpit.ts
// account_key-scoped SELECTs against insights_public.* only; bounded pool timeouts;
// map rows to camelCase interfaces (isEasyWin: r.is_easy_win === true);
// honest empty/not-provisioned/error panels; ZERO POST routes on the registry side.
```

### REGISTRY_MIGRATION_DISCIPLINE
```
// SOURCE: registry supabase migration flow used for trades_identity_v1 (20260720150000)
// (1) migration SQL additive under registry_public/_v1; (2) byte-identical baseline
// mirror patch at NEXT FREE number (verify — 23/24 consumed); (3) census README row;
// (4) apply to live idempotently; (5) ledger row recorded.
```

---

## Files to Change

### Phase 1 — Corroboration + labels (Insights only)
| File | Action | Justification |
|---|---|---|
| `packages/db/migrations/0027_confidence_signals.sql` | CREATE | `projects.corroboration` jsonb (source_count, stage_depth, contradiction_paths) + `decision_labels` table + view columns + re-GRANT |
| `packages/db/migrations/meta/_journal.json` | UPDATE | append idx 27 |
| `packages/resolution/src/corroboration.ts` | CREATE | derive per-project: distinct source keys, event-chain depth, same-factPath conflicts |
| `packages/resolution/src/corroboration.test.ts` | CREATE | unit + fixture tests |
| `packages/resolution/src/index.ts` | UPDATE | export |
| `apps/worker/src/schedules.ts` | UPDATE | corroboration pass into runMaintenance (after resolve, before score) |
| `packages/intelligence/src/scoring.ts` | UPDATE | push `corroborated_multi_source`, `lifecycle_progressing`, `fact_contradiction` signals (score-neutral) |
| `packages/intelligence/src/scoring.test.ts` | UPDATE | prove finalScore UNCHANGED with signals present |
| `packages/delivery/src/digest.ts` + `render.ts` | UPDATE | "seen independently in N sources" line; contradictions → reviewQueue reason `fact_contradiction` |
| `apps/web/app/api/app/opportunities/[id]/state/route.ts` | UPDATE | ALL decisions insert `decision_labels` w/ feature snapshot (band, signals, gate reasons, county, trade) |
| `apps/worker/test/cockpit-views.test.ts` | UPDATE | new view columns |

### Phase 2 — Fact propagation + GC Radar
| File | Action | Justification |
|---|---|---|
| `packages/intelligence/src/verify*.ts` (verifier entry) | UPDATE | inject cluster-sibling verified facts (≥0.9) as PRIORS w/ provenance (`propagated_from` run id); verifier confirms-or-rejects, never silently inherits |
| `packages/resolution/src/registry-observations.ts` | UPDATE | ACTIVATE dormant address-binding rule (licensed entities only; person-vs-business gate stays closed) |
| `packages/db/migrations/0028_gc_radar.sql` | CREATE | `insights_public.cockpit_orgs_v1` (org ⋈ registry identity: license status, google rating/review_count, permit velocity, active project count) + GRANT |
| `apps/web/app/app/orgs/[id]/page.tsx` (+ queries) | CREATE | Insights-side GC Radar page |
| Registry `apps/registry/src/lib/insightsCockpit.ts` | UPDATE | fetchCockpitOrgs + types |
| Registry `apps/registry/src/app/dashboard/insights/orgs/page.tsx` | CREATE | cockpit GC Radar list/detail (views-only, dark cockpit `:root` vars) |
| tests both repos | UPDATE/CREATE | view tests + registry static pins |

### Phase 3 — Claim flywheel + public data products (Registry-heavy)
| File | Action | Justification |
|---|---|---|
| Registry migration + baseline patch (next free number) | CREATE | `registry_public.trades_activity_v1` aggregate view over registry_partner writes (per-entity permit counts/12mo; small-n rules) |
| Registry trades profile component | UPDATE | "N permits last 12 months (via OTN Insights)" badge + claim CTA (unclaimed) / Insights upsell (claimed) |
| Registry `apps/registry/src/app/(trades)/trades/market/[county]/[trade]/page.tsx` | CREATE | Trade Demand Index pSEO pages (light "Jords" register — public trades UI is LIGHT, cockpit dark) |
| Insights `packages/db/migrations/0029_market_aggregates.sql` | CREATE | `insights_public.market_demand_v1` + `market_permit_speed_v1` (county×trade×month counts, median application→issue days; n≥5 suppression IN the view) |
| Registry sitemap + pSEO gate test | UPDATE | new routes + disclosure-copy pins ("based on permit volume via OTN Insights") |
| Registry claimed-tenant dashboard | UPDATE | "Projects near you" teaser card (counts + bands only, gated detail) |

### Phase 4 — Activity Score + outcomes (post-§12.3-calibration for anything scoring-adjacent)
| File | Action | Justification |
|---|---|---|
| Registry migration + baseline patch | CREATE | `contractor_activity_score` materialization (permit velocity + credential completeness + web presence; basis disclosed; display/ranking ONLY) |
| Registry trades directory pages | UPDATE | rank by Activity Score, disclosure line (mirror BJJ "by academy count & Registry Score" pattern) |
| Insights pursuits surface + `packages/db` | UPDATE | won/lost/no-bid outcome capture → `decision_labels` (kind=`pursuit_outcome`) |
| `docs/calibration-prep-solis.md` | UPDATE | labels inventory + how calibration consumes `decision_labels` |

## NOT Building
- Any scoring-weight change (frozen until §12.3 calibration — Phase 4 prepares labels, does NOT tune).
- New sources/scraping/captures; no new model prompts beyond the verifier-prior injection.
- Valuation inference/estimation (contradiction display cites both; never a synthesized number).
- Public API for aggregates (views + pSEO pages only, this iteration).
- Self-serve Insights billing tier (module stays admin-granted until Solis validates pricing).
- Automatic promote of review-queue items (M4.3 human gate stays).

---

## Step-by-Step Tasks

### Phase 1 (ship + push before starting Phase 2 — D1 must land before the owner reviews the 25 queued Solis items)

**Task 1.1: `decision_labels` + corroboration schema (migration 0027)**
- **ACTION**: One migration: `decision_labels` (id, account_profile_id, opportunity_id, kind promote|dismiss|rescore|pursuit_outcome, decided_by, decided_at, snapshot jsonb, reason, notes) + `projects` corroboration jsonb column + extend `cockpit_opportunities_v1` (corroborated_source_count int, stage_depth int, has_contradiction bool) + re-GRANT.
- **MIRROR**: INSIGHTS_VIEW_MIGRATION. **GOTCHA**: journal idx 27; unqualified FK refs; hosted apply via `pnpm db:migrate` (role-level search_path handles schema).
- **VALIDATE**: `pnpm db:migrate` local; `pnpm --filter @otn/worker test cockpit-views`.

**Task 1.2: corroboration derivation pass**
- **ACTION**: `packages/resolution/src/corroboration.ts` — per project: distinct `source_key` count across cluster records; event-chain stage depth (reuse the event-layer lifecycle WS-C phase_change reads); same-factPath conflicting values across sibling records → contradiction_paths (both values + record ids, NO winner). Wire into `runMaintenance` after resolution, before scoring.
- **MIRROR**: registry-link.ts pass structure (fetch→index→apply→summary log). **GOTCHA**: idempotent (re-derives, never accumulates); Governance #7 concurrency.
- **VALIDATE**: unit tests w/ multi-source fixtures; run `pnpm maintenance:run` locally, spot-check counts.

**Task 1.3: score-neutral signals + digest disclosure**
- **ACTION**: scoring.ts pushes `corroborated_multi_source` (count≥2), `lifecycle_progressing` (depth≥2 + recent transition), `fact_contradiction`. digest render adds "seen independently in N sources"; contradictions route the item to reviewQueue with disclosed reason.
- **MIRROR**: SCORE_NEUTRAL_SIGNAL; REVIEW_QUEUE_DISCLOSURE. **GOTCHA**: do NOT touch finalScore; scoring.test.ts pins must pass unmodified; add tests proving score-with-signal == score-without.
- **VALIDATE**: `pnpm --filter @otn/intelligence test`; `pnpm eval:run` gates PASS unchanged.

**Task 1.4: decision-label capture**
- **ACTION**: state route inserts `decision_labels` for EVERY state change (promote included) with snapshot {band, score, signals, gate status/reasons, county, trade, source_count, stage_depth} read at decision time. Keep the existing feedback insert.
- **MIRROR**: ACCOUNT_SCOPED_ROUTE. **GOTCHA**: snapshot is jsonb copied at decision time (labels must reflect what the human SAW, not later re-derivations).
- **VALIDATE**: route test: promote → row with populated snapshot; dismiss → decision_labels + feedback both.

**Task 1.5: Phase-1 close-out** — full suite + typecheck + eval gates; rebuild digest drafts (Governance #8: delete drafts first); commit/push Insights; STATUS.md entry.

### Phase 2

**Task 2.1: verified-fact propagation (A3)** — verifier prior injection for cluster siblings; provenance `propagated_from`; prior CONFIRMED not inherited; blocked_on_verifier counts should drop. **GOTCHA**: budget triple-gate untouched; priors never skip verification. **VALIDATE**: intelligence tests + a bounded live `verify:run --limit 10` spend check.

**Task 2.2: activate dormant address binding (A5)** — registry-observations.ts rule ON for licensed entities via `trades_identity_v1` mailing addresses + `applCustSysId` (identifier class already promoted, migration 0024). **GOTCHA**: person-vs-business gate; conservative normalization (fails closed). **VALIDATE**: registry-observations tests + link-rate delta logged, spot-check 10 matches manually.

**Task 2.3: `cockpit_orgs_v1` + GC Radar (B1)** — migration 0028 view (org ⋈ registry identity ⋈ permit velocity ⋈ active projects); Insights `/app/orgs/[id]` page; registry cockpit orgs page via insightsCockpit.ts additions. **MIRROR**: REGISTRY_COCKPIT_FETCH (views-only, zero POSTs registry-side). **GOTCHA**: global public-business phone only; PII exclusions of 0025 carry over; L&I phone authoritative. **VALIDATE**: cockpit-views tests (PII assertions included); registry `npm run test:security` + both site keys build.

**Task 2.4: close-out** — suites both repos, eval gates, commit/push both trunks, STATUS.md.

### Phase 3

**Task 3.1: `trades_activity_v1` + profile activity badge (B2)** — registry aggregate view over registry_partner data; badge on trades profiles ("N permits in the last 12 months (via OTN Insights)"); claim CTA wiring. **MIRROR**: REGISTRY_MIGRATION_DISCIPLINE; TrustMarksGrid-style shared component. **GOTCHA**: baseline patch number check; light register for public trades UI; unclaimed profiles = reversible curated data only.
**Task 3.2: market aggregate views (C1/C2 backend)** — Insights migration 0029: `market_demand_v1` (county×trade×month, taxonomy from WS-T loop) + `market_permit_speed_v1` (median application→issue days per jurisdiction); n≥5 suppression INSIDE the views; GRANT to reader.
**Task 3.3: pSEO market pages (C1/C2 frontend)** — `/trades/market/[county]/[trade]` reusing the `[page]`-segment constraint lesson (never a new dynamic sibling under an existing dynamic segment); JSON-LD Dataset; sitemap; disclosure copy pinned in pSEO gate.
**Task 3.4: projects-near-you teaser (C3)** — claimed-tenant card: matched counts + bands ONLY (no addresses/names), "unlock with Insights" CTA.
**Task 3.5: close-out** — pSEO gate + security suite + builds; commit/push; STATUS.md.

### Phase 4 (gate: §12.3 calibration session scheduled or done for anything touching scoring; score/rank display work may proceed)

**Task 4.1: Contractor Activity Score (B3)** — registry-side score (permit velocity + credential completeness + web presence); directory ranked by it with disclosed basis; sample-gated like Registry Score. NEVER fed into Insights opportunity scoring.
**Task 4.2: pursuit outcomes (D2)** — won/lost/no-bid on pursuits → `decision_labels` kind=`pursuit_outcome`; cockpit pursuits UI affordance.
**Task 4.3: calibration prep** — `docs/calibration-prep-solis.md`: label inventory queries, per-account precision readout, proposed calibration agenda.
**Task 4.4: close-out** — suites, gates, push, STATUS.md + memory update.

---

## Testing Strategy

| Test | Input | Expected | Edge |
|---|---|---|---|
| corroboration: 3-source cluster | records from 3 source_keys | source_count=3, signal emitted | ✓ |
| corroboration: single source | 1 record | count=1, NO signal | ✓ |
| contradiction: two valuations | same factPath, different values | contradiction_paths both cited, no winner, reviewQueue reason | ✓ |
| score neutrality | opp ± new signals | finalScore identical | pin |
| decision label: promote | POST state=promoted | decision_labels row, snapshot populated | |
| decision label: dismiss | POST + reason | decision_labels AND feedback rows | |
| fact propagation | verified sibling fact | prior passed w/ provenance; verifier still runs | rejected-prior case ✓ |
| address binding | licensed entity mailing addr = applicant addr | link; individual/person addr → NO link | fails-closed ✓ |
| orgs view PII | private-source org | excluded (0025 assertions carried) | ✓ |
| market view small-n | county×trade with 3 opps | row suppressed | ✓ |
| activity badge | entity w/ partner rows | badge; zero rows → no badge (never "0 permits") | honest-empty ✓ |

Checklist: empty clusters; projects with no events; concurrent maintenance guard; non-local DATABASE_URL test guard intact; registry pages build under BOTH site keys.

## Validation Commands
```bash
# Insights (per phase)
cd C:/Users/Snipe/Downloads/TradesInsights
pnpm typecheck && pnpm test          # vitest guard forces local Docker DB (PG_PORT=5433)
pnpm db:migrate                       # local, then hosted (env DATABASE_URL)
pnpm eval:run                         # gates must PASS unchanged
pnpm maintenance:run                  # ONE pass; verify derivation counts in logs

# Registry (per phase touching it)
cd "C:/Users/Snipe/Downloads/WA JiuJitsu Registry-20260608T183757Z-3-001/.claude/worktrees/trades-google-place-integration-v2"
npm run typecheck && npm run test:security   # incl. pSEO gate + static pins
npm run build                                # both site keys
```

## Acceptance Criteria
- [ ] Phase gates in order; each phase committed+pushed to its trunk before the next starts
- [ ] All suites green both repos; eval gates PASS unchanged after every phase
- [ ] scoring.test.ts pins unmodified (§12.3 intact)
- [ ] Every new cockpit surface reads `insights_public.*` views only
- [ ] Public aggregates n≥5-suppressed with disclosed basis
- [ ] decision_labels populated by real promote/dismiss actions (verify after owner's first review pass)

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| New signal accidentally shifts score | Med | High | neutrality tests + untouched pins; review diff of scoring.ts for any weight-adjacent change |
| Address binding links a person | Low | High | licensed-entity-only + fails-closed normalization + manual spot-check 10 |
| Aggregate leaks identifiable project | Low | Med | suppression inside the SQL view (not the page) |
| Registry patch-number collision | Med | Low | check patches dir before numbering (23/24 precedent) |
| Verifier priors bias confirmation | Med | Med | prior is CANDIDATE not default; rejected-prior test; disclose propagation in evidence |
| Owner reviews queue before D1 lands | High | Med (labels lost) | Phase 1 first; tell owner to hold review until Task 1.4 ships |
| Scope sprawl (4 phases, 2 repos) | Med | Med | per-phase close-out tasks are hard commits; each phase independently valuable |

## Notes
- Strategy approved in-session 2026-07-21 (Phases 1–4 sequencing confirmed by owner via /prp-plan invocation).
- `feedback` table + DISPOSITION_REASONS already exist — D1 extends, does not replace.
- The registry-address rule (Task 2.2) was shipped DORMANT in an earlier session precisely for this activation.
- Solis's queue of 25 verified items is the first real label source — Phase 1 is deliberately small so it lands before those decisions happen.
