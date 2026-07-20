# Runbook — take the registry ⇄ Insights seam live

**Audience:** operator / owner with credentials to the Trades registry database.
**Goal:** turn on the already-built, currently-dark seam between OTN Insights and
the Trades registry (`release/trades-staging`) so registry identity + the shared
trade vocabulary reach Solis scoring, and reviewed Insights observations flow back
into `registry_partner` staging.

Everything below is **skip-safe**: with no `REGISTRY_DATABASE_URL` the Insights
pipeline runs exactly as today (registry steps report a visible `skipped` state,
never a crash). Nothing here binds an entity automatically — bindings stay human /
strong-key, and the registry loader is the registry-side gate.

> Do **not** commit any connection string, password, or service key. All secrets
> live in the deploy environment only. Never target `origin/main`; the trades
> trunk is `release/trades-staging` (github.com/Yorugairo/BJJRegistry).

---

## Prerequisites (already on trunk)

Merged to `release/trades-staging` (`6b72c81`) — verify with the migration ledger:

- `registry_public.trades_identity_v1` + role `otn_insights_reader` (NOLOGIN)
  — migration `20260719091458_registry_public_trades_identity_v1` / baseline
  `23_registry_public_contract.sql`.
- `registry_partner` inbound staging (`partner_observations`, `partner_project_facts`)
  + role `otn_insights_writer` (NOLOGIN) — ledgers `20260719095534` / `...095646` /
  `...100034` / baseline `24_registry_partner_inbound.sql`.
- Loader `apps/registry/scripts/entity-resolution/ingest-otn-insights.mjs`.

`otn_insights_reader` / `otn_insights_writer` are **NOLOGIN grant-holders** — they
carry the least-privilege grants but cannot log in. Step 1 provisions a login role
that inherits both.

---

## Step 1 — Provision the login role (registry DBA, one time)

Run as a registry superuser / migration owner against the Trades DB:

```sql
-- A single login principal for Insights that inherits BOTH grant-holders.
CREATE ROLE otn_insights LOGIN PASSWORD '<generated-secret>';
GRANT otn_insights_reader TO otn_insights;   -- SELECT on registry_public.*
GRANT otn_insights_writer TO otn_insights;   -- INSERT into registry_partner staging
```

Least-privilege check — this role must **not** hold any grant on `registry_internal`
(the loader runs as the migration/service owner, not as this login role):

```sql
-- Expect: reader works, internal denied, writer works.
SET ROLE otn_insights;
SELECT count(*) FROM registry_public.trades_identity_v1;                 -- OK
SELECT count(*) FROM registry_public.trades_taxonomy_v1;                 -- OK once T.3 shipped
SELECT count(*) FROM registry_internal.registry_business_entities;      -- ERROR: permission denied
-- Writer grant: a throwaway INSERT into registry_partner.partner_observations
-- (columns per db/baseline-v1.2/24_registry_partner_inbound.sql) succeeds, then
-- ROLLBACK. The Insights writer (exportRegistryObservations) is the real caller.
RESET ROLE;
```

Rotate the password if it is ever exposed; revoke with `DROP ROLE otn_insights;`.

---

## Step 2 — Seed the shared trade vocabulary (registry, before trade evidence)

Trade evidence stays inert until the taxonomy is seeded (the loader skips unknown
codes with `skipped:unknown_trade_code`, and Insights falls back to its built-in
permitType-only vocabulary). Seed it from authoritative L&I license specialties:

```bash
# In the registry repo (release/trades-staging), against the Trades DB:
DATABASE_URL=postgres://…:5432/… node apps/registry/scripts/entity-resolution/seed-trade-taxonomy.mjs --dry-run   # inspect
DATABASE_URL=…                        node apps/registry/scripts/entity-resolution/seed-trade-taxonomy.mjs           # upsert taxonomy
DATABASE_URL=…                        node apps/registry/scripts/entity-resolution/assign-license-trades.mjs         # per-entity trades from L&I
DATABASE_URL=…                        node apps/registry/scripts/entity-resolution/report.mjs                        # observability
```

Then publish the contract view `registry_public.trades_taxonomy_v1` (T.3 migration)
and confirm `otn_insights_reader` can `SELECT trade_code, keywords FROM
registry_public.trades_taxonomy_v1`. Insights auto-derives its matcher from it on
the next run; no Insights redeploy needed.

---

## Step 3 — Point Insights at the registry (deploy env)

Set in the Insights deploy environment (never in the repo):

```
REGISTRY_DATABASE_URL=postgres://otn_insights:<secret>@<host>:5432/<db>
```

**GOTCHA — session port 5432, not the transaction pooler 6543.** pg-boss (the
Insights job runner) breaks on Supabase's transaction pooler; use the **session**
connection. `createRegistryPool()` returns `null` when the var is unset ⇒ the seam
stays dark and the pipeline still runs.

---

## Step 4 — Run the loop

Insights nightly (already wired in `apps/worker/src/schedules.ts`), in order:

1. `resolve:run` → `linkRegistry` (bind Insights orgs to registry entities by
   strong identifier — human/strong-key only), then `generateRegistryObservations`
   (binding candidates, phone adoption, alias/trade export — the trade matcher now
   derives from `trades_taxonomy_v1`), then `exportRegistryObservations` (push
   **accepted** observations + public project facts to `registry_partner`).
2. Registry-side adjudication — pull the staged observations into `registry_internal`:
   ```bash
   DATABASE_URL=…:5432/… node apps/registry/scripts/entity-resolution/ingest-otn-insights.mjs [--dry-run] [--limit=N]
   ```
   The loader validates every row, applies or skips it, stamps `applied_at` +
   `applied_action`, and **never** mints/merges/touches L&I identity. Trade
   evidence writes `registry_trade_assignments` at rank `secondary` (corroborating
   the authoritative `license_code` primary).

---

## Verification

- `linkRegistry` summary: `skipped:false`, `bound > 0` after the first run.
- Solis scoring rationale shows `verified_gc_on_project` / `warm_gc_active` signals
  once orgs are bound (both score-neutral under §12.3 until Solis calibration).
- `SELECT applied_action, count(*) FROM registry_partner.partner_observations
  WHERE source_system='otn_insights' GROUP BY 1;` — reviewed observations land and
  are adjudicated; no unexpected `skipped:*` classes.
- No homeowner PII crosses the seam (the person-vs-business gate keeps
  `organizations[]` empty for home-metro capture sources).

## Rollback

Unset `REGISTRY_DATABASE_URL` (seam goes dark, pipeline unaffected) and/or
`DROP ROLE otn_insights;`. The `registry_partner` staging is inbound-only and
adjudicated separately, so stopping the loop leaves the registry untouched.
