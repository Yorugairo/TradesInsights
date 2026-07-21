# Plan: OTN Trades Cockpit + Insights DB Co-location

## Summary
Give trades customers (first: Solis Interiors) a login-gated cockpit on One Trade Network — the GoBJJ pattern applied to the trades vertical — where they manage their profile and see their Insights (opportunities, digest status, pursuits, GC intel) in one place. The data plane is the owner-selected **Part E co-location**: the Insights Postgres moves into the hosted trades Supabase project (`arbmeioglflvzoffgtii`) as a dedicated `insights` schema, and the registry cockpit reads new least-privilege `insights_public` contract views — the mirror image of the proven `registry_public` seam. The Insights worker keeps running operator-local against the hosted DB; the Insights web app stays a local admin/ops surface and is never publicly hosted.

## User Story
As a trades contractor (Solis Interiors), I want to log into One Trade Network and see my construction-opportunity insights next to my business profile, so that I manage my presence and my pipeline in one product instead of receiving only emails.

## Problem → Solution
Insights runs entirely on the owner's machine (local Docker Postgres, `localhost:3000`, shared-passphrase pilot auth) — no customer-reachable surface exists. The registry IS deployed for trades but has no cockpit for trades tenants (the `/dashboard` cockpit is BJJ-worded, and the tenant↔insights link doesn't exist). → One hosted Postgres carries both products in disjoint schemas; the registry's existing deployed Next.js app grows a verticalized dark cockpit with an `insights` module; Solis is onboarded by admin-invite.

## Metadata
- **Complexity**: XL (split into 7 workstreams; each independently shippable)
- **Source PRD**: N/A (owner decisions captured 2026-07-21, recorded below)
- **Estimated Files**: ~40 across two repos (Insights ~15, Registry ~25)

## Decisions of record (owner, 2026-07-21)
1. **Data plane = co-locate the Insights DB into the trades Supabase project** (integration doc Part E). No public Insights web hosting; cockpit reads `insights_public` views.
2. **Cockpit v1 scope = Insights module + profile basics.** Website-settings editing (Lacey-Glass keys) is a fast-follow module, not v1.
3. **Onboarding = admin-invite only for v1** (proven `auth.admin.createUser` pattern; public trades claim stays OTN-9, out of scope).

## Repos & trunks (governance)
- **Insights**: `C:\Users\Snipe\Downloads\TradesInsights`, branch `claude/tmux-install-320aiz`. Commit → push immediately.
- **Registry**: worktree `.claude/worktrees/trades-google-place-integration-v2`, branch `release/trades-staging` (HEAD `82eef3d9` at exploration time). Never target `main`. Every registry migration gets a byte-equivalent `db/baseline-v1.2/NN_*.sql` mirror + census README row.
- Live trades DB: Supabase `arbmeioglflvzoffgtii` (PG17, us-west-2). Registry is production data: additive DDL only; `_v1` contract discipline; no secrets in either repo.

---

## Architecture (target state)

```
┌────────────────────────────  Supabase arbmeioglflvzoffgtii (PG17)  ───────────────────────────┐
│  registry schemas (supabase_migrations ledger)      insights schemas (drizzle ledger)          │
│  ├─ public            (tenants, tenant_modules,     ├─ insights          (46+1 tables moved     │
│  │   profiles, + NEW tenant_insights_accounts)      │    from local public; worker writes)      │
│  ├─ registry_internal (entities, ER core)           ├─ insights_public   (NEW cockpit contract  │
│  ├─ registry_public   (trades_identity_v1 …)        │    views, read-only, account-keyed)       │
│  ├─ registry_partner  (inbound staging)             ├─ pgboss            (pg-boss self-managed) │
│  └─ extensions        (postgis — pre-enabled)       └─ drizzle           (__drizzle_migrations) │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
        ▲ direct pg pool (lib/db.ts)                        ▲ session pooler :5432 (NEVER :6543)
┌───────┴────────────────────────┐                 ┌────────┴──────────────────────────────┐
│ Registry Next.js (deployed)    │                 │ Insights worker + web (OWNER-LOCAL)    │
│ /dashboard  → trades cockpit   │                 │ pnpm worker · extract/verify/brief     │
│   (dark, module-gated,         │                 │ digest:run · admin review UI           │
│    insights module reads       │                 │ REGISTRY_DATABASE_URL seam unchanged   │
│    insights_public views)      │                 │ (now intra-DB, still role-separated)   │
└────────────────────────────────┘                 └────────────────────────────────────────┘
```

Two migration systems share one database with **disjoint schemas**: registry = `supabase_migrations`; Insights = drizzle journal (`drizzle.__drizzle_migrations`) + pg-boss self-migrating `pgboss`. Neither touches the other's schemas — that separation is a hard rule, documented in the runbook (Task 17).

## UX Design

### Before
```
Solis: receives nothing yet (digest machinery ready, email-only path).
Owner: runs Insights web on localhost; registry has no trades cockpit.
```

### After (v1)
```
onetradenetwork.com ──/login──▶ dark cockpit /dashboard
  ├─ Overview: profile completeness + insights headline
  ├─ Insights (module-gated)
  │    ├─ Opportunities: bands (Priority / Digest / Easy-win), score,
  │    │    county/stage/valuation, verified-GC name+phone (✓ badge)
  │    ├─ Digest status: last delivery, item counts, withheld counts
  │    ├─ Pursuits: board summary
  │    └─ GC league: top GCs in territory
  └─ Profile: license facts (read-only, L&I authoritative)
       + editable about/hours/contact (tenants.settings)
Insights admin web stays owner-local (review queues, sources).
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Solis access | none | OTN login → cockpit | admin-invited, no email dependency |
| Insights data | owner's laptop only | hosted DB, views | worker still operator-local |
| Digest email | ready, unsent | unchanged + cockpit mirror | email remains primary delivery |
| Registry seam | cross-DB | same DB, same roles/envs | zero code change to seam |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | Insights `docs/integration-one-trade-network.md` | 344-370 (Part E), 372-460 (Part F) | The co-location contract this plan implements; Part F is the long-run trajectory (do not build now) |
| P0 | Insights `packages/db/src/client.ts` | 5-25 | `createPool` (no ssl opt, max 10), `createRegistryPool` skip-safe — the search_path contract lands here |
| P0 | Insights `packages/db/src/schema.ts` | all (46 pgTables) | Every table is unqualified/public today; schema move touches this file's ownership assumptions |
| P0 | Registry `apps/registry/src/app/dashboard/layout.tsx` | 12-31, 39 | THE cockpit auth + dark-layout pattern to mirror (Pattern A) |
| P0 | Registry `apps/registry/src/middleware.ts` | 53, 75-96, 110, 128-173 | AUTH_REQUIRED prefixes; **hardcoded `gobjj.app` appHost** that would hijack `/dashboard` on trades prod (Task 10) |
| P0 | Registry `packages/shared-routes/modules.ts` | 10-39 | ModuleKey union + `hasModule` — `insights` key is added here |
| P0 | Registry migration `20260616060000_tenant_modules.sql` | all | tenant_modules shape + RLS member-read pattern to mirror for the mapping table |
| P1 | Insights `apps/worker/src/schedules.ts` | 98-106, 108-198, 277-351 | operator-local sources, nightly chain (registry seam at 128-143), pg-boss queues/crons |
| P1 | Insights `apps/web/lib/auth.ts` + `lib/api.ts` | all | Pilot auth stays as-is (admin/ops local); do NOT expose it publicly |
| P1 | Insights `packages/delivery/src/digest.ts` | 228-249, 774-786 | candidate cap (≤500/account) + gate suppression counts → mirrored in `cockpit_digest_status_v1` |
| P1 | Registry `apps/registry/src/lib/moduleAccess.ts` | 4-11 | `getActiveModules`/`tenantHasModule` server readers (reuse, don't rebuild) |
| P1 | Registry `apps/registry/src/app/dashboard/waivers/page.tsx` | 31-35 | Module-gate-with-upsell page pattern (Pattern C) |
| P1 | Registry `scripts/claim-handoff-staging-qa.mjs` | 371-377 | `auth.admin.createUser({email_confirm:true})` invite pattern (Task 16) |
| P1 | Registry `packages/shared-routes/claim-context.ts` | 98-118, 209-252 | owner-link transaction (owner_id + profiles + memberships + app_metadata) to mirror in the invite script |
| P2 | Registry `apps/registry/src/lib/public-pages/tradesWebsiteData.ts` | 257-341 | settings read-with-validation (Pattern F) for the profile page |
| P2 | Registry `db/baseline-v1.2/README.md` + `26_*.sql` | all | census discipline + byte-equivalence rule for the new mapping migration |
| P2 | Insights `docs/runbooks/registry-seam-golive.md` | Part B | seam roles/envs that must remain untouched by co-location |
| P2 | Registry `scripts/pseo-quality-gate.mjs` + `tests/security-regression-static.test.ts` | pins | gates new cockpit routes must not break; add pins here |

## External Documentation
| Topic | Source | Key Takeaway |
|---|---|---|
| Supabase pooler modes | supabase docs (verified in seam runbook Part B3) | pg-boss requires session mode `:5432`; transaction pooler `:6543` breaks it |
| pg-boss 10.4.2 internals | `node_modules/pg-boss/src/plans.js:1,516,970` (verified by audit) | own `pgboss` schema, 2s polling + `FOR UPDATE SKIP LOCKED`, advisory locks in maintenance. **No LISTEN/NOTIFY** — integration doc line 352 is wrong about the mechanism (right about the pooler conclusion); fix the doc (Task 17) |
| Supabase Storage S3 compat | supabase docs | S3-compatible endpoint + access keys; `forcePathStyle: true` (already set, `object-store.ts:63-71`) works |
| PostGIS on Supabase | supabase dashboard | extension installs into `extensions` schema → search_path must include `extensions`; pre-enable so migration `0000_init.sql:1` `CREATE EXTENSION IF NOT EXISTS postgis` no-ops |

---

## Patterns to Mirror

### A. COCKPIT_AUTH_AND_DARK_LAYOUT
```ts
// SOURCE: apps/registry/src/app/dashboard/layout.tsx:12-31,39
const supabase = await createClient();
const { data: { user } } = await supabase.auth.getUser();
if (!user) { redirect('/login'); }
const profileRes = await query('SELECT tenant_id, role FROM profiles WHERE id = $1 LIMIT 1', [user.id]);
if (profileRes.rows.length === 0 || !profileRes.rows[0].tenant_id) { redirect('/claim'); }
// … role check …
<div style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg-primary)' }}>
// dark by default: :root IS dark (globals.css:1-33); never apply .register-light in the cockpit
```

### B. OWNER_RESOURCE_CHECK + ERROR_ENVELOPE
```ts
// SOURCE: apps/registry/src/app/dashboard/leads/actions.ts:16-26
const tenantRes = await query('SELECT id FROM tenants WHERE owner_id = $1 LIMIT 1', [user.id]);
if (tenantRes.rows.length === 0) { return { error: 'No tenant found for user' }; }
const tenantId = tenantRes.rows[0].id;
// then: resource WHERE id = $1 AND tenant_id = $2 → { error } | { success: true }
```

### C. MODULE_GATE_WITH_UPSELL
```ts
// SOURCE: apps/registry/src/app/dashboard/waivers/page.tsx:31-35
const modulesRes = await query("SELECT module FROM tenant_modules WHERE tenant_id = $1 AND status = 'active'", [tenantId]);
const modules = modulesRes.rows.map((r: { module: string }) => r.module);
if (!hasModule(modules, "waivers")) { return ( /* upsell panel */ ); }
```

### D. SETTINGS_WRITE (jsonb_set + role check)
```ts
// SOURCE: apps/crm/src/app/dashboard/settings/actions.ts (saveContentVoiceAction)
await query(`UPDATE tenants SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{content_voice}', $2::jsonb) WHERE id = $1`,
  [tenantId, JSON.stringify(voice)]);
revalidatePath('/dashboard/settings');
```

### E. VERTICAL_GATE
```ts
// SOURCE: apps/registry/src/app/sites/[slug]/page.tsx:19 · contractor/[slug]/page.tsx:22
const IS_TRADES_VERTICAL = SITE_CONFIG.verticalKey !== "bjj";
const OWNS_CONTRACTOR_PROFILES = SITE_CONFIG.routes.businessProfilePrefix === "/contractor";
if (!OWNS_CONTRACTOR_PROFILES) notFound();
```

### F. SETTINGS_READ_WITH_BOUNDARY_VALIDATION
```ts
// SOURCE: apps/registry/src/lib/public-pages/tradesWebsiteData.ts:322-341
heroImage: asImageUrl(settings.hero_image),
schedulingUrl: asHttpUrl(settings.scheduling_url),
isPromoPreview: settings.promo_preview === true,
```

### G. CONTRACT_VIEW + LEAST-PRIVILEGE ROLE (the seam pattern, reversed)
```sql
-- SOURCE: registry db/baseline-v1.2/26_registry_public_trades_identity_v1_enrichment.sql (shape)
CREATE SCHEMA IF NOT EXISTS insights_public;
CREATE OR REPLACE VIEW insights_public.cockpit_opportunities_v1 WITH (security_invoker = false) AS
  SELECT a.key AS account_key, o.id AS opportunity_id, /* … */ FROM insights.opportunities o
  JOIN insights.account_profiles a ON a.id = o.account_profile_id /* … */;
-- NOLOGIN reader role + explicit GRANTs; consumers never touch insights.* base tables
```

### H. RLS_MEMBER_READ (for the mapping table)
```sql
-- SOURCE: apps/registry/supabase/migrations/20260616060000_tenant_modules.sql:24-26
CREATE POLICY tenant_modules_member_read ON public.tenant_modules FOR SELECT
  USING (tenant_id::text = (auth.jwt()->'app_metadata'->>'tenant_id'));
```

---

## Files to Change

### Insights repo (`claude/tmux-install-320aiz`)
| File | Action | Justification |
|---|---|---|
| `scripts/migrate-to-insights-schema.sql` | CREATE | `ALTER TABLE … SET SCHEMA insights` for all 47 tables (46 drizzle + `stage_lag_stats`); local rehearsal + hosted no-op guard |
| `packages/db/src/client.ts` | UPDATE | search_path contract note; pool unchanged (contract rides the URL) |
| `.env.example` | UPDATE | document hosted `DATABASE_URL` shape incl. `options=-csearch_path%3Dinsights%2Cpublic%2Cextensions` + session-pooler warning |
| `vitest.config.ts`, `packages/db/drizzle.config.ts` | UPDATE | schema-aware default URLs for local runs post-move |
| `packages/db/migrations/0025_insights_public_views.sql` (+ journal) | CREATE | `insights_public` schema + 5 cockpit views + `insights_cockpit_reader` NOLOGIN role + grants |
| `apps/worker/test/cockpit-views.test.ts` | CREATE | PII/scoping tests against the views |
| `docs/runbooks/registry-seam-golive.md` | UPDATE | new Part C: co-located operations (two ledgers/one DB, connection budget, rollback) |
| `docs/operations.md`, `docs/STATUS.md`, `docs/integration-one-trade-network.md` | UPDATE | brief:run alias nit; pg-boss LISTEN/NOTIFY correction; status |

### Registry repo (`release/trades-staging`)
| File | Action | Justification |
|---|---|---|
| `packages/shared-routes/site-config/index.ts` + `bjj.ts` + `onetradenetwork.ts` | UPDATE | add `appHost` (bjj: `gobjj.app`; trades: null=same-host) + insights module catalog copy |
| `apps/registry/src/middleware.ts` | UPDATE | GUI-handoff host from SITE_CONFIG (kills the `gobjj.app` hijack of trades `/dashboard`) |
| `packages/shared-routes/modules.ts` | UPDATE | `'insights'` in ModuleKey |
| `apps/registry/supabase/migrations/2026…_tenant_insights_accounts.sql` | CREATE | tenant↔account_key↔entity mapping, RLS member-read (Pattern H) |
| `db/baseline-v1.2/27_tenant_insights_accounts.sql` + `README.md` | CREATE/UPDATE | byte-equivalent mirror + census row |
| `apps/registry/src/app/dashboard/layout.tsx` (+ sidebar component if split) | UPDATE | verticalize copy/links via SITE_CONFIG; noindex metadata; trades hides BJJ-only items |
| `apps/registry/src/app/dashboard/insights/page.tsx` (+ `opportunities/page.tsx`, components) | CREATE | the module (Patterns A+C; reads `insights_public.*` via `lib/db.ts query()`) |
| `apps/registry/src/lib/insightsCockpit.ts` | CREATE | typed readers over the views + tenant→account_key resolution |
| `apps/registry/src/app/dashboard/profile/…` (trades variant) | UPDATE | license facts read-only + about/hours/contact editing (Patterns D+F) |
| `scripts/invite-trades-owner.mjs` | CREATE | admin-invite onboarding (Task 16) |
| `tests/security-regression-static.test.ts`, `scripts/pseo-quality-gate.mjs` | UPDATE | pins for new surfaces |

## NOT Building
- Public trades claim flow (**OTN-9** — explicitly deferred; admin-invite only).
- Website-settings editor module (fast-follow; `website` ModuleKey already exists).
- Public hosting of the Insights web app, SSO into it, or any change to its pilot passphrase auth (it stays owner-local admin/ops).
- In-cockpit LLM generation buttons (brief/outreach). V1 is read-only over stored results; a `insights_partner.requests` queue is the designed follow-up, not built now.
- Per-table RLS inside the `insights` schema (v1 posture: schema unexposed to PostgREST + zero grants to `anon`/`authenticated`, verified by Task 7; full RLS recorded as follow-up per Part E:359-362).
- pgmq convergence / retiring pg-boss; moving the worker off the owner's machine; pg_cron migration.
- Billing/plans for trades cockpit; PWA manifest; Part F re-home of Insights web into `apps/crm`.
- Any change to scoring (§12.3 stays frozen), sources, or the registry seam roles/envs.

---

## Step-by-Step Tasks

### WS-0 — Owner prerequisites (no code)
#### Task 1: Prepare the Supabase project
- **ACTION**: Owner (in dashboard/SQL editor): enable `postgis` extension; confirm compute tier + `max_connections` headroom; create Storage bucket `otn-artifacts` + S3 access keys; confirm PITR/backup current.
- **GOTCHA**: PostGIS installs into `extensions` schema on Supabase — that's why the search_path contract includes it. Never guess-set credentials; owner enters all values.
- **VALIDATE**: `SELECT extname, extnamespace::regnamespace FROM pg_extension WHERE extname='postgis';` → `extensions`.

### WS-1 — Insights schema qualification (local rehearsal first)
#### Task 2: Schema-move script
- **ACTION**: Write `scripts/migrate-to-insights-schema.sql`: `CREATE SCHEMA IF NOT EXISTS insights;` then `ALTER TABLE public.<t> SET SCHEMA insights;` for all 47 tables (46 from `packages/db/src/schema.ts` + `stage_lag_stats` from `0018_stage_lag_stats.sql:5-17`). Guard each with to_regclass checks so re-runs no-op.
- **IMPLEMENT**: Generate the table list from schema.ts mechanically (do not hand-type 47 names); sequences/indexes/PKs follow their tables automatically.
- **GOTCHA**: `pgboss`/`drizzle` schemas are NOT touched. Views none exist locally yet. The drizzle journal keeps recording — this script is environment surgery, not a numbered migration.
- **VALIDATE**: run against local Docker; `SELECT count(*) FROM information_schema.tables WHERE table_schema='insights';` → 47; `…table_schema='public'` → 0 Insights tables.

#### Task 3: search_path connection contract
- **ACTION**: Adopt URL-embedded search_path: local `.env` `DATABASE_URL=postgres://otn:otn@localhost:5432/otn?options=-csearch_path%3Dinsights%2Cpublic%2Cextensions`. Update `.env.example` (documented hosted + local shapes), `vitest.config.ts:28-38`, `packages/db/drizzle.config.ts:8` defaults.
- **MIRROR**: skip-safe env philosophy of `createRegistryPool` (client.ts:12-25) — nothing crashes on the old URL; unqualified lookups simply miss and tests fail loudly.
- **GOTCHA**: URL form covers every consumer at once (web pool, worker pool, worker pg-boss `createBoss` jobs.ts:32, web ad-hoc PgBoss run/route.ts:16, drizzle migrator, vitest). pg-boss qualifies its own `pgboss.` names, so the search_path is harmless to it. Windows shells: keep the encoded form in `.env`, never export unencoded.
- **VALIDATE**: `pnpm typecheck` (11/11) then full `pnpm test` green against the moved local DB — this is the rehearsal gate; the 650-test suite passing under `insights` schema is the proof the raw-SQL layer needs no per-string qualification.

#### Task 4: Fix stragglers the suite exposes
- **ACTION**: Any test/tool that hardcodes `public.` or bypasses DATABASE_URL gets fixed to honor the contract (expected: near-zero, since queries are unqualified by construction).
- **VALIDATE**: full suite + `pnpm --filter @otn/web build`.

### WS-2 — Hosted provision + cutover
#### Task 5: Fresh provision into the trades project
- **ACTION**: With owner-set hosted `DATABASE_URL` (session pooler `:5432`, search_path options), run the drizzle migrator (`packages/db/src/migrate.ts`) → creates all tables **in `insights`** (first schema in search_path), journal in `drizzle`, pgboss self-creates on first worker boot.
- **GOTCHA**: `0000_init.sql:1` `CREATE EXTENSION IF NOT EXISTS postgis` no-ops because Task 1 pre-enabled it. NEVER the transaction pooler `:6543`. The registry's `supabase_migrations` ledger is untouched — do not record Insights DDL there.
- **VALIDATE**: table census = 47 in `insights`; `\d insights.projects` shows `geometry(Geometry,4326)` resolved via `extensions`.

#### Task 6: Data + artifact migration
- **ACTION**: `pg_dump --schema=insights --data-only` from local (post-Task 2) → `psql` restore into hosted. Sync MinIO bucket → Supabase Storage (owner runs; S3-compat, keys from Task 1). Write `scripts/verify-migration-parity.mjs`: per-table row counts local vs hosted + spot-check checksums (opportunities, model_runs, source_records, raw_artifacts).
- **GOTCHA**: Dump AFTER the local schema move so `COPY insights.…` statements target the right schema verbatim — no sed rewriting of dumps, ever.
- **VALIDATE**: parity script all-green; total raw_artifacts bytes match bucket object count/size.

#### Task 7: Cutover + security posture check
- **ACTION**: Flip local `.env` DATABASE_URL to hosted; `OBJECT_STORAGE_*` to Supabase Storage; keep `REGISTRY_DATABASE_URL` exactly as-is (seam is now intra-DB but stays role-separated — zero code change). Run the nightly chain once by hand; run `eval:run`.
- **IMPLEMENT**: posture audit queries (into the runbook): `insights`/`insights_public` NOT in PostgREST exposed schemas; `SELECT * FROM information_schema.role_table_grants WHERE table_schema IN ('insights','insights_public') AND grantee IN ('anon','authenticated');` → 0 rows.
- **GOTCHA**: Keep the Docker Postgres intact untouched as instant rollback (repoint URL back). Watch `pg_stat_activity` during a worker session — ~20 pg-boss queues poll every 2s; if connection pressure appears, lower pool `max` via env and/or reduce enabled-source queue count before scaling tiers.
- **VALIDATE**: nightly chain green incl. seam steps (schedules.ts:128-143); eval gates PASS unchanged (priorityPrecision 1.0 / recall ≥0.96); digest render matches pre-migration rehearsal output.

### WS-3 — insights_public contract views (Insights repo, migration 0025)
#### Task 8: Views + reader role
- **ACTION**: `0025_insights_public_views.sql`: create schema `insights_public`; NOLOGIN role `insights_cockpit_reader`; five views (all `WITH (security_invoker = false)`, all keyed by `account_key`, all explicitly qualified `insights.*`):
  1. `cockpit_account_v1` — account meta: key, name, thresholds (from delivery_config_json), opportunity counts by state, last_scored_at.
  2. `cockpit_opportunities_v1` — opportunity_id, project name/county/jurisdiction/stage, valuation, score, state/band, easy-win flag, bid-window note fields, **GC business name + phone + verified flag only** (GC-role orgs, never individual-flagged orgs, never homeowner names), updated_at.
  3. `cockpit_digest_status_v1` — latest delivery per account + item counts + `suppressed` counts (mirror digest.ts:774-786 semantics: withheld is DISCLOSED, never hidden).
  4. `cockpit_pursuits_v1` — pursuit id/state/opportunity link/updated_at (board summary).
  5. `cockpit_gc_league_v1` — org league rollup (business orgs only).
- **MIRROR**: Pattern G (the registry seam view shape); selection predicates from `apps/web/lib/queries.ts` `listOpportunities`/league (reuse the same WHERE logic, don't invent).
- **GOTCHA (PII hard rules)**: exclude any row sourced from account-private sources (`sources.account_profile_id IS NOT NULL` — bid-invitation data NEVER enters views; its §20 access-audit requirement can't be met by a view); exclude orgs flagged individual / `address_in_name`; homeowner names never appear. County + jurisdiction stay present on every row.
- **VALIDATE**: migration applies on local; `GRANT` census: reader role has SELECT on exactly the 5 views, zero grants on `insights.*` base tables.

#### Task 9: View tests
- **ACTION**: `apps/worker/test/cockpit-views.test.ts` — seed a private-source record + an individual-flagged org + a cross-account opportunity; assert none surface in the views for `solis_interiors`; assert GC verified phone surfaces when registry-linked.
- **MIRROR**: AAA style of `apps/worker/test/digest.test.ts` (db-backed, per-test fixtures).
- **VALIDATE**: `pnpm --filter @otn/worker test cockpit-views` green; full suite green.

### WS-4 — Registry cockpit (trades vertical)
#### Task 10: De-hardcode the app-host handoff
- **ACTION**: Add `appHost: string | null` to site-config (bjj.ts: `'gobjj.app'`; onetradenetwork.ts: `null` = cockpit stays same-host). `middleware.ts:110,128-173` reads it; `null` disables the public-host→app-host redirect entirely for trades.
- **GOTCHA**: This is the bug that would otherwise redirect trades `/dashboard` to gobjj.app in prod (agent-verified hardcode at middleware.ts:110). Run `npm run audit:verticalization` — host literals moving into site-config is exactly what it polices.
- **VALIDATE**: `npm run test:security` + audit green; dev with `NEXT_PUBLIC_SITE_KEY=onetradenetwork`: `/dashboard` serves locally, no redirect.

#### Task 11: `insights` module key + catalog copy
- **ACTION**: Add `'insights'` to `ModuleKey` (modules.ts:10-19); catalog label/description in `onetradenetwork.ts` vertical skin ("Opportunity Insights — permits, pre-permit decisions, and GC intel for your trade").
- **GOTCHA**: Vertical copy lives ONLY in site-config/vertical-skin (verticalization contract). BJJ skin omits the module.
- **VALIDATE**: typecheck both apps; `audit:verticalization` green.

#### Task 12: Mapping table migration
- **ACTION**: Registry migration `tenant_insights_accounts (tenant_id uuid PK REFERENCES public.tenants(id), account_key text NOT NULL, entity_id uuid NULL, created_at timestamptz DEFAULT now())`; RLS enable + member-read policy (Pattern H); writes via privileged pool only. Byte-equivalent `db/baseline-v1.2/27_tenant_insights_accounts.sql` + census README row. Seed statement for Solis (owner applies): tenant for UBI 604837560 → `'solis_interiors'`, entity `8a12a7cb…`.
- **MIRROR**: 20260616060000_tenant_modules.sql structure + the WS-0 migration/baseline discipline (26_*.sql).
- **GOTCHA**: Solis has one tenant row PER L&I license (ingest-wa-lni-contractors.mjs:244) — the seed must pick the active-license tenant deterministically (match `settings.ubi` + license reg `SOLISIL785NT`); PK on tenant_id allows only one mapping per tenant, fine.
- **VALIDATE**: migration idempotent-safe; applied to live by owner-run step; `SELECT` via view joins works; baseline diff byte-identical.

#### Task 13: Verticalize the dashboard shell
- **ACTION**: `dashboard/layout.tsx`: sidebar links/copy from SITE_CONFIG (public-profile link uses `routes.businessProfilePrefix` — kills the hardcoded `/brazilian-jiu-jitsu-gym/${slug}` at :44); trades hides "GoBJJ Premium" section + BJJ-only pages; keep Pattern A auth exactly; add `robots: { index:false, follow:false }` metadata (mirror apps/crm dashboard/layout.tsx:3-8); non-owner redirect target vertical-aware (no `/athlete` on trades).
- **GOTCHA**: Do not fork the layout per vertical — one layout, site-config-driven, or `audit:verticalization` and future maintenance both suffer.
- **VALIDATE**: `npm run test:security`; BJJ dev smoke (`NEXT_PUBLIC_SITE_KEY` unset) shows unchanged BJJ sidebar; trades dev shows trades sidebar.

#### Task 14: Insights module pages
- **ACTION**: `dashboard/insights/page.tsx` (overview: account headline, band counts, digest status, top-10 opportunities, GC league top-5) + `dashboard/insights/opportunities/page.tsx` (full list, state/band/county filters, pagination). New `src/lib/insightsCockpit.ts`: `resolveInsightsAccount(userId)` (Pattern B → tenant → `tenant_insights_accounts.account_key`; null ⇒ "not provisioned" panel) + typed view readers (`query()` against `insights_public.*`, every SQL `WHERE account_key = $1`).
- **MIRROR**: Patterns A (layout/auth), C (module gate on `'insights'` with upsell fallback), F (boundary validation of view rows before render).
- **GOTCHA**: Read-only v1 — zero POST routes, so no content-api-guards surface; DO NOT import Insights packages into the registry app (contract views are the only interface). Honest empty state: "Insights syncs nightly — first data appears after tonight's run." Never fabricate.
- **VALIDATE**: trades dev with seeded mapping renders Solis data live from hosted views; BJJ dev: module absent → upsell panel; typecheck + `npm run build`.

#### Task 15: Profile basics (trades variant)
- **ACTION**: `dashboard/profile` for trades: read-only license facts (settings.ubi/license/bond — L&I authoritative, labeled as such), editable `about_us`, `hours`, contact email/display phone via server action (Pattern D jsonb_set, owner-checked Pattern B, sanitized Pattern F).
- **GOTCHA**: L&I phone is NEVER editable here (identity authority); edits touch `tenants.settings` only, never registry_internal. Server action returns the `{ error } | { success: true }` envelope.
- **VALIDATE**: pins added to `tests/security-regression-static.test.ts` (no `UPDATE profiles`, no role writes in cockpit actions); edit round-trips in trades dev.

### WS-5 — Onboarding
#### Task 16: Admin-invite script
- **ACTION**: `scripts/invite-trades-owner.mjs --email <e> --tenant-slug <s> [--apply]`: dry-run by default; on apply: `auth.admin.createUser({email, password: <generated>, email_confirm: true})` (mirror claim-handoff-staging-qa.mjs:371-377), then the claim-context linking transaction (mirror claim-context.ts:209-252): `tenants.owner_id` + `claim_status='approved'`, `profiles` upsert (role owner), `tenant_memberships` (owner/active), `updateUserAppMetadata({tenant_id, role:'owner'})`; grant `tenant_modules` rows `presence`+`insights` (source `'admin_grant'`); upsert `tenant_insights_accounts`. Print the generated password ONCE to the operator; never log/store it.
- **GOTCHA**: Do NOT grant `waivers` (trades placeholder template — seeds/trades.sql:32-46). Idempotent re-runs must not reset an existing owner. Script runs owner-side with service-role env; never commit any credential.
- **VALIDATE**: dry-run output lists exact mutations; staging rehearsal with a throwaway email + `auth.admin.deleteUser` cleanup; then owner runs for Solis when ready.

### WS-6 — Docs, ledger, memory
#### Task 17: Documentation truth pass
- **ACTION**: Seam runbook gains Part C (co-located ops: two migration ledgers/one DB rule, search_path contract, connection budget + `pg_stat_activity` check, posture audit queries, rollback=URL swap); `docs/operations.md` fixes the `brief:run` alias drift (worker-scoped) and documents defaults now 10; `docs/integration-one-trade-network.md:352` LISTEN/NOTIFY correction (pg-boss 10 = polling + advisory locks); registry `db/baseline-v1.2/README.md` status note: foreign `insights*`/`pgboss`/`drizzle` schemas present in the live DB, owned by the Insights drizzle ledger, excluded from registry census; `docs/STATUS.md` entry.
- **VALIDATE**: registry `npm run audit:pseo-quality` + Insights doc-audit scripts (if wired) green; both repos committed + pushed.

---

## Testing Strategy

### Unit / integration
| Test | Input | Expected | Edge case? |
|---|---|---|---|
| views: cross-account isolation | opportunity for account B | absent from account A rows | ✔ |
| views: private-source exclusion | bid-invitation-derived record | never surfaces | ✔ PII |
| views: individual-org exclusion | org flagged individual | GC fields null/absent | ✔ PII |
| views: verified GC surfaces | registry-linked GC w/ phone | name+phone+verified=true | |
| cockpit: module gate | tenant w/o insights module | upsell panel, no data fetch | ✔ |
| cockpit: unmapped tenant | no tenant_insights_accounts row | "not provisioned" panel | ✔ |
| invite script: idempotency | re-run on linked owner | no-op report, no resets | ✔ |
| schema move: rerun | script twice on local | second run no-ops | ✔ |
| parity: migration | local vs hosted counts | all tables equal | |

### Edge Cases Checklist
- [ ] Empty insights account (0 opportunities) → honest empty states everywhere
- [ ] Hosted DB unreachable from registry → cockpit error panel, never a crash/hang (bounded query timeout)
- [ ] search_path missing from a connection → tests fail loudly (rehearsal gate), documented symptom in runbook
- [ ] BJJ deploy untouched: no trades module/copy leaks (site-key smoke both ways)
- [ ] Digest withheld counts render (disclosure, not hiding)

## Validation Commands

### Insights
```bash
pnpm typecheck            # 11/11
pnpm test                 # full suite green (post-move rehearsal gate + views tests)
pnpm eval:run             # gates PASS unchanged — §12.3 frozen
node scripts/verify-migration-parity.mjs   # cutover only
```

### Registry
```bash
npm run test:security          # static pins incl. new cockpit pins
npm run audit:pseo-quality     # noindex/gate pins
npm run audit:verticalization  # no vertical copy outside site-config
npm run build                  # both site keys build
```

## Acceptance Criteria
- [ ] Full Insights suite green with all tables in the `insights` schema (local rehearsal), then against hosted
- [ ] Hosted cutover: nightly chain + seam + eval gates + digest parity all green; posture audit (no anon/authenticated grants; schema unexposed) passes
- [ ] Solis logs into OTN `/dashboard` (trades site key) and sees live opportunities/digest-status/pursuits/GC league from `insights_public` views
- [ ] Profile basics editable; L&I facts read-only
- [ ] BJJ surfaces byte-for-byte unaffected (site-key smoke)
- [ ] All registry DDL mirrored in baseline + census; both trunks pushed

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Raw-SQL breakage under schema move | Medium | High | search_path contract + full-suite local rehearsal BEFORE any hosted step; Docker rollback preserved |
| pg-boss connection pressure on hosted tier | Medium | Medium | session pooler, measure `pg_stat_activity`, tune pool max/env, stagger already exists; pgmq listed as escape hatch |
| PostGIS/extension resolution | Low | High | pre-enable (Task 1) + `extensions` in search_path; validated by `\d` geometry check |
| Data-migration integrity | Low | High | dump-after-move (no sed), parity script, checksums, fallback DB kept |
| Homeowner PII in cockpit views | Low | Critical | explicit exclusions + dedicated tests (Task 9); business-entities-only rule carried from seam governance |
| Middleware host hijack on trades prod | Certain if unfixed | High | Task 10 is a hard prerequisite for exposing the cockpit |
| BJJ regression via shared dashboard | Medium | Medium | one layout + site-config switches + both-site-key smoke + security pins |

## Notes
- Sequencing: Tasks 1→7 (data plane) are the critical path; Tasks 10-15 (cockpit) can be BUILT in parallel against local views but only VERIFIED end-to-end after cutover; Task 16 last.
- This is deliberately the incremental step toward integration-doc **Part F** (Insights UI re-homed into the CRM chassis) without committing to it: the contract-view interface means the cockpit never imports Insights code, so Part F remains a pure re-platforming decision later.
- The Insights pilot web app keeps working unchanged at every step (it reads the same DB through the same drizzle layer) — owner review queues (`/app/admin/registry-review`, `/app/admin/review`) stay the human-gate surfaces.
- LLM spend model is untouched: cockpit v1 reads stored results only; generation stays owner-triggered CLIs + Insights-web buttons, budget-gated ($0.50/job default, monthly cap required).
