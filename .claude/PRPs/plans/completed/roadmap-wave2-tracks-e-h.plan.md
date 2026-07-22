# Plan: Roadmap Wave 2 — Tracks E–H (Insights depth + OTN uniqueness) + Backlog

## Summary
Executes all unblocked items from the 2026-07-22 Wave-2 strategic plan: **E** Insights product depth (Bid Clock, GC Copilot, outcome attribution, corroboration panel), **F** platform leverage (verify-first source-expansion audit doc only), **G** OTN value perception (methodology/never-pay-to-rank, contractor badge embed, claim CTA, Construction Pulse), **H** seam-as-moat (bidirectional attribution folded into G1; jurisdiction transparency folded into G4). Everything blocked on an owner decision or a prerequisite goes to the **Backlog** section with its named gate.

## Problem → Solution
- The most differentiated data (when the bid window is) is buried as one prose sentence in the memo → a first-class Bid Clock panel with the domain rules from `docs/domain-bid-timing.md`.
- The deferred GC-relationship lane was gated on the registry; the seam is live and `registryIdentity` already renders on the org page → compose working history + outreach into a copilot surface.
- Corroboration/`decision_labels` exist but nothing rolls them up → evidence panel + outcome attribution.
- OTN's structural difference (records-based, never pay-to-rank) is implicit → state it (methodology page), embed it (badge), monetize the on-ramp (claim CTA), publish it (Pulse page).

## Metadata
- **Complexity**: Large (two repos, ~19 files, 11 tasks — but every task is composition over existing primitives; no new migrations expected)
- **Repos**: Insights `TradesInsights` (branch `claude/tmux-install-320aiz`); Registry worktree `trades-google-place-integration-v2` (branch `release/trades-staging`)
- **Migrations**: none planned (Insights drizzle stays 31-next; registry baseline stays 31-next). If a task discovers it needs one, STOP and re-plan.
- **Estimated files**: ~19

## Constraints carried (unchanged governance)
§12.3 FROZEN — every E-track item is display-only and must never enter scoring (prove with `eval:run` byte-identical, since intelligence-package files are touched); unknown = null / honest-empty everywhere (Bid Clock renders nothing without a lag estimate; attribution renders honestly-sparse with few labels); no digest render changes this wave (first Monday send must ship from a stable digest); registry copy changes must keep every existing pSEO-gate pin passing; never pay-to-rank stays literal (Activity Score never sellable); commit→push per repo after validation.

---

## Mandatory Reading
| Priority | File | Why |
|---|---|---|
| P0 | Insights `packages/intelligence/src/stage-lag.ts` (all, 111 lines) | `stageLagEstimate(db, county, permitClass)` + `permitClassOf(applicationType, permitType)` — E1's primitives; `STAGE_LAG_MIN_SAMPLES = 20` floor |
| P0 | Insights `packages/intelligence/src/memo.ts:240-269` | The lagNote precedent: how the memo loads the newest active record's applicationType/permitType for `permitClassOf`, and the labeled-inference copy style |
| P0 | Insights `docs/domain-bid-timing.md` | THE domain rules: residential window = `issued + 4wk … issued + 8wk` (after ~10wk likely let); commercial window = OPEN during plan review/entitlement/SEPA, 2–6 months PRE-issuance |
| P0 | Insights `apps/web/app/app/opportunities/[id]/page.tsx` | E1/E4 anchor — panel placement (Bid Clock after the header `<p>` badges, before `o.brief`; corroboration after "Score components"), Badge/section styling |
| P0 | Insights `apps/web/lib/queries.ts` — `opportunityDetail` | E4 needs `projects.corroboration` added to the detail SELECT + returned shape |
| P0 | Registry `apps/registry/src/app/api/badges/gym/[slug]/route.ts` | G2's exact mirror: server-rendered zero-JS SVG, `escapeXml`, tenant lookup by slug, honest fallback label when unverified |
| P0 | Registry `apps/registry/src/app/trades/market/[county]/[trade]/page.tsx` | G4's data mechanism: direct `query()` of `insights_public.market_demand_v1` / `market_permit_speed_v1` (co-located DB); vertical gating; noindex-initial pattern; pinned basis copy style |
| P1 | Insights `apps/web/app/app/organizations/[id]/page.tsx` | E2 anchor — registryIdentity panel, publicRoles, contacts, `RelationshipActions`; extend, don't rebuild |
| P1 | Insights `packages/resolution/src/corroboration.ts:90-110` | Corroboration jsonb shape: `{sources: [...], stageDepth, contradictions: [{field, values, recordIds}]}` — E4 renders exactly this |
| P1 | Insights `packages/delivery/src/roi.ts` (`roiScorecard`, `addOutcome`) + `packages/delivery/src/pipeline.ts` | E3 composes here; ROI page = `apps/web/app/app/roi` + `/api/app/roi` |
| P1 | Insights `packages/intelligence/src/pursuit.ts` (decision-label insert) | E3's data: `decision_labels kind='pursuit_outcome'` snapshot shape (outcome, fromState, values, county, route, score) |
| P1 | Registry `apps/registry/src/components/ContractorProfilePage.tsx` | G3 CTA placement (after trust chips header block); styles module conventions |
| P1 | Registry `scripts/pseo-quality-gate.mjs` | Which copy strings are pinned — G1/G4 add pins, must not break existing ones |
| P2 | Insights `.claude/skills` `source-adapter` skill (activation checklist §1-3) | F2a audit discipline: verify official publisher LIVE, record access URL/format/cadence, robots/ToS — recon ONLY |
| P2 | Insights `apps/web/app/api/app/opportunities/[id]/outreach/route.ts` | E2 links to the existing outreach draft affordance — do not duplicate it |

## Patterns to Mirror

### LABELED_INFERENCE_COPY — memo.ts:253
```ts
lagNote = ` Historically, ${permitClassOf(row.a, row.pt)} permits in ${o.county} issue ~${Math.round(est.medianDays / 7)} weeks after application (p25–p75 ${Math.round(est.p25Days)}–${Math.round(est.p75Days)} days, n=${est.n}) — an inference from past lags, not a promise.`;
```

### SAMPLE_FLOOR — stage-lag.ts:103
```ts
if (!r || Number(r.n) < STAGE_LAG_MIN_SAMPLES) return null;  // null below floor, never guessed
```

### PAGE_SECTION — opportunities/[id]/page.tsx:93-96
```tsx
<section data-testid="decision-memo" style={{ border: "1px solid #ddd", borderRadius: 8, padding: "1rem", margin: "1rem 0" }}>
```

### BADGE_SVG_ROUTE — api/badges/gym/[slug]/route.ts:14-33
```ts
export async function GET(request: Request, props: { params: Promise<{ slug: string }> }) {
  const { slug } = await props.params;
  const gymRes = await query(`SELECT name, claim_status, owner_id FROM public.tenants WHERE slug = $1 LIMIT 1`, [slug]);
  // honest fallback label when unverified; edge-cached zero-JS SVG response
```

### MARKET_VIEW_READ — trades/market/[county]/[trade]/page.tsx:58
```ts
`SELECT month, projects FROM insights_public.market_demand_v1 …`  // direct co-located read; render only what the sample-gated view serves
```

### HONEST_EMPTY — ContractorProfilePage / trades_activity render
Render only when data exists; never a fabricated zero/row.

---

## Files to Change

**Insights**
| File | Action | Why |
|---|---|---|
| `packages/intelligence/src/bid-window.ts` | CREATE | E1: pure `bidWindow()` (stage, permitClass, issuedAt/appliedAt, lagEstimate → {state: 'open'\|'opens_future'\|'likely_let'\|'pre_permit_open'\|null, opensAt?, closesAt?, note}) implementing domain-bid-timing rules; + `loadBidWindow(db, opportunityId)` reusing memo.ts's record-class query + `stageLagEstimate` |
| `packages/intelligence/src/bid-window.test.ts` (or `apps/worker/test/`) | CREATE | E1 unit tests: residential issued→open/opens/likely-let; commercial pre-permit→open; no estimate→null note; never throws on null dates |
| `packages/intelligence/src/index.ts` | UPDATE | export bid-window |
| `apps/web/app/app/opportunities/[id]/page.tsx` | UPDATE | E1 Bid Clock panel (distinct border color, "labeled inference" footer) + E4 corroboration panel (sources count/list, stageDepth, contradictions both-values table) |
| `apps/web/lib/queries.ts` | UPDATE | E4: add `p.corroboration` to opportunityDetail SELECT + type |
| `packages/intelligence/src/organization-view.ts` (locate `getOrganizationView` at impl) | UPDATE | E2: add `workingHistory` (this account's pursuits/opportunities on projects where this org holds a role: name, state, outcome, last activity) — composition query, no schema change |
| `apps/web/app/app/organizations/[id]/page.tsx` | UPDATE | E2: "Working history" section + per-row link to the opportunity (outreach affordance lives there); `warm_gc_active` badge when the newest shared opportunity carries the signal |
| `packages/delivery/src/roi.ts` | UPDATE | E3: `outcomeAttribution(db, accountProfileId)` — decision_labels `pursuit_outcome` rollup: counts + won/lost $ by county and by route; honest-sparse |
| `apps/web/app/app/roi/page.tsx` + `apps/web/app/api/app/roi/route.ts` | UPDATE | E3: "Outcomes" section + API field |
| `docs/source-expansion-audit-2026-07.md` | CREATE | F2a: verify-first recon (live web) of Snohomish/Clark/Spokane county permit portals + WA state procurement (WEBS) — publisher, access URL, format, cadence, robots/ToS, egress class, recommendation; NO adapters |
| `docs/STATUS.md` | UPDATE | close-out |

**Registry**
| File | Action | Why |
|---|---|---|
| `apps/registry/src/app/methodology/page.tsx` (trades-gated; check route conventions at impl — mirror a static page like `/suppliers`) | CREATE | G1+H1: how rankings/Activity Score/verification work; data provenance both directions (L&I + OTN Insights ↔ registry identity); "We never sell ranking. Activity Score cannot be bought." |
| `apps/registry/src/app/[state]/[city]/page.tsx` | UPDATE | G1: one line + link under the existing ranking disclosure: "Ranking is never sold — see how it works." → /methodology |
| `apps/registry/src/app/api/badges/contractor/[slug]/route.ts` | CREATE | G2: MIRROR gym badge route — tenant by slug → `registry_internal.contractor_activity_score_v1` by tenant_id → SVG "Verified Washington Contractor · Activity Score N" (unscored ⇒ "Registry Listing" variant, never a 0) |
| `apps/registry/src/app/for-owners/page.tsx` (locate exact file at impl) | UPDATE | G2: embed-snippet block (`<img src=".../api/badges/contractor/{slug}" …>`); G3 support copy |
| `apps/registry/src/components/ContractorProfilePage.tsx` (+ module.css) | UPDATE | G3: "Is this your business?" band → /for-owners (what claiming unlocks: control listing, verified badge embed, permit-activity insights) |
| `apps/registry/src/app/trades/pulse/page.tsx` | CREATE | G4+H3: "WA Construction Pulse" — top county×trade combos (market_demand_v1), 6-month trend, jurisdiction permit-speed table (market_permit_speed_v1, the H3 transparency section); JSON-LD Dataset; **noindex-initial** (market-page precedent); basis copy pinned |
| `scripts/pseo-quality-gate.mjs` | UPDATE | new pins: methodology "never sell ranking" claim, pulse basis copy + noindex |

## NOT Building
- Any digest/render changes (Bid Clock line in the digest = follow-up after the first real send).
- Any scoring/§12.3 change; bid-window is display-only and never read by routers.
- Adapters for new counties (F2a is recon-only); the full OTN-9 public claim flow (CTA links to /for-owners); badge purchase/paid placement of any kind; email/outreach sending.
- New migrations, new API surfaces beyond the badge route, schema changes.

---

## Step-by-Step Tasks

### Task 1 — E1a `bid-window.ts` + tests
- **ACTION**: Pure `bidWindow(input)` implementing domain-bid-timing: permitClass `residential`+stage `permit_issued` → opensAt=issued+28d, closesAt=issued+56d, state open/opens_future/likely_let (>70d past issue); permitClass `commercial` (or `land_use`) + pre-issuance stage (`preapplication|entitlement|permit_applied|approved`) → state `pre_permit_open` with note "commercial buyout happens 2–6 months before issuance — the window is now" + expected issuance from lagEstimate when present; residential pre-issuance → opens ≈ expectedIssue+28d (only when lagEstimate ≠ null, else state null); `trade`/`other` classes → lag-note only (no window claim). Loader mirrors memo.ts:244-251.
- **MIRROR**: LABELED_INFERENCE_COPY, SAMPLE_FLOOR. **GOTCHA**: every date input nullable — return null state rather than guessing; NEVER import from scoring modules.
- **VALIDATE**: `npx vitest run packages/intelligence/src/bid-window.test.ts` (run from repo root — package-filtered vitest finds nothing); `pnpm -r typecheck`.

### Task 2 — E1b Bid Clock panel
- **ACTION**: opportunity page: after the header `<p>`, a `data-testid="bid-clock"` section (green-tinted border like the brief) rendering state-specific headline ("Bid window OPEN — closes ~{date}" / "Opens ~{date}" / "Commercial pre-permit window — bid NOW" / "Likely already let") + the p25–p75/n basis line + "an inference from past lags, not a promise" footer. Render nothing when state null.
- **MIRROR**: PAGE_SECTION, HONEST_EMPTY. **VALIDATE**: typecheck; manual dev render on one `permit_issued` residential + one pre-issuance commercial opportunity.

### Task 3 — E4 corroboration panel
- **ACTION**: `opportunityDetail` selects `p.corroboration`; page renders (when non-null) "Independently seen in N public sources" + source keys, stage depth, and a contradictions list showing BOTH values + fields ("valuation stated as $X and $Y by different records") — never a resolved winner.
- **MIRROR**: corroboration.ts jsonb shape; HONEST_EMPTY. **VALIDATE**: typecheck; a seeded/hosted project with corroboration renders; null renders nothing.

### Task 4 — E2 GC Copilot (org page)
- **ACTION**: extend `getOrganizationView` with `workingHistory`: for this account, opportunities on projects where the org holds an active role — name, opportunity state, pursuit state/outcome (join pursuits when present), last activity; ordered newest-first, cap 20. Page: "Working history with {name}" table, each row linking to the opportunity (where memo/outreach live); surface `warm_gc_active` badge when present in the newest shared opportunity's signals.
- **MIRROR**: existing view composition in the same file; league-table row style. **GOTCHA**: relationship state is account-private — never leak across accounts (all queries account-scoped like the existing view).
- **VALIDATE**: `pnpm -r typecheck`; existing org-view tests stay green; new test for workingHistory scoping if a harness exists for getOrganizationView (check at impl).

### Task 5 — E3 outcome attribution
- **ACTION**: `outcomeAttribution(db, accountProfileId)` in roi.ts: from `decision_labels kind='pursuit_outcome'` — counts by outcome, won-$ (snapshot outcomeValue) and lost-$, grouped by county and by route; plus overall win rate when ≥5 decided. ROI page "Outcomes" section + `/api/app/roi` field. All labels-derived; renders "no decided outcomes yet" below 1.
- **MIRROR**: roiScorecard shape/naming. **VALIDATE**: unit test with seeded labels (mirror existing roi/pursuit test harness in apps/worker/test); typecheck.

### Task 6 — F2a source-expansion audit doc (recon only, live web)
- **ACTION**: `docs/source-expansion-audit-2026-07.md` — for Snohomish County, Clark County, Spokane County/City permit systems + WA WEBS procurement: verify the official publisher LIVE (WebSearch/WebFetch), record landing page, data access (API/report/HTML), cadence, robots/ToS posture, expected egress class (cloud-safe vs operator-local, judged against the Akamai/Cloudflare precedents), and a build-priority recommendation. Follow source-adapter skill §1–3 discipline. NO fixtures, NO adapters, NO config/sources.yaml changes.
- **GOTCHA**: never present a guessed URL as verified — every claim in the doc from a live fetch this session; unreachable ⇒ recorded as unverified.
- **VALIDATE**: every URL in the doc was fetched (or explicitly marked unverified) during implementation.

### Task 7 — G1+H1 methodology page + directory line
- **ACTION**: `/methodology` (trades site; static content page mirroring an existing static route's conventions): what "verified" means (L&I registration), where data comes from (state records + OTN Insights public-permit observations — the H1 bidirectional attribution), how directory ranking works (restate the existing disclosed basis), how Activity Score is computed (restate the 29-view formula), and the pledge: "We never sell ranking. Activity Score cannot be bought." Directory city page: append link-line to the existing `sectionNote` disclosure.
- **GOTCHA**: restate ONLY formulas that exist (view 29 comment is the source of truth); keep every current pSEO pin passing; BJJ site must not 404-regress (gate the route like other trades-only pages — check how /trades/market gates at impl).
- **VALIDATE**: `node scripts/pseo-quality-gate.mjs` with new pins; both site-key builds.

### Task 8 — G2 contractor badge route + embed snippet
- **ACTION**: `api/badges/contractor/[slug]/route.ts` mirroring the gym badge byte-for-byte in structure: tenant by slug (trades vertical), LEFT JOIN score view by tenant_id; SVG variants — scored: "VERIFIED WA CONTRACTOR / {name} / Activity Score {N}"; unscored-but-listed: "REGISTRY LISTING / {name}"; unknown slug: generic listing badge (mirror gym fallback). Cache headers like the gym route. `/for-owners`: an "Embed your verification badge" block with the copyable `<img>` snippet.
- **MIRROR**: BADGE_SVG_ROUTE + `escapeXml`. **GOTCHA**: never render a score of 0/fabricated — unscored uses the listing variant; escape the name.
- **VALIDATE**: dev fetch of the route for a scored (none yet — expect listing variant), an unscored, and an unknown slug; builds.

### Task 9 — G3 claim CTA band
- **ACTION**: ContractorProfilePage: an "Is this your business?" band (subtle card between trust header and sections): claim to control your listing, embed your verified badge, and see your permit activity — CTA link to `/for-owners`. Render on all unclaimed trades profiles (claimed check: profile route already knows tenant; pass a boolean prop — derive from `owner_id`/claim_status if fetched, else fetch-lite at impl).
- **MIRROR**: card/module.css conventions. **VALIDATE**: builds; band renders on an unclaimed profile in dev; absent when claimed.

### Task 10 — G4+H3 Construction Pulse page
- **ACTION**: `/trades/pulse` (trades-gated, **noindex-initial**, no sitemap): headline stats (total combos served, total 6-mo projects from market_demand_v1), "Most active markets" table (top combos by recent volume, linking to the market pages), 6-month trend per top combo (existing month buckets), and the H3 "Permit processing speed by jurisdiction" table (market_permit_speed_v1 medians + n). Basis + suppression copy mirroring the market pages ("counts reflect public permit observations via OTN Insights; small samples suppressed"); JSON-LD Dataset.
- **MIRROR**: MARKET_VIEW_READ + market page structure/gating. **GOTCHA**: render ONLY what the sample-gated views serve — no client-side re-aggregation that could surface n<5 cells; trend history accrues forward from 2026-07 (say so in the basis line, as the market pages do).
- **VALIDATE**: pSEO gate (new pins: pulse basis copy + noindex assertion); dev render; both builds.

### Task 11 — Close-out
- **ACTION**: Full validation both repos (commands below) incl. `eval:run` byte-identical proof (intelligence package touched); commit+push per repo; STATUS.md entry; memory (wave-2 shipped + backlog pointer); archive this plan; report.

---

## Validation Commands
```bash
# Insights
cd C:/Users/Snipe/Downloads/TradesInsights
pnpm -r typecheck && npx vitest run                      # 699+ green, no regressions
pnpm --filter @otn/worker eval:run                       # GATES PASS byte-identical (intelligence touched — MUST prove)

# Registry (worktree trades-google-place-integration-v2; test:security is a ROOT script)
cd apps/registry && npx tsc --noEmit
cd .. && npm run test:security
node scripts/pseo-quality-gate.mjs
cd apps/registry && NEXT_PUBLIC_SITE_KEY=onetradenetwork npm run build && NEXT_PUBLIC_SITE_KEY=bjj npm run build
```

## Acceptance Criteria
- [ ] Bid Clock renders per domain rules, only with data; unit tests cover all class×stage states
- [ ] Corroboration panel shows both contradiction values, never a winner; null ⇒ nothing
- [ ] Org page working history is account-scoped; warm-GC surfaced
- [ ] Outcome attribution honest-sparse; ROI API extended
- [ ] Audit doc: every URL live-verified or marked unverified; zero adapters built
- [ ] Methodology page + never-pay-to-rank pledge live on trades; directory links it; badge route serves 3 honest variants; claim band on unclaimed profiles; Pulse page noindex + sample-gated
- [ ] eval:run byte-identical; all suites green; both trunks pushed; STATUS/memory updated; plan archived

## Risks
| Risk | L | I | Mitigation |
|---|---|---|---|
| Bid-window read as a promise by the customer | M | M | labeled-inference copy everywhere + "not a promise" footer (memo precedent) |
| eval drift from touching packages/intelligence | L | H | bid-window imports nothing from scoring; eval:run gate is a hard check |
| Pulse/methodology copy breaks existing pSEO pins | M | M | run the gate after every registry copy task, not just at close-out |
| getOrganizationView cross-account leak | L | H | account-scoped joins only; mirror existing scoping; test it |
| F2a portals unreachable from this environment | M | L | record "unverified — needs operator check", never guess |

## Confidence: 7.5/10 — all anchors read this session; residual unknowns are impl-time route-gating details (methodology/pulse vertical gates) and the exact `getOrganizationView` file location, both discoverable in one grep.

---

## BACKLOG — blocked recommendations (recorded, not dropped)

| Item | What | Gate (why blocked) |
|---|---|---|
| **F1** | Second design-partner account (non-competing trade — electrical/mechanical; corpus already tags both) | **Owner decision: pick the partner.** Highest strategic leverage on the board; engineering is a config profile + invite |
| **F2b** | New-county adapters (Snohomish/Clark/Spokane) + WEBS procurement adapter | F2a audit results + F1 signal + a dedicated sprint (each adapter = full 9-step activation) |
| **F3** | Self-serve account-profile wizard | F1 proves account #2 manually first (YAGNI until then) |
| **H2** | Owner-verified facts loop (claimed owners confirm/correct → `provenance='owner_verified'` → feeds matching) | Claims must exist (G3 funnel + OTN-9 flow) |
| **G3-full** | OTN-9 public claim flow for trades (self-serve verify + claim) | Owner scope decision (invite-only vs public claim; invite script header records it as out-of-scope v1) |
| **E1-digest** | Bid-window line on digest items | First Monday digest ships from a stable renderer; add after |
| *(carried)* | Wave-1 backlog stands unchanged: A2-send, B1 invite, B2 price, B3 billing, B4 ladder, C2 PALS, C3 geocoding pass (agents active on the shared-data side), C4 index flip, C3-b map UI, D1 cadence, D2 S3, §12.3 calibration | as recorded in `completed/roadmap-unblocked-wave1.plan.md` |

## Notes
- H1 (bidirectional attribution) is deliberately merged into Task 7 — one "how our data works" page serves both; a second page would dilute it.
- H3 (jurisdiction transparency) is deliberately merged into Task 10 — same data source, same page, stronger artifact.
- G2's badge is the distribution loop: contractors embedding it backlink to their own verified profile; the honest unscored variant still links, so the loop works before facts flow.
