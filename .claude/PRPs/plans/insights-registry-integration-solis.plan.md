# Plan: Take the Insights ⇄ Registry seam live, connect the identity/observation loop, and optimize the flow for Solis

## Summary
The Insights ⇄ One Trade Network registry seam is **already built and validated live** (contract view `registry_public.trades_identity_v1` with 25,545 WA-first entities; the resolver, observation loop, review gate, and export are all in code and tested). It is currently **dark** because Insights has no `REGISTRY_DATABASE_URL` and no `otn_insights_reader`/`_writer` credentials, so link/generate/export run in a visible "skipped" state. This plan (a) takes the seam **live** on a **co-located topology** (both DB pools point at one Supabase, separate schemas — "co-locate now, split later"), (b) runs the identity **bind → review → adopt → observation-feed** loop end-to-end so bound orgs carry verified L&I identity and the best inferences unlock, and (c) optimizes the flow to deliver **highest-value data to Solis** (bind Solis itself, light up its home-metro coverage, and finalize its scoring once Solis confirms scope).

## User Story
As **the Solis pilot operator**, I want Insights organizations bound to their verified One Trade Network registry identities and Solis's own network mapped, so that **the projects and contacts Insights delivers to Solis carry verified identity, trade, activity, and relationship signals — the best inferences the two datasets can produce together.**

## Problem → Solution
**Now:** Insights ingests public permit/notice data (this session's WS1–WS6 adapter work made records identifier-rich — phone/address/`source_entity_id`), but `REGISTRY_DATABASE_URL` is unset → `registry-link`/`generate`/`export` skip → orgs are unbound → identity-dependent inferences (verified identity, trade codes, org-activity/velocity, GC↔sub relationships, verified contacts) are starved. Solis scoring is intentionally provisional.
**Desired:** One co-located Supabase; the registry contract view live; the nightly loop binding orgs (human-gated) and exporting activity back; Solis bound and its home-metro coverage enabled; scoring finalized on Solis's confirmed scope.

## Metadata
- **Complexity**: XL (cross-DB integration + cross-team dependency + operational rollout; most Insights-side *code* already exists, so the delta is topology, wiring, data, and tuning)
- **Source PRD**: N/A (derived from `docs/integration-one-trade-network.md`)
- **PRD Phase**: N/A (standalone; supersedes the completed `registry-bridge-data-connection.plan.md`)
- **Estimated Files**: ~10–15 Insights-side (config/env, a mirror migration if sync-mode, Solis binding CLI/data, adapter config, scoring weights, tests) + **registry-side prerequisites owned by the registry team** (see Cross-Team Dependencies)

---

## UX Design

### Before
```
Insights corpus ──► [registry-link: SKIPPED] ──► orgs unbound ──► no verified identity/trade
                                                              ──► digests to Solis: names only, no verification
```
### After
```
Insights corpus ──► registry-link (LIVE, reads trades_identity_v1)
   ──► observation queue ──► operator review (/app/admin/registry-review)
   ──► accept binds registry_ref + identity snapshot + global public_business contact
   ──► export accepted activity ──► registry_partner staging (registry adjudicates)
   ──► bound orgs carry UBI/license/trade/verified-phone
   ──► org-activity / relationships / trust light up ──► Solis digests: verified identity + warm-network + timing
```
### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Nightly maintenance chain | registry steps log "skipped" | link → generate → export run live | `apps/worker/src/schedules.ts:106-118` — no code change, needs the env + credentials |
| Operator review | queue empty (no candidates) | top-N trust-scored binding candidates | `/app/admin/registry-review` + `apps/web/app/api/admin/registry-observations/[id]/decision/route.ts` (exists) |
| Org page | name-only | "One Trade Network verified" panel (identity snapshot) | `getOrganizationView` (built per doc Increment 5) |
| Solis digest | unverified leads | verified GC identity + relationship warmth + stage timing | delivery layer consumes `registry_ref`-enriched orgs |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| **P0** | `docs/integration-one-trade-network.md` | all | The authoritative contract: build status, resolution ladder (Part B), co-location checklist (Part E), the two learning feeds (I.2/I.3), registry-side dependencies (J.1–J.5), and the recommended sequence. **Every task references this.** |
| **P0** | `packages/db/src/client.ts` | 1-29 | `createPool` (Insights `DATABASE_URL`) and `createRegistryPool` (registry `REGISTRY_DATABASE_URL`, **returns null when unset** → skip, never crash). The two-pool seam that makes co-location a config change. |
| **P0** | `apps/worker/src/schedules.ts` | 106-118 | The orchestration: `createRegistryPool()` → `fetchRegistryIdentityRows` → `generateRegistryObservations` → `exportRegistryObservations`. Where "skipped" becomes "live". |
| **P0** | `packages/resolution/src/registry-observations.ts` | all (758) | The observation loop: `generateRegistryObservations`, binding rules (`binding_name_exact`/`_phone`/`binding_phone_match`/`binding_address_match`), `MIN_QUEUE_TRUST`/`TRUST_WEIGHTS`/auto-accept gates (bindings NEVER auto-accept), `decideRegistryObservation` (accept binds `registry_ref` + snapshot + global contact), `exportRegistryObservations` (writes `registry_partner.*`). |
| **P0** | `packages/resolution/src/registry-link.ts` | all | `RegistryIdentityRow` (the `trades_identity_v1` column contract: `entity_id, ubi, contractor_numbers, canonical_name, canonical_name_normalized, phone, city_token, state_code, registered_address, registered_postal_code`), `fetchRegistryIdentityRows`, `identitySnapshot`. |
| **P1** | `packages/resolution/src/identifiers.ts` | all | `addressMatchKey`, `loadOrganizationAddresses`, `loadOrganizationPhones`, `findOrganizationBySourceEntityId`, strong-key backfeed onto `organizations.ubi`/`contractor_registration`. This session's WS1 identifier work — the reason bound-coverage will lift. |
| **P1** | `packages/db/migrations/0022_registry_observations.sql` | all | Insights-side `registry_observations` schema (staging queue, dedupe_key, status, trust_components). The last hand-authored migration — mirror its style for any new migration. |
| **P1** | `config/account-profiles.yaml` | `solis_interiors` block | Solis identity (`SOLISIL785NT`, UBI 604837560 per doc Part B), territory (Thurston/Pierce/Lewis/King, **provisional**), and the "do NOT finalize weights until Solis confirms scope" gate (spec §12.3/§22). |
| **P1** | `config/sources.yaml` | `olympia_smartgov_reports`, `tumwater_sepa`, `tumwater_development_review` | The home-metro dark adapters (`enabled: false`) to activate for Solis coverage. |
| **P2** | `apps/web/app/api/admin/registry-observations/[id]/decision/route.ts` | all | The review-decision API (already exists) — the human gate surface for WS2. |
| **P2** | `docs/integration-one-trade-network.md` | Part E (344-371), Part J (677-763) | Co-location checklist + the registry-side prerequisites (what the registry team must build for Feed 2). |

## External Documentation
| Topic | Source | Key Takeaway |
|---|---|---|
| Registry Supabase | `docs/…one-trade-network.md` Part A/J | Trades project `arbmeioglflvzoffgtii`, PG17, `registry_internal` (RLS, service_role only). The `v1` view + `registry_partner` are the ONLY reachable surfaces. |
| pg-boss on Supabase | Part E | pg-boss uses `LISTEN/NOTIFY` + advisory locks — **breaks on the Supabase transaction pooler (6543)**; the worker must use the **direct/session connection (5432)**, or converge to `pgmq`. (This is exactly the local `schedules` failure we saw.) |
| Postgres cross-schema | Part C/E | Co-located ⇒ the sync/FDW question "collapses into a plain cross-schema join"; the two-pool code needs no change (both URLs → same Supabase, different schemas). |

---

## Patterns to Mirror

### TWO_POOL_NULL_SAFE_SEAM
// SOURCE: packages/db/src/client.ts:20-25
```ts
export function createRegistryPool(registryDatabaseUrl = process.env.REGISTRY_DATABASE_URL): pg.Pool | null {
  if (!registryDatabaseUrl) return null;         // unset ⇒ pipeline runs, link reports "skipped"
  return new pg.Pool({ connectionString: registryDatabaseUrl, max: 4 });
}
```
Co-location = point `REGISTRY_DATABASE_URL` at the same Supabase as `DATABASE_URL` (different schema). No refactor.

### OBSERVATION_LOOP (generate → review → export; bindings never auto-accept)
// SOURCE: packages/resolution/src/registry-observations.ts:490-505, 611-620
```ts
const autoAccept =
  ins.observationType !== "binding_name_match" &&   // ALL binding rules carry this type ⇒ never auto-accept
  (h?.decisions ?? 0) >= AUTO_ACCEPT_MIN_DECISIONS &&
  (h ? h.accepts / h.decisions : 0) >= AUTO_ACCEPT_MIN_RATE;
// accept path binds registry_ref with method 'name_review_confirmed' + stamps identity snapshot
```

### ORCHESTRATION (the skipped→live switch)
// SOURCE: apps/worker/src/schedules.ts:106-118
```ts
const registryPool = createRegistryPool();                                   // null ⇒ skips below
const registryRows = registryPool ? await fetchRegistryIdentityRows(registryPool) : null;
registryObs    = await generateRegistryObservations(db, registryRows, { logger });
registryExport = await exportRegistryObservations(db, registryPool, { logger });
await registryPool?.end();
```

### RESOLUTION_LADDER (doc Part B — strong-key auto-bind, name/phone/address → review)
```
1 ubi (exact, strong)  2 contractor_number (exact, strong)  → may auto-bind
3 name_normalized + state (+city)  4 phone/address (this session's WS1)  → candidate → REVIEW, never auto-bind
Respect lineage: merged_into_entity_id / status<>'active' ⇒ follow/skip; exclude closed UBI 604701295.
```

### HAND_AUTHORED_MIGRATION
// SOURCE: packages/db/migrations/0022_registry_observations.sql (+ journal convention)
New migrations are hand-authored SQL files, numbered sequentially, with a journal entry — NOT drizzle-kit generated (per repo convention seen across 0000–0022).

### DB_INTEGRATION_TEST
// SOURCE: apps/worker/test/registry-observations.test.ts (14 tests, green against local PG)
Injects registry rows directly (pure-matcher pattern) so the loop is testable without a live registry; `DATABASE_URL` from `vitest.config.ts` default (`postgres://otn:otn@localhost:5432/otn`), `fileParallelism:false`, `resetSource` fixture.

---

## Files to Change
| File | Action | Justification |
|---|---|---|
| `.env` (local) / deploy env | UPDATE | Set `REGISTRY_DATABASE_URL` (co-located Supabase, `registry_public`/`registry_partner` reachable) + `DATABASE_URL` on the **session (5432)** connection (pg-boss constraint) |
| `packages/db/migrations/00XX_*.sql` | CREATE (if sync-mode) | Optional `registry_business_mirror` + drift-fingerprint (doc H.2/H.3) — only if not using a direct co-located cross-schema read |
| `apps/worker/src/cli/*` | VERIFY/UPDATE | Confirm `resolve:run`/registry step and a one-shot `registry:link` path for the first live bind + Solis seed |
| `config/sources.yaml` | UPDATE | Flip `olympia_smartgov_reports`, `tumwater_sepa`, `tumwater_development_review` to `enabled: true` after shadow validation (Solis home-metro coverage) |
| `config/account-profiles.yaml` | UPDATE (gated) | Finalize Solis territory + scoring weights — **only after Solis confirms scope** (§12.3/§22) |
| `apps/worker/test/*.test.ts` | UPDATE | Add a live-view smoke path (bound-coverage assertion) + Solis-bind test |
| docs / runbook | UPDATE | Operator runbook for the review queue + the registry-side handoff (`ingest-otn-insights.mjs` cadence) |

## NOT Building
- **The registry-side code** — the `v1` view and `registry_partner` are **already built/validated** (doc Increment 1/3/4); Feed 2's dormant loaders (`ingest-otn-insights.mjs` sibling, alias/location/trade populators, carry-`entity_id` adjudication) are **the registry team's** work (Part J.3). This plan produces the export; the registry consumes it.
- **The full Part E co-location** (moving Insights *into* the Trades Supabase with RLS on every table, pg_cron, storage migration) — that is the deliberate "split later" migration; this plan co-locates only the **DB pool topology** + settles the pg-boss session-connection constraint.
- **Repo convergence (Part F)** — re-homing Insights into `apps/crm` is downstream of a proven, load-measured seam.
- **Finalizing Solis scoring weights** — gated on Solis confirming scope/territory/trade focus (a customer conversation, not a code task).
- **Auto-binding on name/phone/address** — governance-fixed: those always route to human review.

---

## Step-by-Step Tasks

### WS1 — Take the seam live on a co-located topology

#### Task 1.1: Confirm the registry contract surface + credentials (cross-team gate)
- **ACTION**: Confirm with the registry team that `registry_public.trades_identity_v1` is live on the target Supabase and that `otn_insights_reader` (SELECT on `registry_public`) + `otn_insights_writer` (INSERT/UPDATE on `registry_partner`) roles exist (one credential may hold both).
- **IMPLEMENT**: Obtain the connection string; confirm the view's columns match `RegistryIdentityRow` (`registry-link.ts`).
- **GOTCHA**: Per doc line 59-66 this is **remaining ops gate (a)** — until provisioned, everything skips. Registry `registry_internal` is service_role-only; the ONLY reachable surface is the view.
- **VALIDATE**: `psql "$REGISTRY_DATABASE_URL" -c "select count(*) from registry_public.trades_identity_v1;"` returns ~25,545.

#### Task 1.2: Wire `REGISTRY_DATABASE_URL` (co-located, session connection)
- **ACTION**: Set `REGISTRY_DATABASE_URL` and point `DATABASE_URL` at the **session port (5432)**, not the transaction pooler (6543).
- **MIRROR**: TWO_POOL_NULL_SAFE_SEAM — no code change; the wiring in `schedules.ts:108` already handles both.
- **GOTCHA**: pg-boss (`schedules.ts` `registerSchedules`) **breaks on the 6543 pooler** (LISTEN/NOTIFY + advisory locks) — this is exactly the local `schedules.test.ts` failure. Use 5432 or converge to `pgmq`.
- **VALIDATE**: worker boot logs registry steps as running (not "skipped"); `registerSchedules` succeeds.

#### Task 1.3 (optional): Sync mirror + drift fingerprint (only if NOT a plain cross-schema read)
- **ACTION**: If the registry stays a separate Supabase (grant-based sync), add `registry_business_mirror` (typed fields + `raw jsonb`) and a nightly `registry:sync`.
- **MIRROR**: HAND_AUTHORED_MIGRATION; tolerant-reader pattern (doc H.2) — `SELECT` named fields, stash whole row as raw blob.
- **GOTCHA**: Co-located ⇒ **skip this** (doc Part C: the sync/FDW question "collapses into a plain cross-schema join"). Only build for the separate-DB topology.
- **VALIDATE**: drift-fingerprint (reuse D3) flags additive vs breaking contract change; breaking ⇒ fail the sync (never bind stale).

### WS2 — Connect the identity/observation loop end-to-end

#### Task 2.1: First live bind pass (shadow → real)
- **ACTION**: Run `generateRegistryObservations` against the live view over the full org corpus.
- **IMPLEMENT**: Reuse the nightly path; run once on-demand first.
- **MIRROR**: OBSERVATION_LOOP + RESOLUTION_LADDER. Bindings land in the queue; nothing auto-binds.
- **GOTCHA**: Live corpus has **~zero orgs with UBI/license** (doc line 19-26), so the working key is **name+locality + this session's phone/address** — the queue will be name/phone/address candidates, reviewed top-N. Exclude person names (owner-builders) via person-vs-company gate.
- **VALIDATE**: `listRegistryObservations` returns trust-ranked candidates ≥ `MIN_QUEUE_TRUST` (0.55); measure the **bound-coverage lift** attributable to WS1–WS6 identifiers (phone/address/`source_entity_id`) vs name-only.

#### Task 2.2: Operator review workflow
- **ACTION**: Stand up / verify the top-N review at `/app/admin/registry-review` and the decision API.
- **MIRROR**: the existing `apps/web/app/api/admin/registry-observations/[id]/decision/route.ts`.
- **GOTCHA**: accept binds `registry_ref` (`name_review_confirmed`), stamps the identity snapshot, and (for phone) writes a **global `public_business` contact** (`account_profile_id IS NULL`, migration 0020) — verify the guard.
- **VALIDATE**: accepting one candidate sets `organizations.registry_ref`, `registry_identity_json`; rejecting updates rule-history (the Laplace-smoothed learning signal).

#### Task 2.3: Export accepted activity → `registry_partner`
- **ACTION**: Run `exportRegistryObservations` after accepts.
- **MIRROR**: registry-observations.ts:663-757 — `partner_observations` (alias/trade) + `partner_project_facts` (per-entity rollup, replace-on-export), tagged `source_system='otn_insights'`, dedupe_key.
- **GOTCHA**: **null writer ⇒ visible skip** — needs the `_writer` credential. Feed 2's *ingestion* is registry-side (`ingest-otn-insights.mjs` + dormant loaders, Part J.3) — Insights only writes staging.
- **VALIDATE**: rows appear in `registry_partner.partner_observations`; re-run is idempotent (dedupe_key ON CONFLICT DO NOTHING).

#### Task 2.4: Unlock identity-dependent inferences
- **ACTION**: With orgs bound, confirm the inference layers consume `registry_ref` identity: org-activity/velocity, relationships (GC↔sub co-occurrence, doc I.3), trust, verified contacts.
- **GOTCHA**: These were starved because identity was absent; verify they read the bound identity, not just names.
- **VALIDATE**: a bound GC shows trade codes + activity + relationship edges on the org page; `getOrganizationView` returns own + global contacts.

### WS3 — Optimize the flow for Solis's highest-value data

#### Task 3.1: Bind Solis itself (the seed inference)
- **ACTION**: Bind Solis's org to its registry entity on its **strong key** (`SOLISIL785NT` / UBI 604837560 — doc says Solis → `8a12a7cb…`).
- **MIRROR**: RESOLUTION_LADDER rank 1/2 (strong-key auto-bind is allowed).
- **GOTCHA**: Exclude the **closed** Solis UBI `604701295` (doc line 202 / account rule).
- **VALIDATE**: Solis org `registry_ref` set to `8a12a7cb…`; Solis's trade code + co-appearing GCs become the seed for "who to pursue with."

#### Task 3.2: Enable home-metro coverage
- **ACTION**: After shadow validation, flip `olympia_smartgov_reports`, `tumwater_sepa`, `tumwater_development_review` to `enabled: true` (Thurston/Olympia = Solis turf); confirm geocode territory filtering.
- **MIRROR**: this session's Olympia durability refactor + the tumwater_sepa/DRC adapters (all capture-fed, dead-letter-safe).
- **GOTCHA**: capture-fed sources dead-letter on live fetch by design — they need the operator-provided captures; keep `enabled` gated on capture availability.
- **VALIDATE**: source-run health green; more Thurston-metro records feeding Solis's territory.

#### Task 3.3: Finalize Solis scoring (gated on Solis confirmation)
- **ACTION**: Once Solis confirms territory + trade focus + min project size + stage preference, finalize `account-profiles.yaml` weights (fit × stage-timing × relationship-warmth × territory).
- **GOTCHA**: **Do NOT finalize before Solis confirms** (§12.3/§22) — the profile explicitly forbids it. Until then keep provisional.
- **VALIDATE**: pursuit/score/brief outputs rank Solis-relevant early-stage projects with verified GC/owner contacts + relationship warmth.

#### Task 3.4: Close the feedback loop
- **ACTION**: Route Solis accept/reject on delivered leads into `intelligence/feedback.ts` + the rule-history learning already in the observation loop.
- **VALIDATE**: reviewed decisions shift subsequent scoring/queue ranking.

---

## Testing Strategy
### Unit / Integration Tests
| Test | Input | Expected | Edge? |
|---|---|---|---|
| live-view smoke | `fetchRegistryIdentityRows(registryPool)` | ~25,545 rows, columns match `RegistryIdentityRow` | contract-drift |
| bound-coverage lift | corpus with phone/address identifiers | more binding candidates than name-only baseline | measures WS1–WS6 value |
| Solis strong-key bind | Solis org + `SOLISIL785NT`/UBI | auto-binds to `8a12a7cb…`; idempotent | closed-UBI `604701295` excluded |
| review accept | pending binding observation | sets `registry_ref` + snapshot + global contact | rule-history updated |
| export idempotency | accepted observations ×2 | one `partner_observations` row (dedupe) | ON CONFLICT DO NOTHING |
| skip-safe | `REGISTRY_DATABASE_URL` unset | link/generate/export "skipped", no crash | governance |

### Edge Cases Checklist
- [ ] `REGISTRY_DATABASE_URL` unset → skip cleanly (never crash)
- [ ] merged/inactive registry entity → follow lineage / skip
- [ ] name/phone/address candidate → review, **never** auto-bind
- [ ] person (owner-builder) name → excluded from company binding
- [ ] contract-view breaking drift → fail the sync, don't bind stale
- [ ] pg-boss on 6543 pooler → detected; use session 5432

---

## Validation Commands
### Static Analysis
```bash
pnpm --filter @otn/resolution --filter @otn/db --filter @otn/worker run typecheck
```
EXPECT: zero type errors

### DB-integration tests (against the local Supabase/Postgres stood up this session)
```bash
DATABASE_URL="postgres://otn:otn@localhost:5433/otn" \
  pnpm exec vitest run apps/worker/test/registry-link.test.ts apps/worker/test/registry-observations.test.ts
```
EXPECT: green (14 tests) — the seam logic

### Live-seam smoke (once REGISTRY_DATABASE_URL is set)
```bash
psql "$REGISTRY_DATABASE_URL" -c "select count(*) from registry_public.trades_identity_v1;"   # ~25545
DATABASE_URL=... REGISTRY_DATABASE_URL=... pnpm --filter @otn/worker run resolve:run           # link runs live, not skipped
```
### Manual Validation
- [ ] Solis org bound (`registry_ref = 8a12a7cb…`)
- [ ] Review queue shows trust-ranked candidates; accept binds + snapshots
- [ ] `registry_partner.partner_observations` receives exported rows
- [ ] Bound GC org page shows trades + activity + relationships

---

## Acceptance Criteria
- [ ] `REGISTRY_DATABASE_URL` set on a session (5432) connection; registry steps run live (not skipped)
- [ ] First live bind pass produces a reviewable queue; bound-coverage lift from WS1–WS6 identifiers measured
- [ ] Review → accept binds `registry_ref` + snapshot + global contact; export lands in `registry_partner`
- [ ] Solis bound on its strong key; home-metro adapters enabled
- [ ] Identity-dependent inferences (activity/relationships/trust) populated for bound orgs
- [ ] Solis scoring finalized **iff** Solis has confirmed scope (else provisional, documented)

## Completion Checklist
- [ ] Two-pool seam live; pg-boss on session connection
- [ ] Governance intact (bindings human-only; person names excluded; closed UBI excluded; skip-safe)
- [ ] Tests green (local DB) + live-seam smoke
- [ ] No registry connection strings in the repo (env only)
- [ ] Operator runbook for the review queue + registry handoff cadence

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Registry-side credentials/roles not provisioned | High | Blocks everything | Cross-team gate Task 1.1; until then seam stays skip-safe (no harm) |
| pg-boss breaks on Supabase pooler | High (seen locally) | Scheduler down | Session connection (5432) or converge to `pgmq` (Part E) |
| Feed 2 registry-side loaders dormant | Medium | Export lands but isn't consumed | Insights writes staging regardless; registry team builds `ingest-otn-insights.mjs` + loaders (J.3) |
| Low bound-coverage (no strong keys in corpus) | Medium | Fewer auto-binds | Name+phone+address review path (WS1–WS6) is the spine; PALS enrichment (I.4) later |
| Solis scope unconfirmed | Medium | Scoring can't finalize | Keep provisional (§12.3); ship everything else; finalize on confirmation |
| Contract-view schema drift | Low | Stale/mis-typed binds | Drift fingerprint (H.3): additive→amber, breaking→red/fail |

## Notes
- **Most Insights-side code already exists and is tested** (this session ran the 14 registry integration tests green against local PG). The delta is **topology (co-locate the pools), credentials (registry roles + env), the first live run, review operations, Solis binding, coverage, and gated Solis tuning** — plus the **registry team's** Feed-2 ingestion.
- "Co-locate now, split later": WS1 co-locates the **pool topology** only (both URLs → one Supabase, separate schemas), preserving the two-pool code seam so the **full Part E migration** (RLS-per-table, pg_cron, storage) and **Part F repo convergence** remain clean, deferred, config-only splits.
- The single highest-leverage inference for the Solis pilot is **Task 3.1 (bind Solis) + Task 2.4 (relationships)**: it turns "here are permits" into "here are early projects where Solis's own warm GCs are active, with verified contacts."
