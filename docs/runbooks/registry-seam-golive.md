# Runbook — take the home-metro pre-permit surface + registry ⇄ Insights seam live

**Audience:** operator / owner with (a) a genuine browser in the Thurston metro and
(b) credentials to the Trades registry database.
**Goal:** turn on the two things that were built dark this cycle —
1. **Part A — the home-metro pre-permit product surface:** operator-local capture of
   the Olympia SmartGov reports (now **both** issued *and* application-stage) and the
   Tumwater DRC / SEPA feeds, so Solis sees interior work **before** issuance (the
   commercial bid window, per `docs/domain-bid-timing.md`).
2. **Part B — the registry ⇄ Insights seam:** so registry identity + the shared trade
   vocabulary reach Solis scoring, and reviewed Insights observations flow back into
   `registry_partner` staging.

Everything below is **skip-safe / no-op-safe**: with no `OTN_CAPTURE_DIR` the
capture-fed sources dead-letter exactly as in the datacenter; with no
`REGISTRY_DATABASE_URL` the seam stays dark and the pipeline runs as today. Nothing
here binds an entity automatically or bypasses a bot control.

> **Governance (unchanged, non-negotiable):** never bypass Akamai / the Exago `eid`
> — Part A parses **genuine-browser bytes** captured by a human, never a driven bot.
> Never fabricate a source field (unknown = null). The person-vs-business gate keeps
> homeowner PII out of the registry bridge. Do **not** commit any connection string,
> password, capture file, or service key — captures live under `$OTN_CAPTURE_DIR`
> (gitignored), secrets in the deploy env only. Never target `origin/main`; the
> trades trunk is `release/trades-staging` (github.com/Yorugairo/BJJRegistry).

---

# Part A — Home-metro pre-permit capture (operator-local)

## Why this is the new product surface

Interior finish trades (Solis = drywall + paint) are bid on two clocks
(`docs/domain-bid-timing.md`): **residential** ~4–8 wks *after* permit issuance,
**commercial** ~2–6 months *before* it (the GC buys out framing/drywall off the
90–100% plans to lock the GMP). Watching only *issued* permits misses every
commercial job — by issuance the buyout is done. These three feeds are the
pre-issuance / application-stage signal for the home metro:

| Source key | Report / feed | Stage it exposes |
|---|---|---|
| `olympia_smartgov_reports` | Permit **Applications** Submitted Last 30 Days | `permit_applied` (pre-issuance lead) |
| `olympia_smartgov_reports` | Permits **Issued** Last 30 Days | `permit_issued` (confirmed work) |
| `tumwater_development_review` | DRC agendas index | pre-application / plan review |
| `tumwater_sepa` | Notice-of-Application / SEPA index | entitlement / environmental review |

All are `enabled: true` but `cadence: on_demand`, so `schedulableSources()` **never**
runs them in the datacenter (where Akamai + the Exago `eid` 403 an automated client).
They run only via the operator-local CLI below, over staged genuine-browser captures.

## A1 — Capture the artifacts in a genuine browser (in-region)

From a normal browser session in the Thurston metro (the operator's own Chrome):

- **Olympia** — open the SmartGov Reports viewer, run each report, and **Export → PDF**
  (the only export that works; Excel/CSV/HTML 500). Save exactly:
  - `permits-issued-last-30-days.pdf`
  - `permit-applications-last-30-days.pdf`
- **Tumwater DRC** — open the Development Review page; capture the agendas list as the
  `drc-agendas.index.json` shape (case #, meeting date, published-document links —
  **index only; do not fetch the linked PDFs**, they carry homeowner PII).
- **Tumwater SEPA** — open the Notice-of-Application / SEPA page; capture the notices
  list as `noa-sepa.index.json` (same index-only rule).

These are the same filenames the adapters read. The committed `fixtures/<key>/…`
copies are the golden test artifacts — **do not** overwrite them; stage live captures
under `$OTN_CAPTURE_DIR` instead.

## A2 — Stage the captures and run

```bash
export OTN_CAPTURE_DIR=/secure/local/otn-captures    # gitignored, operator machine only
#  $OTN_CAPTURE_DIR/
#    olympia_smartgov_reports/permits-issued-last-30-days.pdf
#    olympia_smartgov_reports/permit-applications-last-30-days.pdf
#    tumwater_development_review/drc-agendas.index.json
#    tumwater_sepa/noa-sepa.index.json

pnpm source:run:operator-local          # runs exactly the on_demand home-metro set
```

`source:run:operator-local` resolves `operatorLocalSources()` (mirror of
`schedulableSources()`: `enabled && cadence==='on_demand' && access_class !==
'private_authorized' && !== 'fixture'`) → exactly `olympia_smartgov_reports` +
`tumwater_development_review` + `tumwater_sepa`. Each adapter reads
`$OTN_CAPTURE_DIR/<key>/<file>`; if a file is missing it **dead-letters** (never
fabricates). Cloud-safe: with `OTN_CAPTURE_DIR` unset the CLI warns and every source
dead-letters, identical to the scheduled path.

## A3 — Verify Part A

- **Olympia parse reconciles:** the run log shows both reports parsed and
  self-reconciled to their printed Grand Totals — **issued 572, applications 815**,
  every category count == its printed `Total … Permits|Applications: N`
  (`checkInvariants` empty; `parserVersion 1.1.0`). A reconciliation violation marks
  the source red and suppresses both reports — that's the intended guard.
- **Stage is correct:** application records carry `normalizedStage: permit_applied` +
  `applicationDate` (issueDate null); issued records the reverse. This is what drives
  the commercial vs residential bid-window line.
- **No PII crossed:** Tumwater records have `organizations: []` (index-only); the
  linked PDFs were not fetched.

Cadence: a daily/weekly batch = the operator repeats A1–A2 on whatever schedule Solis
needs. Nothing here is automatable in the datacenter without bypassing a bot control,
which we do not do.

---

# Part B — Registry ⇄ Insights seam

## Prerequisites (already on trunk)

Merged to `release/trades-staging` (`6b72c81`) — verify with the migration ledger:

- `registry_public.trades_identity_v1` + role `otn_insights_reader` (NOLOGIN)
  — migration `20260719091458_registry_public_trades_identity_v1` / baseline
  `23_registry_public_contract.sql`.
- `registry_public.trades_taxonomy_v1` (shared trade vocabulary) + reader grant —
  migration `20260720093000_registry_public_trades_taxonomy_v1` / baseline
  `25_registry_public_trades_taxonomy.sql`.
- `registry_partner` inbound staging (`partner_observations`, `partner_project_facts`)
  + role `otn_insights_writer` (NOLOGIN) — ledgers `20260719095534` / `...095646` /
  `...100034` / baseline `24_registry_partner_inbound.sql`.
- Loader `apps/registry/scripts/entity-resolution/ingest-otn-insights.mjs`.

`otn_insights_reader` / `otn_insights_writer` are **NOLOGIN grant-holders** — they
carry the least-privilege grants but cannot log in. Step B1 provisions a login role
that inherits both.

## Step B1 — Provision the login role (registry DBA, one time)

> **DONE 2026-07-20** — `otn_insights` LOGIN role created on the Trades DB
> (`arbmeioglflvzoffgtii`), member of `otn_insights_reader` + `otn_insights_writer`.
> Least-privilege verified: reads `registry_public.{trades_identity_v1,
> trades_taxonomy_v1}`, can INSERT `registry_partner.*`, denied `registry_internal`.
> The password lives only in the owner's secret store; not in this repo.

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
SET ROLE otn_insights;
SELECT count(*) FROM registry_public.trades_identity_v1;                 -- OK
SELECT count(*) FROM registry_public.trades_taxonomy_v1;                 -- OK
SELECT count(*) FROM registry_internal.registry_business_entities;       -- ERROR: permission denied
-- Writer grant: a throwaway INSERT into registry_partner.partner_observations
-- (columns per db/baseline-v1.2/24_registry_partner_inbound.sql) succeeds, then
-- ROLLBACK. The Insights writer (exportRegistryObservations) is the real caller.
RESET ROLE;
```

Rotate the password if it is ever exposed; revoke with `DROP ROLE otn_insights;`.

## Step B2 — Seed the shared trade vocabulary (registry, before trade evidence)

> **DONE 2026-07-20** — `registry_public.trades_taxonomy_v1` view published and the
> curated 23-trade `TAXONOMY_SEED` seeded into `registry_internal.registry_trade_taxonomy`
> (verified: 23 view rows, `otn_insights` can SELECT, `general_contractor` keywords=[]
> so it's never text-inferred). Applied via the owner's direct DB connection because
> the seed writes `registry_internal` (which the least-privilege `otn_insights` role
> cannot). Insights' `fetchTradeTaxonomy` reads exactly `trade_code, label, keywords,
> parent_code, active` — matches the view. No Insights redeploy needed; it derives the
> matcher on the next run with `REGISTRY_DATABASE_URL` set, closing the drywall/
> painting/glazing finish-trade gap.
>
> **⚠ Per-entity assignments NOT run (blocked, a real registry finding):** the
> `assign-license-trades` normalizer expects descriptive specialty strings
> ("drywall", "gypsum"), but `public.tenants.settings.license.specialty1/2` holds WA
> L&I **2-char specialty CODES** (`01`, `3a`, `bk`, `sw`, `xx`, …) — so it maps **0 of
> 80** distinct values and `registry_trade_assignments` stays empty. This does **not**
> affect the Insights matcher (which reads the taxonomy, not the assignments). To turn
> on authoritative per-entity L&I trades, add a code→trade_code map (the L&I specialty
> codebook + the license `type`: EC⇒electrical, PC⇒plumbing, …) to
> `trades-taxonomy-map.mjs`, then run `assign-license-trades.mjs`. Do **not** guess
> what a 2-char code means — use the L&I codebook.

The scripts below are the reproducible/registry-repo path (they need a privileged
`DATABASE_URL`; the taxonomy seed above was applied equivalently). Re-runnable +
idempotent:

```bash
# In the registry repo (release/trades-staging), against the Trades DB:
DATABASE_URL=…:5432/… node apps/registry/scripts/entity-resolution/seed-trade-taxonomy.mjs --dry-run  # inspect + unmapped report
DATABASE_URL=…             node apps/registry/scripts/entity-resolution/seed-trade-taxonomy.mjs          # upsert registry_trade_taxonomy (idempotent)
DATABASE_URL=…             node apps/registry/scripts/entity-resolution/assign-license-trades.mjs        # per-entity trades — needs the code map first (see ⚠ above)
```

## Step B3 — Point Insights at the registry (deploy env)

Set in the Insights deploy environment (never in the repo):

```
REGISTRY_DATABASE_URL=postgres://otn_insights:<secret>@<host>:5432/<db>
```

**GOTCHA — session port 5432, not the transaction pooler 6543.** pg-boss (the
Insights job runner) breaks on Supabase's transaction pooler; use the **session**
connection. `createRegistryPool()` returns `null` when the var is unset ⇒ the seam
stays dark and the pipeline still runs.

## Step B4 — Run the loop

Insights nightly (already wired in `apps/worker/src/schedules.ts`), in order:

1. `resolve:run` → `linkRegistry` (bind Insights orgs to registry entities by
   strong identifier — human/strong-key only), then `generateRegistryObservations`
   (binding candidates, phone adoption, alias/trade export — the trade matcher now
   derives from `trades_taxonomy_v1`, scanning permitType **and**, for bound GCs,
   project title/description at a de-rated `trade_<code>_desc` confidence), then
   `exportRegistryObservations` (push **accepted** observations + public project facts
   to `registry_partner`).
2. Registry-side adjudication — pull the staged observations into `registry_internal`:
   ```bash
   DATABASE_URL=…:5432/… node apps/registry/scripts/entity-resolution/ingest-otn-insights.mjs [--dry-run] [--limit=N]
   ```
   The loader validates every row, applies or skips it, stamps `applied_at` +
   `applied_action`, and **never** mints/merges/touches L&I identity. Trade evidence
   writes `registry_trade_assignments` at rank `secondary` (corroborating the
   authoritative `license_code` primary).

## Verification (Part B)

- `linkRegistry` summary: `skipped:false`, `bound > 0` after the first run.
- Solis scoring rationale shows `verified_gc_on_project` / `warm_gc_active` signals
  once orgs are bound (both **score-neutral** under §12.3 until Solis calibration —
  see `docs/solis-requirements.md`).
- `SELECT applied_action, count(*) FROM registry_partner.partner_observations
  WHERE source_system='otn_insights' GROUP BY 1;` — reviewed observations land and
  are adjudicated; no unexpected `skipped:*` classes.
- No homeowner PII crosses the seam (the person-vs-business gate keeps
  `organizations[]` empty for home-metro capture sources).

## Rollback

Unset `REGISTRY_DATABASE_URL` (seam goes dark, pipeline unaffected) and/or
`DROP ROLE otn_insights;`. The `registry_partner` staging is inbound-only and
adjudicated separately, so stopping the loop leaves the registry untouched. For Part A,
simply stop staging captures / unset `OTN_CAPTURE_DIR` — the sources dead-letter.

---

## What still requires the Solis calibration session

Both `verified_gc_on_project` and `warm_gc_active`, and the application-stage /
bid-window timing weight, travel in `signals[]` but carry **no account weight** until
Solis confirms scope (§12.3). The calibration inputs (thresholds, radius/age, the
county mix now that Olympia application-stage volume is flowing) are in
`docs/solis-requirements.md` and `docs/calibration-prep-solis.md`.
