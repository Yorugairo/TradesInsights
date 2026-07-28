# Plan: Optimize the Insights ⇄ Registry data flow for the best possible Solis inference

> **STATUS 2026-07-28 — NON-GATED SUBSET SHIPPED, NOT CLOSEABLE.** The report's own *Remaining Work* section is explicit: **WS-D and WS-E.2 / E.3 / E.4 are externally gated and not implemented**, and **WS-C C.2 / C.3 need ops credentials**. The Insights-side inference, read-widen and Solis bind-readiness are done.


## Summary
The Insights ⇄ One Trade Network registry seam is **built but half-consumed and one-directional**: the registry's contract view already publishes **21 identity + geo + provenance columns**, but Insights reads only **10 of them** and — critically — **none of them reach the scorer**. `routeSolis` scores a project on permit text, valuation, stage, and county alone; the registry binding that runs nightly is invisible to it. Meanwhile the **write-back half is built but unmerged**: the `registry_partner` schema, the `otn_insights_reader`/`_writer` roles, and the `ingest-otn-insights.mjs` loader are complete on `origin/claude/insights-integration-seam` (`ae80f657`) and **byte-consistent with the Insights writer**, but not yet promoted to the `release/trades-staging` trunk — so today Insights' rich per-entity project facts have nowhere to land. This plan (executed across **both** repos) widens the read, **wires registry identity into the Solis inference** (signal-now / weight-at-calibration), **promotes and verifies the already-built registry write-back seam** so the loop compounds, and stages the deep **trade-code convergence** behind the registry's own gated Phase 5 — delivering Solis verified-identity, warm-network, and territory-fit signals the two datasets already contain but never combine.

## User Story
As **the Solis pilot operator**, I want every project Insights delivers to be scored and de-duplicated using the registry's verified entity identity — not just permit-text keywords and legal-suffix guesses — so that **Solis sees early, correctly-attributed projects where its own verified GCs are active in its territory, ranked by signals the registry and Insights can only produce together.**

## Problem → Solution
**Now:**
- Registry→Insights read is **thin**: `fetchRegistryIdentityRows` selects 10 of the view's 21 columns — no `status` (lineage), `root_domain`, `record_count`, `first_minted_at`, or geo.
- Registry identity is **absent from scoring and dedup**: `loadFeatures` pulls orgs as `{name, role}` only; `routeSolis` has no identity component; `resolver.ts` never uses `registry_ref` as a match key.
- Insights→Registry write-back is **built but unmerged**: Insights writes `registry_partner.partner_observations`/`partner_project_facts`, and the matching schema + loader already exist on `origin/claude/insights-integration-seam` — but they are **not on the `release/trades-staging` trunk**, so until promoted the enrichment has nowhere to land and the registry never gets richer.
- Ordering bug: in the nightly chain `scoreAll` runs **before** `linkRegistry`, so even a future registry-aware scorer would read one-night-stale binds.

**Desired:**
- Insights consumes the **full contract view** (lineage-safe, geo-ready), so binding respects `status` and gains `root_domain` as a match key.
- Registry identity becomes a **first-class scoring + dedup signal** for Solis (a verified-GC component surfaced immediately as a signal, weighted only after Solis calibration per §12.3).
- The **write-back loop is closed** by **promoting** the already-built registry seam to trunk + provisioning the login role, so Insights project intelligence (aliases, trade evidence, project facts) enriches registry entities — human-gated, never auto-merging identity — and compounds back into identity quality.
- Trade codes flow registry↔insights as the capstone (staged behind the registry ER PRP's dormant Phase 5).

## Metadata
- **Complexity**: XL (two repos, cross-DB, new registry DDL + loader, scoring changes gated by a live customer constraint; split into independently-shippable workstreams)
- **Source PRD**: N/A — derived from `docs/integration-one-trade-network.md` + verified first-hand against both codebases (see Build-State Ground Truth)
- **Prerequisite plan**: `.claude/PRPs/plans/insights-registry-integration-solis.plan.md` (the **activation** substrate: co-locate the pools, session-port pg-boss, provision creds, run the loop, bind Solis). **This plan is the optimization layer on top of it and additionally builds the registry-side seam that plan explicitly deferred.**
- **Estimated Files**: ~14 Insights-side (net-new code) + registry-side is mostly a **merge** of ~5 already-built files from the seam branch + one ops-provisioned login role

---

## Repos & Worktrees (every task names where it runs)
| Alias | Path | Branch | Role |
|---|---|---|---|
| **INSIGHTS** | `C:\Users\Snipe\Downloads\TradesInsights` | `claude/tmux-install-320aiz` | Operational engine: ingest → resolve → **score** → deliver; owns the binding + observation + export code |
| **REGISTRY** | `C:\Users\Snipe\Downloads\WA JiuJitsu Registry-20260608T183757Z-3-001\.claude\worktrees\trades-google-place-integration-v2` | `release/trades-staging` (`ebb59a0a`) | Trades identity authority: entity-resolution engine + `registry_public.trades_identity_v1` + (to-build) `registry_partner` |
| **SEAM (to promote)** | `origin/claude/insights-integration-seam` (`ae80f657`) | — | **Confirmed** built: `registry_partner` schema + `otn_insights_reader/_writer` roles + `ingest-otn-insights.mjs`, byte-consistent with the Insights writer; **merge into trunk** (WS-C), don't rebuild |

> **Never target `origin/main`.** `release/trades-staging` is the trades trunk; commit → push immediately so the registry half is visible to the other agent (Codex) working that branch.

---

## Build-State Ground Truth (verified first-hand — supersedes the doc's contradictory header)
| Component | State on trunk | Evidence |
|---|---|---|
| `registry_public.trades_identity_v1` **view body (21 cols)** | **BUILT** | `REGISTRY/apps/registry/supabase/migrations/20260719120000_surface_registered_address_in_trades_identity_v1.sql:39-59` |
| Entity-resolution engine (8 scripts, Phase 0/1/2A + Tier B/C) + 14-table `registry_internal` schema | **BUILT & LIVE** (25,545 entities, 2026-07-06) | `REGISTRY/apps/registry/scripts/entity-resolution/`, `db/baseline-v1.2/18_entity_resolution.sql` |
| `otn_insights_reader` role + `registry_public` SELECT grant | **BUILT, unmerged** (seam `ae80f657`); absent on trunk | `…/migrations/20260719091458_registry_public_trades_identity_v1.sql:70-75` |
| `registry_partner` schema + `partner_observations` + `partner_project_facts` + `otn_insights_writer` | **BUILT, unmerged** — byte-consistent with the Insights writer (`dedupe_key` UNIQUE, PK `entity_id,source_system`, `observation_type CHECK ('alias','trade_evidence')`) | `…20260719095534_registry_partner_inbound_staging.sql`; baseline twin `db/baseline-v1.2/23_registry_partner_inbound.sql` |
| `ingest-otn-insights.mjs` (registry-side consumer) | **BUILT, unmerged** — 130 lines; never mints/merges/touches L&I; idempotent via `applied_at`; trade assignment gated on `registry_trade_taxonomy` | `apps/registry/scripts/entity-resolution/ingest-otn-insights.mjs:1-130` |
| Registry alias/location/trade populators + `registry_trade_taxonomy`/`_assignments` | **DORMANT** (tables ship empty; Phases 3-6 gated) | `18_entity_resolution.sql:48`; `link-candidates.mjs:15-16`; `registry_entity_locations` empty ⇒ view geo cols NULL live |
| Insights read seam (`registry-link.ts`), observation loop + export (`registry-observations.ts`), two-pool (`client.ts`) | **BUILT & TESTED** (14 integration tests green) | `INSIGHTS/packages/resolution/…`, `INSIGHTS/packages/db/src/client.ts` |
| Registry identity in **scoring / dedup** | **ABSENT** | `score-run.ts:106-110` orgs = name+role only; `routeSolis` has no identity component; `resolver.ts` never keys on `registry_ref` |

**The full 21-column view** (`…identity_v1.sql:39-59`): `entity_id, vertical_key, canonical_name, canonical_name_normalized, status, record_count, state_code, city_token, ubi, contractor_numbers, root_domain, city_normalized, state_normalized, postal_code, lat, lng, phone, first_minted_at, updated_at, registered_address, registered_postal_code`. Insights reads the **bold-absent** ones nowhere: **`status, record_count, root_domain, city_normalized, state_normalized, postal_code, lat, lng, first_minted_at, updated_at, vertical_key`**.

---

## Mandatory Reading
| Priority | Repo · File | Lines | Why |
|---|---|---|---|
| **P0** | INSIGHTS `packages/intelligence/src/score-run.ts` | 49-141 | `loadFeatures` — the org rollup (`:106-110`) is the single insertion seam for registry identity into scoring |
| **P0** | INSIGHTS `packages/intelligence/src/scoring.ts` | 160-213, 355-492 | `orgIdentified` (`:178-183`, the regex to upgrade), `routeSolis` (`:393-483`, no identity component), the Glass `gc_developer_architect_known` component to mirror (`:377-379`), score-neutral-signal pattern (`:423-426`) |
| **P0** | INSIGHTS `packages/resolution/src/registry-link.ts` | 25-40, 109-128, 161-179 | `RegistryIdentityRow` (10-col contract to widen), strong-only matcher, `fetchRegistryIdentityRows` SELECT |
| **P0** | INSIGHTS `packages/resolution/src/registry-observations.ts` | 60-80, 663-757 | Trust model + the **exact** `partner_observations`/`partner_project_facts` write shape the registry DDL must match |
| **P0** | REGISTRY `apps/registry/supabase/migrations/20260719120000_surface_registered_address_in_trades_identity_v1.sql` | 27-72 | The live 21-col view definition + its `registry_internal` source joins; `registry_entity_locations` empty caveat |
| **P0** | REGISTRY `apps/registry/scripts/entity-resolution/trades-config.mjs` | 20-36, 64 | The registry's own identifier ladder + strong-set (`ubi`/`contractor_number`/`root_domain`) — Insights binding must not diverge from it |
| **P0** | REGISTRY `db/baseline-v1.2/18_entity_resolution.sql` | 157-214, 481-492 | Entity/identifier tables, the `is_strong` UNIQUE invariant, `registry_tenant_canonical_entity` view (Solis-as-tenant hook), dormant trade tables |
| **P1** | INSIGHTS `apps/worker/src/schedules.ts` | 88-171 | The nightly chain ordering (score `:100` before link `:114`) — the sequencing fix |
| **P1** | INSIGHTS `packages/resolution/src/resolver.ts` | 104-173, 401-486 | Org/project matcher — where `registry_ref` becomes a dedup key |
| **P1** | INSIGHTS `packages/intelligence/src/gate/gate.ts` + `gate/automation.ts` | 279-308; 47-106 | Publication + inclusion gates the new signals must pass through unchanged |
| **P1** | INSIGHTS `config/account-profiles.yaml` | 104-169 | Solis profile: strong keys, excluded closed UBI, weights-sum-100 (Zod-enforced), §12.3 gate |
| **P1** | REGISTRY `.claude/PRPs/plans/trades-entity-resolution.plan.md` | 154-193 | The **separate** ER PRP (Phases 3-6 dormant) — WS-D depends on its Phase 5; do not duplicate it |
| **P2** | INSIGHTS `packages/intelligence/src/org-activity.ts` + `relationships.ts` | rollup + `getOrganizationView` | Already carry `registryRef` into the digest — the warm-network source WS-E lifts into scoring |

---

## Patterns to Mirror

### TWO_POOL_NULL_SAFE_SEAM — INSIGHTS `packages/db/src/client.ts:20-25`
```ts
export function createRegistryPool(registryDatabaseUrl = process.env.REGISTRY_DATABASE_URL): pg.Pool | null {
  if (!registryDatabaseUrl) return null;   // unset ⇒ read/link/export report "skipped", never crash
  return new pg.Pool({ connectionString: registryDatabaseUrl, max: 4 });
}
```

### CONTRACT_READ (widen this SELECT + the row mapper) — INSIGHTS `packages/resolution/src/registry-link.ts:162-166`
```ts
const res = await pool.query(
  `SELECT entity_id, ubi, contractor_numbers, canonical_name, canonical_name_normalized,
          phone, city_token, state_code, registered_address, registered_postal_code
     FROM registry_public.trades_identity_v1`);   // ← add status, root_domain, record_count, first_minted_at, lat/lng/postal
```

### SCORE_COMPONENT (Solis has none; the Glass router shows the shape to mirror) — INSIGHTS `packages/intelligence/src/scoring.ts:377-379`
```ts
gc_developer_architect_known: orgIdentified(f, [
  "applicant", "owner", "primary_contractor", "proponent", "lead_agency",
]),
```

### SCORE_NEUTRAL_SIGNAL (how to add a signal without moving the score while §12.3 holds) — INSIGHTS `scoring.ts:423-426`
```ts
// Signal-only while Solis's profile is provisional (§12.3) — visible in the
// rationale/digest but score-neutral until customer calibration.
if (f.campusBlock) signals.push("active_campus");
```

### REGISTRY_WRITE_SHAPE (the DDL WS-C must match exactly) — INSIGHTS `packages/resolution/src/registry-observations.ts:685-748`
```sql
INSERT INTO registry_partner.partner_observations
  (source_system, entity_id, observation_type, payload, trust_score, reviewed_by, reviewed_at, dedupe_key)
VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8) ON CONFLICT (dedupe_key) DO NOTHING;
INSERT INTO registry_partner.partner_project_facts (entity_id, source_system, facts, exported_at)
VALUES ($1,$2,$3::jsonb, now())
ON CONFLICT (entity_id, source_system) DO UPDATE SET facts = EXCLUDED.facts, exported_at = now();
```

### REGISTRY_NEVER_AUTO_MERGE (the loader in WS-C must obey this) — REGISTRY `apps/registry/scripts/entity-resolution/mint-entities.mjs:152-157` + `18_entity_resolution.sql:212-214`
```sql
-- strong-identifier uniqueness is the identity invariant; a cluster whose strong
-- ids span >1 entity is pending_review (decided_by 'deterministic:conflict'), never auto-merged.
CONSTRAINT registry_entity_identifiers_strong_uniq
  UNIQUE (vertical_key, identifier_type, value_normalized) WHERE is_strong;
```

### REGISTRY_IDENTIFIER_LADDER (Insights binding must not diverge) — REGISTRY `trades-config.mjs:20-36`
```
STRONG → auto-bind: ubi(100), contractor_number(100), root_domain(85)
WEAK → score only:   phone, address, name(fuzzy), alias, metaphone, email_domain, tradeOverlap
COMPOSITE (name+city+state+phone/address) → REVIEW ONLY, never auto-merge (every WA record carries its own UBI)
thresholds: auto ≥90 & margin ≥12 · review 75-89 · unresolved <75
```

### DB_INTEGRATION_TEST — INSIGHTS `apps/worker/test/registry-observations.test.ts`
Inject registry rows directly (pure-matcher), `DATABASE_URL` from local PG, `fileParallelism:false`, `resetSource` fixture. New scoring tests mirror `packages/intelligence/src/scoring.test.ts` (inline `ACCOUNTS` incl. `solis_interiors` `:39-50`, `features(overrides)` factory `:53-70`).

---

## Files to Change
| Repo · File | Action | Justification |
|---|---|---|
| INSIGHTS `packages/resolution/src/registry-link.ts` | UPDATE | Widen `RegistryIdentityRow` + SELECT + mapper to the full 21 cols; add `status`-lineage guard (skip non-active), `root_domain` match key |
| INSIGHTS `packages/resolution/src/registry-observations.ts` | UPDATE | Feed `record_count`/`first_minted_at` into trust `corroboration`; `root_domain` candidate rule |
| INSIGHTS `packages/intelligence/src/score-run.ts` | UPDATE | Widen the org rollup (`:106-110`) to include `registry_ref`, `registry_identity_json` |
| INSIGHTS `packages/intelligence/src/scoring.ts` | UPDATE | Registry-aware `orgIdentified`; add Solis `gc_identified` component (signal-now, weight-later); `ProjectFeatures.orgs` shape |
| INSIGHTS `packages/resolution/src/resolver.ts` | UPDATE | Use `registry_ref` as an org dedup/match key (collapse name variants before roles/velocity) |
| INSIGHTS `apps/worker/src/schedules.ts` | UPDATE | Move `linkRegistry` (+ generate) **before** `scoreAll` so binds are fresh in-run |
| INSIGHTS `packages/intelligence/src/eval/harness.ts` | UPDATE | Extend `featuresSchema` orgs shape; add labeled cases with/without registry identity |
| INSIGHTS `config/account-profiles.yaml` | UPDATE (gated) | Add `gc_identified` weight **only** at Solis calibration (keep sum=100) |
| INSIGHTS `apps/worker/test/*.test.ts`, `scoring.test.ts` | UPDATE/CREATE | Registry-aware scoring + widened-read + dedup tests |
| REGISTRY seam migrations `20260719091458` + `20260719095534` + `20260719095646` + `20260719100034` + baseline `23_registry_partner_inbound.sql` | MERGE (from `origin/claude/insights-integration-seam`) | Already-built `registry_partner` schema + `otn_insights_reader/_writer` roles, byte-consistent with the Insights writer — promote to trunk, don't rebuild |
| REGISTRY `apps/registry/scripts/entity-resolution/ingest-otn-insights.mjs` | MERGE (already built) | Governance-clean loader (never mint/merge/touch L&I; idempotent via `applied_at`; taxonomy-gated) — promote + run |
| REGISTRY login role `otn_insights` (ops/env, not repo) | PROVISION | Login principal inheriting the NOLOGIN grant-holders; connection string → `REGISTRY_DATABASE_URL` (env only) |

## NOT Building
- **Registry ER Phases 3-6 themselves** (fuzzy blocking, website persistence, review-queue UI) — owned by `trades-entity-resolution.plan.md`. WS-D **depends on** its Phase 5 trade taxonomy; it does not build it.
- **The `registry_partner` schema, roles, and `ingest-otn-insights.mjs`** — already built and byte-consistent on `origin/claude/insights-integration-seam`; WS-C **promotes and verifies**, it does not rebuild.
- **Auto-binding on weak signals** — governance-fixed. The new scoring component reads `registry_ref` that was **already** set by strong-key auto-bind or human review; it introduces **no** new auto-binding path.
- **Finalizing Solis scoring weights** — gated on Solis confirming scope/territory/min-size (§12.3/§22). Ship signals now; weight later.
- **The full Part E co-location / Part F repo convergence** — deferred; this plan keeps the two-pool seam and adds cross-schema reach only.
- **Geo-fit scoring on live lat/lng** as a hard dependency — `registry_entity_locations` is empty on trunk, so geo cols are NULL; WS-A reads them null-safe and WS-B geo refinement stays dormant until the registry populates locations.
- **Bypassing any bot/WAF/CAPTCHA control** for home-metro sources — capture-fed only.

---

## Step-by-Step Tasks

### WS-A — Widen the registry→Insights read (lineage-safe, geo-ready) · INSIGHTS
Uses data that **already exists** in the view; pure Insights-side; unblocks better binding + the scoring signals in WS-B.

#### Task A.1: Widen `RegistryIdentityRow` + the contract SELECT to the full 21 columns
- **ACTION**: Extend the interface, the `SELECT`, and the row mapper in `registry-link.ts` to include `status, vertical_key, record_count, root_domain, city_normalized, state_normalized, postal_code, lat, lng, first_minted_at, updated_at`.
- **MIRROR**: CONTRACT_READ. Keep every added field `| null` (locations empty ⇒ geo NULL live).
- **IMPORTS**: none new.
- **GOTCHA**: The view already emits these (`…identity_v1.sql:39-59`); do **not** query `registry_internal` — least-privilege means `registry_public` only. `registry_entity_locations` is empty on trunk, so `city_normalized/lat/lng/postal` are NULL today — code must not assume geo presence.
- **VALIDATE**: `psql "$REGISTRY_DATABASE_URL" -c "select status, root_domain, record_count from registry_public.trades_identity_v1 limit 5;"` returns columns; the widened `fetchRegistryIdentityRows` typechecks and the existing 14 integration tests stay green.

#### Task A.2: Enforce lineage safety on `status`
- **ACTION**: In `buildRegistryIndex`/`matchOrganizationToRegistry`, **skip** rows whose `status <> 'active'` (merged/archived) so Insights never binds to a superseded entity.
- **MIRROR**: RESOLUTION_LADDER "respect lineage" (doc Part B) — now enforceable because `status` is fetched.
- **GOTCHA**: The registry never deletes merged entities (`status='merged'`, `merged_into_entity_id` set); binding to one is a correctness bug that this guard closes. Add a metric `skippedNonActive`.
- **VALIDATE**: unit test — a `merged` row for a UBI is excluded from `byUbi`; an org with that UBI reports `kind:"none"`, not a stale bind.

#### Task A.3: Add `root_domain` as a strong-ish match key (aligned with the registry ladder)
- **ACTION**: Index `root_domain` and match Insights orgs that carry a resolved website domain (from the Codex website-signals lane) to entities by exact normalized domain.
- **MIRROR**: REGISTRY_IDENTIFIER_LADDER — `root_domain` is strong(85) on the registry side; treat it as **auto-bindable** at parity, or as a high-trust review candidate if Insights domain provenance is weaker. Default: **review candidate** (conservative), promote to auto-bind only once domain provenance is proven.
- **GOTCHA**: Website→entity hydration is **Codex's lane** (see memory: `codex-website-entity-matching`); read `registry_entity_websites`/`website_signals` state before assuming domains exist. Domains are dormant on trunk (Phase 4) — so this rule ships **dormant/flagged** until domains populate, exactly like the registry's own dormant alias rules (`link-candidates.mjs:15-16`).
- **VALIDATE**: with a seeded domain fixture, an org matches the right entity; with none, the rule is inert (no candidates, no crash).

#### Task A.4: Feed registry provenance into the observation trust score
- **ACTION**: Use `record_count` and `first_minted_at` as inputs to the `corroboration` trust component (an entity the registry has seen across many records / long-lived is stronger corroboration).
- **MIRROR**: `registry-observations.ts:60-75` `TrustComponents`/`computeTrust` — do **not** change `TRUST_WEIGHTS` sums; map registry provenance into the existing `corroboration` ∈ [0,1] (capped), not a new weight.
- **GOTCHA**: Keep it deterministic (no model calls — the module is model-free by design). Normalize `record_count` with a cap so a mega-entity can't dominate.
- **VALIDATE**: `computeTrust` unit test — higher `record_count` raises `corroboration` monotonically but stays ≤ its weight ceiling.

---

### WS-B — Wire registry identity into the Solis inference (the core "best inference" win) · INSIGHTS
The highest-leverage change: registry identity that runs nightly finally reaches the scorer and the dedup matcher.

#### Task B.1: Surface `registry_ref` + identity in the scoring features rollup
- **ACTION**: Widen the org `json_agg` in `loadFeatures` (`score-run.ts:106-110`) to include `o.registry_ref` and a compact identity flag (bound? canonical entity id; optionally `registry_identity_json->>'contractor_numbers'`).
- **IMPLEMENT**: `json_build_object('name', o.canonical_name, 'role', pr.role, 'registryRef', o.registry_ref, 'registryVerified', (o.registry_ref IS NOT NULL))`.
- **MIRROR**: existing rollup at `score-run.ts:106-110`; extend `ProjectFeatures.orgs` type at `scoring.ts:53`.
- **GOTCHA**: `eval/harness.ts` `featuresSchema` (`:20-34`) freezes the orgs shape — update it in the same change or the eval replay breaks. Keep new fields optional so historical eval JSONL still validates.
- **VALIDATE**: `loadFeatures` returns orgs with `registryRef`; `pnpm --filter @otn/intelligence test` (eval harness) stays green.

#### Task B.2: Make `orgIdentified` registry-aware
- **ACTION**: Upgrade `orgIdentified` (`scoring.ts:178-183`) so a **registry-bound** org (`registryVerified`) scores 1.0, a legal-suffix name scores 0.75, a person name 0.5, none 0.
- **MIRROR**: the existing helper; keep it a pure function over `ProjectFeatures`.
- **GOTCHA**: This consumes an **already-governed** binding (strong-key or human-reviewed) — it does **not** introduce auto-binding. Preserve the current regex path as the fallback tier so accounts without registry data are unaffected.
- **VALIDATE**: unit test — same project scores higher when its GC has `registryRef` set than when it only matches the LLC/INC regex.

#### Task B.3: Add a Solis `gc_identified` component — signal now, weight at calibration
- **ACTION**: Add `gc_identified: orgIdentified(f, ["primary_contractor","applicant","owner"])` to `routeSolis` components (`scoring.ts:437-473`), and push a `verified_gc_on_project` signal.
- **IMPLEMENT**: While Solis is provisional, **emit the signal + expose the component in `components`/rationale but keep its weight absent from `account-profiles.yaml`** (weighted 0 ⇒ score-neutral) — mirror SCORE_NEUTRAL_SIGNAL (`:423-426`).
- **MIRROR**: the Glass `gc_developer_architect_known` component (`:377-379`) proves the shape.
- **GOTCHA**: `account-config.ts:65-73` enforces weights-sum-100 (Zod). Do **not** add a Solis weight now — that trips the refinement and violates §12.3. The component travels in `components` for auditability; it moves the score only when Solis calibration re-balances the five→six weights to 100.
- **VALIDATE**: `scoring.test.ts` — Solis project with a verified GC shows `signals` includes `verified_gc_on_project` and `components.gc_identified` is present, but `score` is **unchanged** vs. the same project unweighted (proves score-neutrality under §12.3).

#### Task B.4: Use `registry_ref` as an org dedup key in resolution
- **ACTION**: In `resolver.ts` `upsertOrganizationsAndRoles` (`:104-173`), when an incoming org resolves to an existing org already bound to a registry entity, collapse to that canonical org so name variants ("Solis Interiors" vs "Solis Interiors LLC") count as **one** entity in roles/velocity/league.
- **MIRROR**: the existing match cascade (`findOrganizationBySourceEntityId` → exact name → insert); add a `registry_ref` tier **above** exact-name.
- **GOTCHA**: Only collapse on an **existing** binding — never create a binding here (that stays in `registry-link.ts`/review). Two orgs bound to different entities must **not** merge (respect the registry's conflict invariant).
- **VALIDATE**: integration test — two source records with name variants of one bound entity produce one org + merged roles; velocity counts the cluster once.

#### Task B.5: Fix nightly ordering — link/observe before score
- **ACTION**: In `schedules.ts runMaintenance`, move the registry `linkRegistry` + `generateRegistryObservations` block **before** `scoreAll` (currently score `:100`, link `:114`).
- **MIRROR**: the existing chain; keep the null-safe `registryPool` guard and the `finally { registryPool?.end() }`.
- **GOTCHA**: `exportRegistryObservations` can stay after scoring (export doesn't feed this run's score). Only **link + generate** must precede `scoreAll`. Re-verify the `try/finally` still ends the pool exactly once.
- **VALIDATE**: log assertion — in a single maintenance run, `registryLink.bound` reflects this run and the subsequent `scoreAll` reads the fresh `registry_ref` (integration test binds an org then scores in the same run).

---

### WS-C — Promote & verify the already-built registry write-back seam · REGISTRY
**Verified 2026-07-19: the entire seam is BUILT on `origin/claude/insights-integration-seam` (`ae80f657`) and byte-consistent with the Insights writer — this is a MERGE + VERIFY + RUN workstream, not a build.** The registry DDL's `partner_observations(… dedupe_key text UNIQUE, observation_type CHECK IN ('alias','trade_evidence') …)` and `partner_project_facts(… PRIMARY KEY (entity_id, source_system))` exactly match the Insights `ON CONFLICT` targets; `otn_insights_reader`/`_writer` are least-privilege NOLOGIN roles; the loader never mints/merges/touches L&I identity and is idempotent via `applied_at`. Do **not** re-author any of it.

#### Task C.1: Promote the seam branch into `release/trades-staging`
- **ACTION**: Merge `origin/claude/insights-integration-seam` into `release/trades-staging`, bringing: `…/migrations/20260719091458_registry_public_trades_identity_v1.sql` (schema + base view + `otn_insights_reader` role/grant), `…20260719095534_registry_partner_inbound_staging.sql` (schema + both tables + `otn_insights_writer`), `…20260719095646_registry_partner_writer_sequence_grant.sql`, `…20260719100034_alias_type_partner_observed.sql`, `db/baseline-v1.2/23_registry_partner_inbound.sql`, and `apps/registry/scripts/entity-resolution/ingest-otn-insights.mjs`.
- **GOTCHA**: The two view migrations coexist in timestamp order: `20260719091458` (base 19-col view + reader role) applies first, then trunk's `20260719120000_surface_registered_address_…` CREATE-OR-REPLACEs it to the 21-col shape. Both are idempotent; no conflict — but confirm the ER core (`20260706121331_entity_resolution_core_18`) precedes them so `registry_entity_aliases`/`registry_trade_assignments`/`registry_trade_taxonomy` exist for the alias-type ALTER (`…100034`) and the loader.
- **MIRROR**: registry migration ordering (timestamp prefixes) + the baseline-patch twin convention (`23_registry_partner_inbound.sql` is the byte-equivalent baseline body).
- **VALIDATE**: on a scratch DB, `supabase db reset` on the merged branch applies cleanly; `\dn` shows `registry_public` + `registry_partner`; `\d registry_partner.partner_observations` shows `dedupe_key` UNIQUE + the identity PK; `\du` shows `otn_insights_reader`/`_writer`.

#### Task C.2: Provision a login role that inherits the grant-holder roles (env-only)
- **ACTION**: Create a LOGIN role (e.g. `otn_insights`) with a password, `GRANT otn_insights_reader, otn_insights_writer TO otn_insights`; hand its connection string to Insights as `REGISTRY_DATABASE_URL`.
- **GOTCHA**: `otn_insights_reader`/`_writer` are `NOLOGIN` grant-holders by design — a login principal inherits them. **No password or connection string in the repo** (env only). The loader runs as the migration/service owner (which can write `registry_internal`), **not** as this partner login (which cannot).
- **VALIDATE**: as the login role, `SELECT` on `registry_public.trades_identity_v1` works and `registry_internal` is **denied**; `INSERT` into `registry_partner.partner_observations` works and a `registry_public` write is **denied**.

#### Task C.3: Run the loop end-to-end + prove governance
- **ACTION**: Co-located (session port), run the Insights export (`exportRegistryObservations`) then the registry loader `node apps/registry/scripts/entity-resolution/ingest-otn-insights.mjs [--dry-run] [--limit=N]`.
- **MIRROR**: the loader's own contract (`ingest-otn-insights.mjs:1-25`) — reads `partner_observations WHERE applied_at IS NULL`, applies `alias`→`registry_entity_aliases (partner_observed)` / `trade_evidence`→`registry_trade_assignments`, stamps `applied_at`+`applied_action`.
- **GOTCHA**: pg-boss on the Supabase pooler (6543) breaks LISTEN/NOTIFY — worker on the session port 5432 (prerequisite plan + memory). Export is skip-safe if the writer credential is unset. Partner rows are **untrusted external data** — the loader already treats them as such (never renames/merges an entity); do not weaken that.
- **VALIDATE**: loader stamps `applied_at`; rerun processes **zero** rows (idempotent); an observation for an inactive/unknown entity → `skipped:unknown_entity`; a `trade_evidence` whose `trade_code` is absent from `registry_trade_taxonomy` → `skipped:unknown_trade_code` (proves the human-seeded taxonomy gate); `report.mjs` shows new alias counts.

---

### WS-D — Trade-code convergence (capstone; staged behind registry Phase 5) · BOTH
The deepest inference win: Insights' permit-derived trade evidence and the registry's trade taxonomy converge, and trade codes flow back to sharpen `trade_fit`.

#### Task D.1: Seed the trade taxonomy so the already-built loader activates trade assignment (dependency-gated)
- **ACTION**: The loader **already** routes `trade_evidence → registry_trade_assignments (source 'otn_insights', assignment_rank 'partner')` but returns `skipped:unknown_trade_code` unless `payload.trade_code` is active in `registry_trade_taxonomy`. The only missing piece is **seeding the taxonomy** (owned by the registry ER PRP Phase 5) and aligning Insights' permit-keyword→`trade_code` mapping to that vocabulary.
- **GOTCHA**: **Depends on** `trades-entity-resolution.plan.md` Phase 5 (dormant) + its `registry_business_service_tags` reconciliation (that PRP L126). Do **not** seed the taxonomy here. Operational nuance: rows already stamped `applied_action='skipped:unknown_trade_code'` will not re-present on rerun (`applied_at` is set) — after seeding, an operator clears `applied_at` for those rows (or Insights re-exports under a new `dedupe_key`) so the loader retries them.
- **VALIDATE**: with a Phase-5 taxonomy seeded and the skipped rows re-armed, a `trade_evidence('drywall')` observation reruns from `skipped:unknown_trade_code` to `trade_assigned`.

#### Task D.2: Expose trade codes on the contract view → registry-backed `trade_fit`
- **ACTION**: Extend `trades_identity_v1` with an aggregated `trade_codes` column (from `registry_trade_assignments`); Insights reads it and lets `routeSolis` `trade_fit` prefer registry-confirmed trades over pure keyword classification.
- **GOTCHA**: View change is a **registry** change (contract-versioned); Insights must tolerate the column being absent/NULL until it lands (tolerant reader). `trade_fit` stays keyword-driven as the fallback tier.
- **VALIDATE**: with registry trade codes present, a Solis TI project whose entity is registry-tagged `drywall/painting` scores `trade_fit` at least as high as the keyword path, with a `registry_trade_confirmed` signal.

---

### WS-E — Optimize for Solis's highest-value data (the pilot payoff) · INSIGHTS
Threads WS-A/B through to the delivered Solis digest.

#### Task E.1: Bind Solis on its strong key (the seed inference)
- **ACTION**: Ensure Solis's Insights org carries `ubi=604837560`/`contractor_registration=SOLISIL785NT` so `linkRegistry` binds it (strong-key auto-bind is allowed).
- **IMPLEMENT**: Seed Solis's own `organizations` row identity (today `seed.ts:85` stores only `excluded_ubis` — Solis's own UBI/registration are **not** written as an org). Add Solis's org identity so the nightly link binds it.
- **GOTCHA**: Exclude closed UBI `604701295` (`account-profiles.yaml:111`, `:160`). Solis's registry entity is `8a12a7cb…`; cross-check via `registry_tenant_canonical_entity` if Solis is a registry tenant.
- **VALIDATE**: after link, Solis org `registry_ref = 8a12a7cb…`, `registry_ref_method='ubi_exact'`.

#### Task E.2: Lift warm-network from digest-only into a Solis signal
- **ACTION**: `org-activity.ts`/`relationships.ts` already group activity by `registryRef` and feed the digest `relationshipPlays`. Surface "a verified GC active in Solis's territory is on this project" as a **scoring signal** (score-neutral under §12.3), reusing `relationshipTargets`.
- **GOTCHA**: Group by registry `entity_id`, not `orgNameKey` (`org-activity.ts:137`), so warm-network counts collapse name variants (depends on B.4).
- **VALIDATE**: a project with a Solis-warm bound GC emits a `warm_gc_active` signal in the Solis route rationale.

#### Task E.3: Home-metro coverage (capture-fed, gated)
- **ACTION**: After shadow validation, enable `olympia_smartgov_reports`, `tumwater_sepa`, `tumwater_development_review` (Thurston = Solis turf) in `config/sources.yaml`.
- **GOTCHA**: Capture-fed sources dead-letter on live fetch by design — keep `enabled` gated on capture availability; never bypass bot controls (capture genuine bytes only).
- **VALIDATE**: source-run health green; more Thurston-metro records in Solis's territory feed.

#### Task E.4: Finalize Solis scoring — gated on Solis confirmation
- **ACTION**: When Solis confirms territory + trade focus + min job size + preferred GCs, re-balance `account-profiles.yaml` weights to include `gc_identified`/`warm_gc` at sum=100 and lift the score-neutral signals into weighted components.
- **GOTCHA**: **Do NOT finalize before Solis confirms** (§12.3/§22, `account-profiles.yaml:120-121`, `calibration_pending:162-169`). Everything above ships provisional/signal-only until then.
- **VALIDATE**: post-calibration, priority-band ranks verified-GC, territory-fit, early-stage Solis projects above keyword-only matches.

---

## Testing Strategy

### Unit / Integration
| Test | Repo | Input | Expected | Edge? |
|---|---|---|---|---|
| widened-read smoke | INSIGHTS | `fetchRegistryIdentityRows` | 21 cols mapped incl. `status`,`root_domain`; geo NULL-safe | contract drift |
| lineage guard | INSIGHTS | merged entity for a UBI | org reports `none`, not a stale bind | governance |
| registry-aware `orgIdentified` | INSIGHTS | bound vs regex-only GC | bound scores 1.0 > 0.75 | fallback tier intact |
| Solis `gc_identified` score-neutral | INSIGHTS | Solis project + verified GC | signal present, **score unchanged** (no weight) | §12.3 |
| registry-ref dedup | INSIGHTS | name variants of one bound entity | one org, merged roles, velocity counts once | conflict → no merge |
| nightly ordering | INSIGHTS | bind + score in one run | `scoreAll` reads this run's fresh `registry_ref` | pool ends once |
| partner schema idempotency | REGISTRY | double INSERT (dedupe_key / entity+system) | one row / upsert | ON CONFLICT targets exist |
| loader never-auto-merge | REGISTRY | trade_evidence + conflicting alias | review-queued candidate, **no** identity mutation | untrusted input |
| loader idempotency | REGISTRY | run ×2 | one alias/candidate, high-water mark advances | re-run safe |
| least-privilege | REGISTRY | reader role → `registry_internal` | permission denied | writer can't read `registry_public` |

### Edge Cases Checklist
- [ ] `REGISTRY_DATABASE_URL` unset → read/link/export skip cleanly (never crash)
- [ ] `status='merged'/'archived'` entity → excluded from binding
- [ ] geo cols NULL (locations empty) → scoring/binding tolerate absence
- [ ] account with no registry data → scoring identical to today (fallback tier)
- [ ] weights would exceed 100 if a Solis weight is added pre-calibration → Zod refinement blocks (intended)
- [ ] partner observation with instruction-like text → treated as data, review-only, no identity change
- [ ] pg-boss on 6543 pooler → session-port 5432

---

## Validation Commands

### Static Analysis
```bash
# INSIGHTS
pnpm --filter @otn/resolution --filter @otn/intelligence --filter @otn/db --filter @otn/worker run typecheck
```
EXPECT: zero type errors

### Insights DB-integration (local Supabase stood up on 5433)
```bash
DATABASE_URL="postgres://otn:otn@localhost:5433/otn" \
  pnpm exec vitest run apps/worker/test/registry-link.test.ts apps/worker/test/registry-observations.test.ts \
  packages/intelligence/src/scoring.test.ts
```
EXPECT: green (existing 14 + new scoring cases)

### Registry migrations + loader (scratch DB, then co-located)
```bash
# REGISTRY worktree (after merging origin/claude/insights-integration-seam)
supabase db reset            # applies the merged-in registry_partner + roles migrations
node apps/registry/scripts/entity-resolution/ingest-otn-insights.mjs --dry-run
node apps/registry/scripts/entity-resolution/report.mjs
```
EXPECT: partner schema present with unique/PK; loader idempotent; report shows new counts

### Live-seam smoke (once creds set, co-located session port)
```bash
psql "$REGISTRY_DATABASE_URL" -c "select count(*) from registry_public.trades_identity_v1;"   # ~25545
DATABASE_URL=... REGISTRY_DATABASE_URL=... pnpm --filter @otn/worker run resolve:run           # link → score runs live
```

### Manual Validation
- [ ] Solis org bound (`registry_ref = 8a12a7cb…`, `ubi_exact`)
- [ ] A Solis digest project shows a `verified_gc_on_project` / `warm_gc_active` signal in its rationale
- [ ] `registry_partner.partner_project_facts` receives Insights rollups; the loader adjudicates them
- [ ] Reader role cannot read `registry_internal`

---

## Acceptance Criteria
- [ ] Insights reads the full 21-col contract view, lineage-safe (`status`) and geo-null-safe
- [ ] `registry_ref` reaches `loadFeatures` → `routeSolis`; a verified GC raises `gc_identified` as a **signal** (score-neutral until §12.3 calibration)
- [ ] `registry_ref` is an org dedup key; name variants of one entity collapse before roles/velocity
- [ ] Nightly chain links before it scores
- [ ] `registry_partner` schema + `otn_insights_reader/_writer` roles exist on `release/trades-staging`; `ingest-otn-insights.mjs` consumes the write-back, human-gated, never auto-merging identity
- [ ] Solis bound on its strong key; home-metro coverage enabled (capture-gated)
- [ ] Solis weights finalized **iff** Solis has confirmed scope (else provisional, documented)
- [ ] WS-D documented as dependent on the registry ER PRP Phase 5 (not duplicated)

## Completion Checklist
- [ ] Real patterns mirrored (CONTRACT_READ, SCORE_COMPONENT, REGISTRY_WRITE_SHAPE, NEVER_AUTO_MERGE), not reinvented
- [ ] Governance intact: no new auto-binding; bindings human/strong-key only; least-privilege grants; partner input treated as untrusted data; no secrets in repo; capture-only for bot controls
- [ ] Both repos: commit → push immediately (Codex handoff); never target `origin/main`
- [ ] Tests green (Insights local DB + registry scratch DB); live-seam smoke once creds set
- [ ] Prerequisite activation plan referenced, not duplicated

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Merging the seam branch onto trunk (two view migrations + ER-core ordering) | Medium | Migration apply failure | Timestamp order handles it (`091458` base view + reader role → trunk's `120000` CREATE-OR-REPLACE adds address cols); verify `db reset` on the merged branch (C.1) |
| Registry roles/creds not provisioned | High | Loop stays dark | Skip-safe by design; env-only creds; prerequisite plan gate |
| `registry_entity_locations` empty ⇒ no geo | High (now) | Geo-fit dormant | WS-A null-safe; WS-B/D.2 geo staged behind registry Phase 3+ |
| Adding a Solis weight pre-calibration | Medium | §12.3 violation / broken Zod sum | Signal-now/weight-later; component travels in `components` at weight 0 |
| Partner observation treated as instruction | Low | Identity corruption | Review-only adjudication; never-auto-merge invariant; untrusted-data handling |
| pg-boss on Supabase pooler | High (seen) | Scheduler down | Session port 5432 (prerequisite plan) |
| WS-D blocked by dormant Phase 5 | Certain | Capstone deferred | Explicitly dependency-gated; A/B/E deliver Solis value without it |

## Notes
- **The immediate Solis wins (WS-A + WS-B + WS-E) use data that already exists and flows nightly** — the registry binding runs every night; it simply never reaches the scorer or the dedup matcher. That is the single most important finding: the highest-value inference lift needs **no new data**, just consumption.
- **Recommended execution order:** WS-A → WS-B → WS-E (immediate Solis inference lift, low risk, Insights-only) → WS-C (close the loop so the data compounds) → WS-D (capstone, gated on the registry ER PRP Phase 5).
- **Relationship to the prerequisite plan:** `insights-registry-integration-solis.plan.md` turns the seam **on** (co-locate, creds, run the loop, bind Solis, coverage). This plan makes the flow **smart** (widen the read, wire identity into inference, close the write-back) and **promotes** the already-built registry-side seam that plan deferred (verified on `origin/claude/insights-integration-seam` `ae80f657`). Run the prerequisite's WS1 (co-locate + session port) before this plan's live-seam validation.
- **The deepest single Solis inference** is a verified GC from Solis's own warm network appearing early on an in-territory project — WS-E.1 (bind Solis) + WS-E.2 (warm-network signal) + WS-B (identity in score) together turn "here are permits" into "here is an early project where a GC Solis already works with is active."
