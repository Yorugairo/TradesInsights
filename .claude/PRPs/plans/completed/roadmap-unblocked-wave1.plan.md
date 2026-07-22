# Plan: Roadmap Wave 1 — All Currently Unblocked Work (A/B/C/D) + Backlog

## Summary
Executes every roadmap item from the 2026-07-22 strategic plan that is unblocked **today**: A1 review-queue velocity (enhance the existing admin surface), A3 recent-projects profile section (skip-safe), A2/B1 owner runbook, C1 Codex domain handoff, C3 trades geo-hydration (entity locations → tenant settings), D3 agentic Phase 1 (fix the live-assist/training robots split + llms.txt). Everything gated on an owner decision, credentials, operator sessions, or customer signal goes to the **Backlog** section at the bottom — recorded with its named gate, not silently dropped.

## Problem → Solution
- 262 binding candidates × a 25-row, no-filter, no-keyboard admin table = the review gate is slow → batch-capable evidence-rich review UI.
- Partner facts already export a 5-row `recent` projects array that nothing renders → profile section (honest-empty until facts flow).
- `binding_domain_match` is starving and the supply is Codex's lane → a written handoff, not code in their lane.
- `registry_entity_locations` has per-entity lat/lng but 0/23,593 trades cards have coords → NULL-only settings hydration.
- robots.ts **blocks live-assist agents (ChatGPT-User, Claude-SearchBot, Perplexity)**, contradicting the recorded owner decision "allow live-assist agents, block training scrapers"; no llms.txt exists → correct the split, add llms.txt.

## Metadata
- **Complexity**: Medium overall (A1 Medium; A3/C3 Medium-small; C1/D3/runbook Small)
- **Repos**: Insights `TradesInsights` (branch `claude/tmux-install-320aiz`); Registry worktree `trades-google-place-integration-v2` (branch `release/trades-staging`)
- **Migrations**: Registry `20260722130000_trades_activity_recent.sql` + baseline patch **30** + census row (Insights: none — drizzle idx stays 31-next)
- **Estimated files**: ~14

## Constraints carried (unchanged governance)
§12.3 frozen; review-queue decisions stay one-at-a-time through `decideRegistryObservation` (batch = client-side sequential loop so rule history + side effects stay intact — NO bulk-SQL decision path); unknown = null / honest empty; registry DDL additive `_v1` + byte-identical baseline mirror + census; NULL-only hydration (never overwrite curated settings); Codex's lane (`registry_entity_websites`/`website_signals`) receives a DOCUMENT, never our writes; commit→push per repo after validation.

---

## Mandatory Reading
| Priority | File | Why |
|---|---|---|
| P0 | Insights `apps/web/app/app/admin/registry-review/page.tsx` (120 lines, read this session) | The A1 surface to enhance — server component, `listRegistryObservations(db(), {status, limit})`, `describe()` per type, admin-role redirect |
| P0 | Insights `apps/web/app/app/admin/registry-review/actions.tsx` | Client decision component POSTing `/api/admin/registry-observations/{id}/decision` — batch loop reuses this endpoint |
| P0 | Insights `packages/resolution/src/registry-observations.ts:679-708` | `listRegistryObservations` caps limit at 200, orders trust DESC; payload fields available for evidence display: `name_similarity`, `phone_evidence`, `registry_phone`, `phone_agrees`, `address_evidence`, `registry_address`, `shared_address_bucket_size`, `registry_google_phone`, `domain_evidence`, `registry_root_domain`, `org_localities`, `role_records` |
| P0 | Registry `db/baseline-v1.2/28_registry_public_trades_activity_v1.sql` | View to extend — `recent` must be APPENDED as the last column (CREATE OR REPLACE VIEW only allows appending) |
| P0 | Registry `apps/registry/src/lib/mapCoordinates.ts:52-59` | `coordinateFromPublicProfile` accepts `settings.geo_hydration.{lat,lng}` — the hydration write target |
| P1 | Registry `db/baseline-v1.2/26_registry_public_trades_identity_v1_enrichment.sql:64-95` | `registry_internal.registry_entity_locations` (lat/lng, is_primary) + strong-id UBI join — the C3 source query shape |
| P1 | Registry `scripts/invite-trades-owner.mjs` | Dry-run-default operator script pattern for `hydrate-trades-geo.mjs` |
| P1 | Registry `apps/registry/src/app/robots.ts` | Current blockedAiCrawlers list (the split to correct) + `publicIndexingEnabled()` gating |
| P1 | Registry `apps/registry/src/components/ContractorProfilePage.tsx` (Permit activity section, ~:176-225) | Where the recent-projects list renders; `PermitActivity` prop pattern to extend |
| P2 | Insights `packages/resolution/src/registry-observations.ts:844-892` | Export facts SQL — the exact `recent` array shape: `{name, county, stage, role, last_seen, source_url}` |
| P2 | Insights `docs/runbooks/` or `docs/` (check at impl) | Runbook home for the first-digest doc |

## Patterns to Mirror

### ADMIN_PAGE — registry-review/page.tsx:16-21
```tsx
const session = await currentSession();
if (!session) redirect("/login");
if (session.role !== "admin") redirect("/app/opportunities");
const pending = await listRegistryObservations(db(), { status: "pending", limit: 25 });
```

### CLIENT_DECISION — actions.tsx:13-28
```tsx
const res = await fetch(`/api/admin/registry-observations/${observationId}/decision`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ decision, ...(note ? { note } : {}) }) });
...router.refresh();
```

### REGISTRY_VIEW_DISCIPLINE — baseline 28 header
`CREATE OR REPLACE VIEW … WITH (security_invoker = false)`, byte-equivalent-baseline comment, `COMMENT ON VIEW`, additive-_v1; supabase migration + baseline patch + census row, applied via MCP `apply_migration`.

### SETTINGS_COORD — mapCoordinates.ts:54-56
```ts
const geoHydration = profile.geo_hydration || {};
const lat = profile.lat ?? profile.latitude ?? geoHydration.lat ?? geoHydration.latitude;
```

### HONEST_EMPTY — ContractorProfilePage permit-activity section
Render only when data exists; never a fabricated zero/row.

---

## Files to Change

**Insights**
| File | Action | Why |
|---|---|---|
| `apps/web/app/app/admin/registry-review/page.tsx` | UPDATE | A1: searchParams-driven `limit` (≤200) + `rule` filter; evidence column upgrade; selection checkboxes; counts-by-rule header (reuse `ruleHistory`-style GROUP BY or client-derive from rows) |
| `apps/web/app/app/admin/registry-review/actions.tsx` | UPDATE | A1: keyboard flow (j/k move, a/r decide focused row), `BatchDecision` client component — sequential loop over selected ids against the EXISTING per-id endpoint, progress + per-row failure surfacing, confirm dialog stating count + rule mix |
| `docs/runbooks/first-digest-and-invite.md` | CREATE | A2/B1 runbook: review-order (bindings → 25 digest items), SMTP/`INBOUND_EMAIL_SECRET` env names, delete-draft-deliveries idempotency rule, digest send steps, registry-side `scripts/invite-trades-owner.mjs` (dry-run first) + activation-week checklist |
| `docs/handoff-codex-domains.md` | CREATE | C1: what `binding_domain_match` needs from the website lane (per-entity `root_domain` identifiers in `registry_entity_identifiers`), normalizer contract (lowercase host, www-stripped, no eTLD+1, platform-host denylist), which queue segments would benefit; explicit "Insights reads `trades_identity_v1.root_domain` only" boundary restated |

**Registry**
| File | Action | Why |
|---|---|---|
| `apps/registry/supabase/migrations/20260722130000_trades_activity_recent.sql` + `db/baseline-v1.2/30_trades_activity_recent.sql` (byte-identical) + README census row | CREATE | A3: `CREATE OR REPLACE VIEW registry_public.trades_activity_v1` re-stating the 28 body + appending `f.facts -> 'recent' AS recent` LAST |
| `apps/registry/src/app/contractor/[slug]/page.tsx` | UPDATE | A3: select `recent` in the existing activity query; parse to typed array (filter malformed rows), pass prop |
| `apps/registry/src/components/ContractorProfilePage.tsx` | UPDATE | A3: "Recent public projects" list (≤5) inside the Permit activity section — name, county, stage label, role, observed date; `source_url` as `rel="nofollow noopener"` external link; HONEST_EMPTY |
| `scripts/hydrate-trades-geo.mjs` | CREATE | C3: dry-run-default script — trades tenants (settings.ubi) → entity via strong-id UBI → primary `registry_entity_locations` lat/lng → write `settings.geo_hydration = {lat, lng, source: 'registry_entity_locations', hydrated_at}` ONLY when no existing coordinate resolves via `coordinateFromPublicProfile`; summary counts (eligible / hydrated / skipped-has-coords / no-location) |
| `apps/registry/src/app/robots.ts` | UPDATE | D3: split per owner policy — ALLOW live-assist/user-triggered agents (`ChatGPT-User`, `Claude-User`, `Claude-SearchBot`, `Perplexity-User`), KEEP blocking training scrapers (`GPTBot`, `ClaudeBot`, `CCBot`, `Google-Extended`, `Bytespider`, `Meta-ExternalAgent`, …). Keep the `publicIndexingEnabled()` full-block path untouched |
| `apps/registry/public/llms.txt` (or route handler if `public/` isn't served per-site-key — check at impl) | CREATE | D3: site purpose, key public surfaces (directory, contractor profiles, market pages), data provenance note, contact; per-site-key content if the file is site-key-shared |

## NOT Building
- Any bulk-SQL decision path or new batch API (client loop over the per-id endpoint only).
- B2 stated pricing (backlog — owner sets the number), billing flip, module self-serve.
- Map UI for trades directory (hydration only; map render is a follow-up).
- Writes to `registry_entity_websites`/`website_signals` (Codex's lane — document only).
- Adapter `website` emission: pierce-pals/wa-sepa greps show no website fields in current source data; re-audit is a one-grep step inside C1, wired ONLY if a source actually publishes URLs.
- Auto-accept changes of any kind.

---

## Step-by-Step Tasks

### Task 1 — A1 review page data layer
- **ACTION**: page.tsx reads `searchParams` (`limit` clamped 1–200 default 50, `rule` optional). Filter client-of-DB: fetch once, filter rows by ruleKey in the server component (listRegistryObservations has no rule param — do NOT change the shared lib for a UI filter at 200-row scale). Header adds per-rule counts derived from the fetched rows + a link row of rule-filter presets.
- **MIRROR**: ADMIN_PAGE. **GOTCHA**: keep default limit modest; 262 rows render fine but the evidence column must stay `<small>`-dense.
- **VALIDATE**: `pnpm --filter @otn/web typecheck` (apps/web has typecheck? use `pnpm -r typecheck`); manual: `/app/admin/registry-review?limit=200&rule=binding_name_exact`.

### Task 2 — A1 evidence display
- **ACTION**: For `binding_name_match` rows, replace the components cell content with an evidence block: `name_similarity` (2dp), phone evidence vs `registry_phone` (+`phone_agrees` ✓/✗), `registry_google_phone`, `registry_address` + `shared_address_bucket_size` ("shared ×N"), `registry_root_domain`, `org_localities` (first 3), `role_records`. Missing fields render nothing.
- **MIRROR**: existing `describe()` + components `<small>` cell. **VALIDATE**: rows for each rule type show only their relevant evidence (seed via existing worker test fixtures locally or visual check against hosted data READ-ONLY).

### Task 3 — A1 selection + batch + keyboard
- **ACTION**: actions.tsx gains `ReviewBatchProvider` (client): row checkboxes + select-all-visible; `BatchDecision` bar (accept/reject selected → confirm dialog "Accept N observations (rules: …)? Bindings apply immediately." → sequential POST loop with per-row result, abort-on-first-500 option off by default, summary + `router.refresh()`). Keyboard: j/k focus row, x toggle select, a/r decide focused (same confirm for a). Focus ring via row style.
- **MIRROR**: CLIENT_DECISION. **GOTCHA**: sequential (not Promise.all) — each accept runs side effects + backfeed; parallel writes to the same org row invite races. Already-decided rows return 4xx ("observation already …") — surface as skipped, not fatal.
- **VALIDATE**: local DB: seed 3 pending via worker test helpers or SQL, batch-accept 2, verify statuses + one rejected untouched; full `pnpm -r test` (existing registry-observations DB tests must stay green).

### Task 4 — A2/B1 runbook (docs only)
- **ACTION**: `docs/runbooks/first-digest-and-invite.md` per Files table. Content from known truth only: review order, `pnpm digest:run` + delete-draft-deliveries idempotency (Governance #8), env names (SMTP_*, `INBOUND_EMAIL_SECRET` — list as REQUIRED-BUT-OWNER-SET, no values), registry invite script path + dry-run flag, activation-week checklist (digest opened? cockpit login? any pursue/dismiss?).
- **VALIDATE**: every command in the doc exists in package.json scripts; no secrets.

### Task 5 — C1 Codex handoff doc
- **ACTION**: `docs/handoff-codex-domains.md` per Files table; include the `match:audit` note that `binding_domain_match` has 0 candidates for lack of supply, and the exact identifier write shape the registry side already uses (`registry_entity_identifiers` type `root_domain`, per baseline 26's strong_ids CTE). Re-run the adapter website grep (`grep -rin "website" packages/adapters/src --include='*.ts' | grep -iv url`) and record the result in the doc.
- **GOTCHA**: document, don't prescribe their implementation; restate the read-only boundary.
- **VALIDATE**: doc references only real tables/columns (checked against baseline 26).

### Task 6 — A3 registry view + profile section
- **ACTION**: Migration `20260722130000` + baseline 30 + census: re-state view 28's body verbatim and append `f.facts -> 'recent' AS recent` as the LAST select column (CREATE OR REPLACE constraint). Profile route: add `recent` to the SELECT; parse `Array.isArray` → up to 5 typed rows `{name, county, stage, role, last_seen, source_url}` dropping rows missing `name`; ContractorProfilePage renders the list under the activity prose.
- **MIRROR**: REGISTRY_VIEW_DISCIPLINE; HONEST_EMPTY. **GOTCHA**: jsonb column appends fine; keep both file copies byte-identical + apply hosted via MCP `apply_migration`; `source_url` may be null — render plain text then. Currently 0 facts rows ⇒ section renders nowhere yet (expected).
- **VALIDATE**: `npx tsc --noEmit`; hosted probe `SELECT recent FROM registry_public.trades_activity_v1 LIMIT 1` (0 rows OK); `node scripts/pseo-quality-gate.mjs`; dual builds.

### Task 7 — C3 geo-hydration script + run
- **ACTION**: `scripts/hydrate-trades-geo.mjs` (dry-run default, `--apply` to write): SQL join tenants(settings.ubi normalized) → `registry_internal.registry_entity_identifiers` (is_strong ubi) → `registry_entity_locations` (is_primary first, lat/lng NOT NULL); skip tenants where `coordinateFromPublicProfile(settings)` already resolves (port the tiny check into the script — settings.lat/latitude/lng/lon/longitude/geo_hydration.*); UPDATE `tenants.settings = jsonb_set(settings, '{geo_hydration}', …)` batched. Print eligible/hydrated/skipped/no-location.
- **MIRROR**: invite-trades-owner.mjs dry-run shape. **GOTCHA**: NULL-only semantics = skip-if-resolves, never overwrite; probe how many entity locations actually have lat/lng BEFORE `--apply` (dry run prints it); trades DB only (guard on a trades marker — same env/DB the registry app uses).
- **VALIDATE**: dry-run output sane → `--apply` → re-run reports 0 newly-hydrated (idempotent); spot-check 3 tenants' settings; card query still green (`test:security`, builds).

### Task 8 — D3 robots split + llms.txt
- **ACTION**: robots.ts — move `ChatGPT-User`, `Claude-SearchBot` (and add `Claude-User`, `Perplexity-User`) OUT of the blocklist into allowed; keep GPTBot/ClaudeBot/CCBot/Google-Extended/Bytespider/Meta-ExternalAgent/etc. blocked, with a comment citing the owner decision ("allow live-assist agents, block training scrapers"). Search the repo for the AGENTIC_READINESS doc (not under this worktree's docs/architecture — locate or note absent) and align names. Add `llms.txt` (public/ if served; else a route) — purpose, key surfaces, provenance ("L&I public records + OTN Insights permit observations"), no PII, per-site-key wording if shared.
- **GOTCHA**: `publicIndexingEnabled()` pre-launch full-block stays; BJJ + trades share robots.ts — the split is policy-level, fine for both.
- **VALIDATE**: builds; manual render of /robots.txt in dev for both site keys; llms.txt reachable.

### Task 9 — Close-out
- **ACTION**: Full validation both repos (commands below); hosted applies (Task 6 view); one hosted maintenance NOT needed (no Insights pipeline changes); commit+push each trunk; STATUS.md entries; memory update (roadmap wave-1 shipped + backlog pointer); archive this plan.

---

## Validation Commands
```bash
# Insights
cd C:/Users/Snipe/Downloads/TradesInsights
pnpm -r typecheck && npx vitest run          # expect 699+ green, no regressions
pnpm --filter @otn/worker eval:run           # GATES PASS byte-identical (no scoring surface touched — belt & suspenders)

# Registry (worktree trades-google-place-integration-v2)
cd apps/registry && npx tsc --noEmit
npm run test:security
node scripts/pseo-quality-gate.mjs
NEXT_PUBLIC_SITE_KEY=onetradenetwork npm run build && NEXT_PUBLIC_SITE_KEY=bjj npm run build
node scripts/hydrate-trades-geo.mjs          # dry-run stats, then --apply, then idempotency re-run
```

## Acceptance Criteria
- [ ] Review page filters/limits/batch/keyboard work; batch is sequential; already-decided rows surface as skipped
- [ ] `recent` column live on `trades_activity_v1` (baseline 30 byte-identical + census); profile renders nothing today (0 facts) without error
- [ ] Geo-hydration applied, idempotent, NULL-only; counts reported honestly
- [ ] robots.txt allows live-assist agents / blocks training scrapers on both site keys; llms.txt served
- [ ] Runbook + Codex handoff docs exist, command/table references verified real
- [ ] All validation green; both trunks pushed; STATUS/memory updated

## Risks
| Risk | L | I | Mitigation |
|---|---|---|---|
| Batch accept amplifies a bad rule's errors | M | H | confirm dialog shows rule mix; sequential loop; `match:audit` before/after; rejects stay one-click |
| View re-statement drifts from 28's body | L | M | copy 28 verbatim, append one column; diff baseline 28 body vs 30 minus last column |
| Hydration writes junk coords | L | M | source is registry's own entity locations; `normalizeUsMapCoordinate` bounds-check in script; dry-run first |
| llms.txt/public asset not per-site-key | M | L | check how `public/` interacts with site keys at impl; fall back to a route handler |
| Robots change affects BJJ SEO | L | L | only AI-agent rules change; crawler/index rules untouched |

---

## BACKLOG — blocked recommendations (recorded, not dropped)

| Item | What | Gate (why blocked) |
|---|---|---|
| **A2-send** | Actually send the first Monday digest | Owner sets SMTP_* / `INBOUND_EMAIL_SECRET` envs; owner completes review pass (runbook ships in this wave) |
| **B1** | Solis invite + activation week | Owner-run (`scripts/invite-trades-owner.mjs`); do after first digest content exists |
| **B2** | Stated founding price on the Insights module copy | **Owner decision: the number** (engineering is a 10-minute copy change once set) |
| **B3** | Flip `BILLING_LIVE` + Stripe key | B1/B2 signal — do not build ahead of first willingness-to-pay datum |
| **B4** | Trades claimed-profile paid ladder (WaaS/lead routing/market reports; NEVER pay-to-rank on Activity Score) | B1–B3 validation |
| **C2** | Pierce PALS `contractorInfo` operator-local captures | Operator (headful browser) sessions; targets in `docs/handoff-local.md` |
| **C4** | Market-page index flip + sitemap | Human content-quality pass over the 21 live combos |
| **C3** | Trades geo-hydration (project entity coords → tenant settings) | **RECLASSIFIED from Task 7 (evidence): no coordinate source exists** — `registry_entity_locations` = 0 rows, `trades_identity_v1.lat/lng` = 100% null, 0 hydratable tenants. Gate = an upstream trades geocoding pass (owner/design decision: precise per-entity geocode vs. extend the existing Census-centroid `scripts/geo-hydration-*.mjs` pipeline) |
| **C3-b** | Trades directory map UI + "near me" | C3 coordinates + a design pass |
| **D1** | Capture-cadence automation/reminders | Owner picks cadence; operator machine scheduling |
| **D2** | S3/`OBJECT_STORAGE_*` cutover from local MinIO | Owner provisions S3 keys (durability risk stands until then) |
| **§12.3 calibration** | Weight tuning session | ≥50 decided labels (unblocked BY this wave's A1 + review pass) |

## Notes
- A1 deliberately adds no API surface: the per-id decision endpoint IS the contract; batch semantics = N human-attributed decisions, preserving rule-history learning.
- D3 finding worth flagging to the owner: the current blocklist has been blocking live-assist agents (including citation-driving search bots) — traffic upside from the fix is real and free.
- Confidence: **8/10** — all anchors read this turn; residual unknowns are impl-time probes (entity-location lat/lng fill rate; `public/` vs site-key serving), both with in-plan fallbacks.
