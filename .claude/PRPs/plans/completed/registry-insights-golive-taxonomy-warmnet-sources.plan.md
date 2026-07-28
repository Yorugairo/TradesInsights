# Plan: Go-live runbook + shared trade vocabulary + warm-network signal + home-metro sources

## Summary
Four remaining workstreams to finish the registry ⇄ insights dataflow. **(RB)** an ops runbook to take the merged seam live (provision the `otn_insights` login role, set `REGISTRY_DATABASE_URL`, run the loop). **(WS-T)** make the registry trade taxonomy the **single source of truth** for trades + their keywords: seed it (and per-entity trade assignments) from each contractor's **L&I license specialties** already in the trades DB, expose it on the contract surface, and have Insights **derive** its permit-text matcher from that shared vocabulary — replacing the hardcoded 7-keyword list and closing the finish-trade gap (drywall/painting/glazing). **(WS-W)** lift warm-network (active registry-bound GCs in Solis's territory) from digest-only into a score-neutral Solis scoring signal. **(WS-S)** enable the three dark Thurston/home-metro sources (capture-gated).

## User Story
As **the Solis pilot operator**, I want the seam live, every contractor's real trades known to both systems (drywall/painting/glazing included, sourced from L&I), and warm in-territory GCs surfaced on the projects Solis sees — so **the registry and Insights share one trade vocabulary derived from authoritative WA data, and Solis's leads carry verified trade + relationship signals.**

## Problem → Solution
- **Seam merged but dark:** `registry_partner` + roles + `ingest-otn-insights.mjs` are on trunk (`6b72c81`), but no login role / `REGISTRY_DATABASE_URL` → the loop can't run. **→ RB runbook.**
- **Two trade vocabularies, one blind:** scoring's `classify` detects drywall/painting/glazing over full text ([scoring.ts:82-83](packages/intelligence/src/scoring.ts:82)), but the registry `trade_export` matches a hardcoded 7 codes against `permitType` **only** ([registry-observations.ts:456](packages/resolution/src/registry-observations.ts:456)) — the finish trades never reach the registry, and the vocabularies can drift. Meanwhile the registry has **every entity's real trades** in L&I `license.specialty1/2` but `registry_trade_taxonomy`/`_assignments` ship **empty**. **→ WS-T: L&I-seeded taxonomy as SoT + Insights derives its matcher from it.**
- **Warm network is digest-only:** `relationshipTargets` surfaces active in-territory orgs for the digest ([org-activity.ts:203](packages/intelligence/src/org-activity.ts:203)) but never reaches `routeSolis`. **→ WS-W.**
- **Home-metro coverage off:** Olympia + Tumwater×2 (Solis's turf) are `enabled: false`. **→ WS-S.**

## Metadata
- **Complexity**: Large (two repos; new shared-vocabulary contract + L&I-derived seed; the rest are additive)
- **Source PRD**: N/A — follows `registry-insights-dataflow-solis-inference.plan.md` (WS-B/A/E.1/B.4/C shipped) + `trades-entity-resolution.plan.md` (owns ER Phase 5, which WS-T partially fulfills)
- **Estimated Files**: ~6 registry-side (2 seed scripts, 1 view migration, loader fix, tests) + ~6 Insights-side (taxonomy client, trade_export rewrite, warm-network signal, sources.yaml, tests) + 1 runbook doc

## Repos & Worktrees
| Alias | Path | Branch |
|---|---|---|
| **INSIGHTS** | `C:\Users\Snipe\Downloads\TradesInsights` | `claude/tmux-install-320aiz` |
| **REGISTRY** | `…\.claude\worktrees\trades-google-place-integration-v2` | `release/trades-staging` (`6b72c81`, seam merged) |

> Never target `origin/main`. Commit → push immediately (Codex handoff). Bindings stay human/strong-key; partner input is untrusted data; no secrets in the repo (env only); never bypass Akamai/bot controls (capture genuine bytes only).

---

## Mandatory Reading
| Priority | Repo · File | Lines | Why |
|---|---|---|---|
| **P0** | REGISTRY `apps/registry/scripts/entity-resolution/trades-config.mjs` | 1-36 | L&I data shape: `settings.license = {number,type,specialty1,specialty2,…}` — the taxonomy + assignment seed source |
| **P0** | REGISTRY `apps/registry/scripts/entity-resolution/ingest-otn-insights.mjs` | 1-130 | The merged loader — its trade path + the `assignment_rank` value to reconcile |
| **P0** | REGISTRY `db/baseline-v1.2/18_entity_resolution.sql` | 332-367 | `registry_trade_taxonomy` (`keywords[]`, `active`, PK vertical+code) + `registry_trade_assignments` (PK entity+code, `assignment_rank` CHECK `primary\|secondary`, `source`) |
| **P0** | REGISTRY `apps/registry/supabase/migrations/20260719091458_registry_public_trades_identity_v1.sql` | all | The `registry_public` view + `otn_insights_reader` grant pattern to mirror for the taxonomy view |
| **P0** | INSIGHTS `packages/resolution/src/registry-observations.ts` | 154-162, 454-483 | Hardcoded `TRADE_KEYWORDS` + the `trade_export` query (permitType-only) to replace with a taxonomy-derived, permitType+description matcher |
| **P0** | INSIGHTS `packages/resolution/src/registry-link.ts` | 161-179 | `fetchRegistryIdentityRows` — the contract-read pattern to mirror for a `fetchTradeTaxonomy` |
| **P1** | INSIGHTS `packages/intelligence/src/scoring.ts` | 76-106, 393-483 | `RE.interior`/`RE.glazing` finish-trade vocabulary; `routeSolis` signal insertion (the `verified_gc_on_project` pattern from WS-B) |
| **P1** | INSIGHTS `packages/intelligence/src/org-activity.ts` | 100-223 | `orgActivityRollup` (carries `registryRef`) + `relationshipTargets` — the warm-network source to feed the scorer |
| **P1** | INSIGHTS `config/sources.yaml` | 243-256, 345-398 | The three dark sources: `on_demand` cadence + Akamai capture-fed |
| **P1** | INSIGHTS `apps/worker/src/schedules.ts` | 88-171 | `schedulableSources` filter (`on_demand` never scheduled) + the maintenance chain |
| **P2** | REGISTRY `.claude/PRPs/plans/trades-entity-resolution.plan.md` | 154-193 | ER Phase 5 owns the taxonomy; WS-T fulfills its trade-seed; reconcile `registry_business_service_tags` |

---

## Patterns to Mirror

### L&I_LICENSE_SHAPE — REGISTRY `trades-config.mjs:8-10`
```
// one tenant per contractor license, settings = { ubi, principal, phone, address, city, zip,
//   legal_name, license:{number,type,specialty1,specialty2,...}, source:'wa_lni_g526_rd4x', ... }
```

### CONTRACT_VIEW + READER_GRANT — REGISTRY `20260719091458_registry_public_trades_identity_v1.sql:70-75`
```sql
IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'otn_insights_reader') THEN CREATE ROLE otn_insights_reader NOLOGIN; END IF;
GRANT USAGE ON SCHEMA registry_public TO otn_insights_reader;
GRANT SELECT ON registry_public.trades_identity_v1 TO otn_insights_reader;   -- mirror for trades_taxonomy_v1
```

### CONTRACT_READ (mirror for the taxonomy) — INSIGHTS `registry-link.ts:161-166`
```ts
export async function fetchRegistryIdentityRows(pool: RegistryPoolLike) {
  const res = await pool.query(`SELECT … FROM registry_public.trades_identity_v1`);
  return res.rows.map(…);   // fetchTradeTaxonomy: SELECT trade_code, label, keywords, active FROM registry_public.trades_taxonomy_v1
}
```

### TRADE_EXPORT (permitType-only — to widen) — INSIGHTS `registry-observations.ts:454-462`
```sql
SELECT o.id, o.registry_ref, upper(sr.normalized_json->>'permitType') AS permit_type, count(DISTINCT pr.source_record_id) n
FROM organizations o JOIN project_roles pr ON pr.organization_id=o.id AND pr.role='primary_contractor'
JOIN source_records sr ON sr.id=pr.source_record_id
WHERE o.registry_ref IS NOT NULL AND sr.normalized_json->>'permitType' IS NOT NULL …
```

### SCORE_NEUTRAL_SIGNAL (§12.3) — INSIGHTS `scoring.ts` (WS-B `verified_gc_on_project`)
```ts
if (f.orgs.some((o) => o.registryVerified && ["primary_contractor","applicant","owner"].includes(o.role ?? "")))
  signals.push("verified_gc_on_project");   // component absent from weights ⇒ score unchanged
```

### ER_SCRIPT_SHAPE — REGISTRY `apps/registry/scripts/entity-resolution/*.mjs`
`makePool()` from `./db.mjs` + `withTransaction`; `--dry-run`/`--limit`; idempotent upserts; `report.mjs` observability.

---

## Files to Change
| Repo · File | Action | Why |
|---|---|---|
| REGISTRY `apps/registry/scripts/entity-resolution/seed-trade-taxonomy.mjs` | CREATE | Seed `registry_trade_taxonomy` from distinct L&I specialties + curated `keywords[]` |
| REGISTRY `apps/registry/scripts/entity-resolution/assign-license-trades.mjs` | CREATE | Seed `registry_trade_assignments` per entity from its L&I `license.specialty*` (`source='license_code'`) |
| REGISTRY `apps/registry/supabase/migrations/00XX_registry_public_trades_taxonomy_v1.sql` | CREATE | `registry_public.trades_taxonomy_v1` (trade_code, label, keywords[], active) + `otn_insights_reader` SELECT |
| REGISTRY `apps/registry/scripts/entity-resolution/ingest-otn-insights.mjs` | UPDATE | Fix `assignment_rank` vs CHECK; treat Insights trade evidence as corroborating (secondary) |
| REGISTRY `db/baseline-v1.2/*` + README | UPDATE | Curate the taxonomy seed into baseline apply-order + census row (ER Phase 5) |
| INSIGHTS `packages/resolution/src/trade-taxonomy.ts` | CREATE | `fetchTradeTaxonomy(pool)` + `buildTradeMatcher(rows)` (keyword→trade_code) |
| INSIGHTS `packages/resolution/src/registry-observations.ts` | UPDATE | trade_export: match taxonomy keywords over permitType **and** description; primary-contractor-attributed; description matches lower-confidence + review-gated; skip-safe fallback |
| INSIGHTS `packages/intelligence/src/warm-network.ts` (or org-activity.ts) | CREATE/UPDATE | `warmGcEntityIds(db, accountId)` — active bound GCs in territory |
| INSIGHTS `packages/intelligence/src/score-run.ts` + `scoring.ts` | UPDATE | Thread the warm-set into features; `routeSolis` `warm_gc_active` signal (score-neutral) |
| INSIGHTS `config/sources.yaml` | UPDATE | Flip the three Thurston sources `enabled: true` (capture-gated) |
| INSIGHTS `docs/runbooks/registry-seam-golive.md` | CREATE | The RB ops runbook |

## NOT Building
- **Auto-binding / auto-merge** — unchanged; description-derived trade evidence is review-gated, never a blind assignment.
- **Finalizing Solis weights** — WS-W stays signal-only (§12.3) until Solis calibration.
- **Bypassing Akamai** — WS-S is capture-fed only; enabling never implies scraping behind the bot wall.
- **The full ER Phase 5 fuzzy/website lanes** — WS-T seeds the *trade* half only; reconcile with `trades-entity-resolution.plan.md`, don't duplicate it.
- **Running the live loop against the registry** (RB C.3) from here — needs live credentials; the runbook documents it for the owner.

---

## Step-by-Step Tasks

### RB — Go-live runbook (ops doc; no live execution from here) · INSIGHTS doc + REGISTRY ops
#### Task RB.1: Write `docs/runbooks/registry-seam-golive.md`
- **ACTION**: Document, in order: (1) provision a LOGIN role — `CREATE ROLE otn_insights LOGIN PASSWORD '<secret>'; GRANT otn_insights_reader, otn_insights_writer TO otn_insights;` (the `_reader`/`_writer` are NOLOGIN grant-holders from the merged migrations); (2) set `REGISTRY_DATABASE_URL` (this login role) on the **session port 5432** in the Insights deploy env (never in the repo); (3) run the loop: Insights nightly (`resolve:run` → link/generate/export) then registry `node apps/registry/scripts/entity-resolution/ingest-otn-insights.mjs`.
- **MIRROR**: the two-pool skip-safe seam; the merged migrations' grants.
- **GOTCHA**: pg-boss breaks on the Supabase **transaction pooler (6543)** — session port 5432 only. Least-privilege: no `registry_internal` grant to the login role (the loader runs as the migration/service owner). Export is skip-safe if the credential is unset.
- **VALIDATE**: runbook lists the exact `psql` verification (`SELECT count(*) FROM registry_public.trades_identity_v1;` as reader works; `registry_internal` denied; INSERT into `registry_partner` works).

### WS-T — Shared trade vocabulary (taxonomy = SoT; Insights derives its matcher) · REGISTRY + INSIGHTS
#### Task T.1: Seed `registry_trade_taxonomy` from L&I specialties + curated keywords
- **ACTION**: `seed-trade-taxonomy.mjs` — `SELECT DISTINCT` each `settings->'license'->>'specialty1'` / `specialty2` … across contractor tenants (`source='wa_lni_g526_rd4x'`); normalize each to a `trade_code` (e.g. `drywall`, `painting`, `glazing`) + human `label`; attach a curated `keywords[]` dictionary per trade (specialty name + synonyms, e.g. drywall → `{drywall,gypsum,sheetrock,wallboard,taping}`; glazing → `{glazing,glass,curtain wall,storefront,window}`). Upsert `ON CONFLICT (vertical_key, trade_code)`.
- **MIRROR**: L&I_LICENSE_SHAPE; ER_SCRIPT_SHAPE.
- **GOTCHA**: L&I specialty strings are noisy/duplicative — normalize + map synonyms to one code (a curated map, not blind DISTINCT). `keywords[]` is the SHARED dictionary (Insights permit-match + registry website-evidence) — keep them permit-realistic. Idempotent; re-runnable as L&I data grows.
- **VALIDATE**: `SELECT count(*) FROM registry_internal.registry_trade_taxonomy WHERE vertical_key='trades'` covers the distinct L&I specialties incl. `drywall`/`painting`/`glazing`; `report.mjs` shows the taxonomy count.

#### Task T.2: Assign trades per entity directly from L&I license specialties
- **ACTION**: `assign-license-trades.mjs` — join each entity → its source records/tenants → `settings.license.specialty*`; upsert `registry_trade_assignments (entity_id, vertical_key, trade_code, assignment_rank='primary', source='license_code', confidence)`. This is the **authoritative** per-entity trade attribution (no permit inference needed).
- **MIRROR**: ER_SCRIPT_SHAPE; the DDL `source` enum lists `'license_code'` explicitly.
- **GOTCHA**: Map specialty → the SAME `trade_code` the taxonomy uses (T.1's normalizer, shared). PK `(entity_id, trade_code)` — a specialty1+specialty2 that map to the same code upsert once (rank primary; a second distinct trade → 'secondary'). Respect entity lineage (active only).
- **VALIDATE**: a known drywall contractor entity has a `drywall` assignment with `source='license_code'`; idempotent re-run.

#### Task T.3: Expose the taxonomy on the contract surface
- **ACTION**: Migration creating `registry_public.trades_taxonomy_v1` = `SELECT trade_code, label, keywords, parent_code, active FROM registry_internal.registry_trade_taxonomy WHERE vertical_key='trades' AND active`; `GRANT SELECT` to `otn_insights_reader`.
- **MIRROR**: CONTRACT_VIEW + READER_GRANT (owner-privileged view, `security_invoker=false`).
- **GOTCHA**: Least-privilege — expose only the vocabulary (code/label/keywords), never `registry_internal`. Version the view name (`_v1`) as a stable contract.
- **VALIDATE**: as `otn_insights_reader`, `SELECT trade_code, keywords FROM registry_public.trades_taxonomy_v1` returns rows; `registry_internal` denied.

#### Task T.4: Insights derives its trade matcher from the taxonomy (replaces hardcoded TRADE_KEYWORDS)
- **ACTION**: New `trade-taxonomy.ts` — `fetchTradeTaxonomy(pool)` (mirror `fetchRegistryIdentityRows`) + `buildTradeMatcher(rows)` → keyword→trade_code index. In `registry-observations.ts`, replace the hardcoded `TRADE_KEYWORDS` object with the taxonomy-derived matcher, and widen the `trade_export` query to scan **both** `permitType` **and** the description/title text (concat like the scorer's `text`), for `role='primary_contractor'`. permitType matches → confidence as today; description-only matches → **lower confidence**, flagged so the registry loader's review/taxonomy gate filters GC-misattributions.
- **MIRROR**: CONTRACT_READ; TRADE_EXPORT; the scorer's finish-trade vocabulary (`RE.interior`/`RE.glazing`) informs the seeded `keywords[]`.
- **IMPORTS**: `createRegistryPool` result → pass taxonomy rows into `generateRegistryObservations` (like `registryRows`).
- **GOTCHA**: **Skip-safe** — no `REGISTRY_DATABASE_URL` ⇒ taxonomy null ⇒ fall back to the current 7 keywords (or no trade emission), never crash. Description matches for a **GC** (not the finish sub) are the false-positive risk — that's exactly why they're lower-confidence + review-gated (the registry loader already gates trade evidence on the human-seeded taxonomy). Attribute only to `primary_contractor` (they're the named contractor).
- **VALIDATE**: a Solis TI permit (type "building", description "drywall and paint") with Solis as primary_contractor emits a `drywall` trade_evidence; a mechanical permit still emits `mechanical`; unit test on `buildTradeMatcher` (keyword→code) + a fixture with taxonomy rows.

#### Task T.5: Reconcile the loader's `assignment_rank` with the CHECK
- **ACTION**: `ingest-otn-insights.mjs` writes `registry_trade_assignments` — verify its `assignment_rank` literal against the DDL CHECK (`primary|secondary`). The header documents `'partner'`, which would violate the CHECK the moment the taxonomy is seeded and the loader assigns a trade. Fix: use `assignment_rank='secondary'` (Insights permit evidence corroborates the primary `license_code` assignment) and record the partner provenance in `source`/`evidence`, OR extend the CHECK to include `'partner'`. Prefer `'secondary'` (keeps L&I `license_code` as `primary`).
- **GOTCHA**: This bug is latent — dormant only because the taxonomy is empty (loader `skipped:unknown_trade_code`). Seeding the taxonomy (T.1) **activates** it, so T.5 must land with T.1.
- **VALIDATE**: with the taxonomy seeded, a `trade_evidence` obs for a taxonomy-known code inserts a `registry_trade_assignments` row (`source='otn_insights'`, rank `secondary`) without CHECK violation; idempotent.

### WS-W — Warm-network scoring signal (score-neutral §12.3) · INSIGHTS
#### Task W.1: Compute the active bound-GC-in-territory set
- **ACTION**: `warmGcEntityIds(db, accountProfileId)` — reuse `orgActivityRollup` (carries `registryRef`, filtered to relevant/active), keep bound orgs whose counties intersect the account territory; return the set of `registry_ref`s (+ later, GCs co-appearing with the account's own bound entity once E.1b lands).
- **MIRROR**: `org-activity.ts:203` `relationshipTargets`; group by registry `entity_id` where bound (B.4 makes variants collapse).
- **GOTCHA**: Data depends on bound orgs (needs the live registry connection / RB). Build the code now; it returns empty (harmless) until orgs are bound. Solis-specific co-appearance is the richer version, gated on E.1b (Solis bound).
- **VALIDATE**: with seeded bound in-territory GCs, the set is non-empty; empty + no crash when none bound.

#### Task W.2: Thread the warm-set into scoring + emit `warm_gc_active`
- **ACTION**: In `score-run.ts loadAccountInputs`/`scoreAll`, compute the warm-set per account and pass to `routeSolis`; add `if (f.orgs.some(o => o.registryRef && warmSet.has(o.registryRef))) signals.push("warm_gc_active")`.
- **MIRROR**: SCORE_NEUTRAL_SIGNAL — signal only, no Solis weight (score unchanged) until calibration.
- **GOTCHA**: `ProjectFeatures.orgs` already carries `registryRef` (WS-B.1). Keep the warm-set optional so accounts without it are unaffected. §12.3: no weight added.
- **VALIDATE**: `scoring.test.ts` — a project with a warm-set GC emits `warm_gc_active`; score identical with/without (score-neutral).

### WS-S — Home-metro source flips (capture-gated) · INSIGHTS
#### Task S.1: Enable the three Thurston sources
- **ACTION**: In `config/sources.yaml` set `enabled: true` for `olympia_smartgov_reports`, `tumwater_sepa`, `tumwater_development_review` **after** confirming operator captures exist for each (Akamai/dynamic — live fetch 403s/dead-letters by design).
- **MIRROR**: this session's Olympia/Tumwater adapters (capture-fed, dead-letter-safe).
- **GOTCHA**: All three are `cadence: on_demand` ⇒ `schedulableSources` never schedules them (`schedules.ts:82-86`); enabling makes them eligible for **operator-triggered capture-fed runs**, not cron. **Never bypass Akamai** — captures are genuine-visitor bytes only; the index carries no party data (homeowner-PII gate) so `organizations[]` stays empty. Keep `enabled` gated on capture availability.
- **VALIDATE**: source-run health for the three is green (or cleanly dead-lettered without captures); more Thurston-metro records feed Solis's territory; no PII in the bridge.

---

## Testing Strategy
| Test | Repo | Expected | Edge? |
|---|---|---|---|
| taxonomy seed | REGISTRY | distinct L&I specialties → taxonomy rows incl. drywall/painting/glazing | dup specialty strings collapse |
| license-trade assign | REGISTRY | drywall entity → `drywall` assignment, `source='license_code'`, rank primary | idempotent; multi-specialty |
| taxonomy contract | REGISTRY | reader SELECTs `trades_taxonomy_v1`; `registry_internal` denied | least-privilege |
| `buildTradeMatcher` | INSIGHTS | keyword→code map; permitType + description match | skip-safe when taxonomy null |
| finish-trade emission | INSIGHTS | Solis TI (desc "drywall") as primary_contractor → `drywall` evidence, lower confidence | GC-desc match → review-gated |
| loader rank | REGISTRY | trade assignment inserts (rank `secondary`) without CHECK violation | taxonomy seeded |
| warm signal | INSIGHTS | `warm_gc_active` present; score unchanged | §12.3 score-neutral |
| source flip | INSIGHTS | on_demand not scheduled; capture run green | no captures → clean dead-letter |

## Validation Commands
```bash
# INSIGHTS static + unit
pnpm -C "$I" --filter @otn/resolution --filter @otn/intelligence --filter @otn/worker run typecheck
DATABASE_URL="postgres://otn:otn@localhost:5433/otn" pnpm -C "$I" exec vitest run \
  packages/resolution/src/trade-taxonomy.test.ts packages/intelligence/src/scoring.test.ts
# REGISTRY seed (scratch), then loader
supabase db reset && node apps/registry/scripts/entity-resolution/seed-trade-taxonomy.mjs --dry-run \
  && node apps/registry/scripts/entity-resolution/assign-license-trades.mjs --dry-run \
  && node apps/registry/scripts/entity-resolution/report.mjs
```

## Acceptance Criteria
- [ ] Runbook documents the exact login-role/env/loop steps (least-privilege, session-port, skip-safe)
- [ ] `registry_trade_taxonomy` seeded from L&I specialties (drywall/painting/glazing incl.) with keyword dictionaries
- [ ] `registry_trade_assignments` seeded per entity from L&I `license_code` (authoritative primary trades)
- [ ] `registry_public.trades_taxonomy_v1` exposed + granted; Insights reads it and derives its matcher (hardcoded `TRADE_KEYWORDS` removed)
- [ ] trade_export matches permitType **and** description, primary-contractor-attributed, description matches review-gated, skip-safe
- [ ] Loader `assignment_rank` reconciled with the CHECK
- [ ] `warm_gc_active` emitted as a score-neutral Solis signal
- [ ] Three Thurston sources enabled (capture-gated); no PII in the bridge
- [ ] Both repos: typecheck + tests green; committed & pushed

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Loader `assignment_rank='partner'` violates CHECK | High (latent) | First trade assign fails | T.5 fixes to `secondary` (lands with T.1 seed) |
| Description trade-match misattributes to GCs | Medium | Wrong registry trades | Primary-contractor-only, lower confidence, registry review/taxonomy gate |
| L&I specialty strings noisy/duplicative | Medium | Messy taxonomy | Curated synonym→code normalizer, not blind DISTINCT |
| Warm-network empty until orgs bound | High (now) | Signal dormant | Depends on RB/registry connection; code ships skip-safe |
| Sources flipped without captures | Medium | Dead-letters | Gate `enabled` on capture availability; on_demand anyway |
| Contract drift (new taxonomy view) | Low | Stale/mis-typed | Version `_v1`; Insights tolerant + skip-safe |

## Notes
- **The key architectural shift:** the registry trade **taxonomy is the single source of truth** for trades + keywords, seeded from authoritative **L&I license specialties** already in the trades DB. The registry assigns each entity its real trades directly (`license_code`); Insights **reads the same vocabulary** to match permit text (corroboration + scoring) — the two systems can never drift, and adding an L&I specialty automatically teaches Insights a new trade.
- **Why the finish trades were missing:** the old `trade_export` matched `permitType` only (clean for sub-permit trades like mechanical), but drywall/painting/glazing are subcontracted scope under a GC's building permit — not permit types. T.1-T.4 fix this by (a) sourcing trades from L&I directly and (b) letting Insights match the shared keyword dictionary over descriptions where the pilot account is the named contractor.
- **Recommended order:** RB (unblocks everything) → T.1/T.2/T.5 (registry seed + loader fix) → T.3/T.4 (contract + Insights matcher) → WS-W → WS-S. T.5 MUST ship with T.1 (seeding activates the latent CHECK bug).
- Large session context: consider `/compact` before implementing this plan so it runs with fresh context.
