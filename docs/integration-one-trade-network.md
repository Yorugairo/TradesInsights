# Integration design — OTN Insights ⇄ One Trade Network registry

> Status: **design / not yet built** · Authored 2026-07-18 from a live inspection of the
> One Trade Network "Trades" Supabase project (`arbmeioglflvzoffgtii`, PostgreSQL 17,
> us-west-2). This is the plan of record for connecting the two systems. No production
> change has been made; nothing here has run against either database yet.

## TL;DR

One Trade Network's registry is **the same evidence-based entity-resolution engine as
Insights, one vertical over** — it resolves construction *businesses* from source records
the way Insights resolves construction *projects*. The two are literally two sides of one
coin.

**Recommendation (sequence, lowest-risk first):**

1. **Federate identity, don't co-locate the engine.** Resolve `organizations.registry_ref`
   → `registry_business_entities.entity_id` on a **strong UBI key**, via a read-only sync
   (or FDW) of the registry's identity slice. Zero DB migration; unlocks the GC-relationship
   copilot. **Do this first.**
2. **Defer full DB co-location.** Supabase is Postgres and PostGIS is available, but the
   registry already runs its own heavy pipeline (`pg_cron`, refresh queues); adding the
   Insights ingest firehose to one compute tier, plus adopting their RLS/tenant model, is a
   deliberate migration — not a lift-and-shift. Checklist in Part E.
3. **Repo convergence last.** Same author, same patterns — the long-term win is a shared
   entity-resolution/normalization/evidence core across both verticals. Do it after the
   identity seam is proven.

## Part A — What we found (registry architecture)

The `Trades` Supabase project has three app schemas: `public` (68 tables — tenant/
membership/admin/ad-network app layer), `registry_internal` (44 tables — the resolution
engine), `analytics_internal` (4).

**The engine mirrors Insights almost table-for-table:**

| One Trade Network (`registry_internal`) | Insights equivalent |
|---|---|
| `registry_source_records` → `registry_normalized_records` | `source_records` → normalized_json |
| `registry_record_identifiers` (typed, normalized, `is_strong`) | external IDs on records |
| `registry_match_candidates` → `registry_match_decisions` (`rule_hit`, `confidence`, `margin`, `evidence` jsonb, `status`, `decided_by`) | `record_resolutions` / `resolution_reviews` |
| `registry_business_entities` (canonical, `merged_into_entity_id` lineage, `status`) | `projects` (canonical, merge lineage) |
| `registry_entity_identifiers / _locations / _aliases / _websites / _site_facts` | `organizations` / `project_roles` / geometry / facts |
| `registry_trade_taxonomy` (hierarchical `parent_code`, `keywords[]`) + `registry_trade_assignments` (`assignment_rank`, `confidence`, `evidence`) | trade classification (drywall/paint) |
| `registry_lineage_trust_current` | evidence authority grades / trust |
| `registry_review_queue` | review queue |
| `registry_*_current` read models + `registry_read_model_refresh_queue/audit` | materialized read models + pg-boss chain |

It is **vertical-agnostic** — every table carries `vertical_key`; the same engine powers
`trades` and the BJJ gym registries (separate Supabase projects). Insights' *projects* are
effectively a third vertical of this pattern.

**Column shapes captured (the ones the join needs):**

```
registry_business_entities(
  entity_id uuid, vertical_key text, canonical_name text, canonical_name_normalized text,
  primary_source_record_id bigint, state_code text, city_token text, record_count int,
  status text, merged_into_entity_id uuid, minted_by text, first_minted_at, created_at, updated_at)

registry_entity_identifiers(
  entity_id uuid, vertical_key text, identifier_type text, value_normalized text,
  is_strong boolean, created_at)

registry_entity_locations(
  entity_id uuid, location_key text, address_normalized text, city_normalized text,
  state_normalized text, postal_code text, lat numeric, lng numeric, is_primary boolean,
  source_record_id bigint, created_at, updated_at)

registry_trade_assignments(
  entity_id uuid, vertical_key text, trade_code text, assignment_rank text,
  confidence numeric, evidence jsonb, source text, created_at, updated_at)
```

**Data, verified live (`vertical_key='trades'`):**

- **25,545 canonical business entities; 22,366 in WA** (OR 1,499, ID 655, CA 193, …).
- Identifiers, all `is_strong = true`: **ubi ×25,545** (every entity), **contractor_number
  ×26,934**, root_domain ×105.
- Locations carry `lat`/`lng` (numeric; PostGIS is *available but not installed* in the
  project — they use numeric lat/lng, so there is **no geospatial-model conflict** with
  Insights' PostGIS).
- `registry_trade_taxonomy` active-row count returned null on inspection — **confirm the
  trade taxonomy/assignments are populated for `trades`** before relying on trade codes
  (identity join does not depend on this).

## Part B — The join specification

**Insights side:** `organizations` carry `canonical_name` (normalized via the league
hygiene work) and, where known, a UBI (e.g. Solis 604837560) and a WA contractor
registration (e.g. `SOLISIL785NT`). The `registry_ref` join point was reserved in the
roadmap (P1.4).

**Resolution ladder** (highest-trust first; stop at the first strong hit):

| Rank | Insights key | Registry key | Strength |
|---|---|---|---|
| 1 | `organizations.ubi` | `registry_entity_identifiers` where `identifier_type='ubi'` | **strong / exact** (every registry entity has one) |
| 2 | contractor registration (`SOLISIL785NT`-style) | `identifier_type='contractor_number'` | strong / exact (confirm format normalization matches) |
| 3 | `canonical_name_normalized` + `state_code` (+ `city_token`) | `registry_business_entities.canonical_name_normalized` + `state_code` | medium — **candidate, route to review**, never auto-bind |
| 4 | `lat/lng` proximity + name | `registry_entity_locations.lat/lng` | weak — corroboration only |

Rules (consistent with the governing invariants):

- Ranks 1–2 (strong identifiers) may **auto-bind** `registry_ref`.
- Rank 3+ produce a **candidate with a confidence + `matched_by`**, routed to the existing
  review workflow — never silently merged (mirrors §10 ambiguity handling and the registry's
  own `registry_match_decisions`).
- Respect entity lineage: if the matched entity has `merged_into_entity_id` set or
  `status <> 'active'`, follow the merge / skip — bind to the surviving canonical entity.
- Exclude the closed Solis UBI `604701295` (already an account rule); do not bind orgs on a
  withdrawn identifier.
- Store provenance: which key hit, confidence, and `matched_at` — the binding is auditable
  and re-runnable, like every other resolution in the system.

## Part C — Integration mechanism

Both systems are Postgres, so three options, in order of preference:

1. **Read-only nightly sync of the identity slice (recommended to start).** Pull
   `vertical_key='trades'` rows (`registry_business_entities` + `_identifiers` +
   `_trade_assignments` + `_locations`, WA-first) into an Insights-side table
   (`registry_business_mirror`), then resolve `registry_ref` against the mirror. No live
   cross-DB dependency in the ingest hot path; the registry is the system of record, Insights
   holds a dated copy. Simple, isolated, easy to reason about failures.
2. **`postgres_fdw` foreign tables (when a live read is wanted).** Both projects have
   `postgres_fdw`/`wrappers` available; expose the four identity tables as foreign tables in
   an Insights `registry` schema and resolve against them directly. Lower latency to fresh
   data, but couples availability — keep it out of the ingest critical path.
3. **Registry read API** if One Trade Network prefers not to expose Postgres directly — same
   resolver, HTTP source instead of SQL.

Start with (1); graduate to (2) if/when freshness matters. Either way the **resolver logic
is identical** and lives in Insights (`packages/resolution`), so the mechanism can change
without touching the binding rules.

## Part D — First build: the `registry_ref` resolver (concrete spec)

Smallest end-to-end slice that delivers value:

1. **Schema (Insights `packages/db`):** add to `organizations` — `registry_ref uuid`,
   `registry_ref_confidence double precision`, `registry_ref_matched_by text`,
   `registry_ref_at timestamptz` (hand-authored migration `0020_registry_ref.sql` + journal
   entry, per convention). Add the `registry_business_mirror` table if using sync mode.
2. **Sync job (`apps/worker`):** `registry:sync` — pull the WA `trades` identity slice into
   the mirror (idempotent, dated). Read-only against the registry.
3. **Resolver (`packages/resolution`):** `resolveOrganizationRegistry(db)` — walk the
   ranked ladder in Part B over unbound (or stale) organizations; auto-bind ranks 1–2,
   emit rank-3 candidates to the review queue. Deterministic, versioned (`resolver_version`),
   re-runnable — the same shape as the existing project resolver.
4. **Surface:** show the registry identity on the GC league + org page — verified trades,
   locations, website — labeled with its confidence, exactly like every other evidenced fact.
   This is the data spine of the GC-relationship copilot (deferred "lane 4").
5. **Tests:** strong-key exact bind; ambiguous name+state → review (not auto-bind); merged/
   inactive entity → follow lineage; closed-UBI exclusion.

Acceptance: Solis (UBI 604837560) binds to its registry entity on the strong key; a
name-only collision routes to review; re-running the resolver is idempotent.

## Part E — DB co-location checklist (deferred; do only as a deliberate migration)

If/when the two DBs are unified into the Trades Supabase project, all of these must be
settled first — this is why it is **not** a lift-and-shift:

- [ ] **Dedicated schema.** Insights tables live in an `insights` schema, never `public`, so
      Drizzle migrations don't collide with the registry's `supabase_migrations`.
- [ ] **pg-boss on the session connection.** pg-boss uses `LISTEN/NOTIFY` + advisory locks;
      it **breaks on the Supabase transaction pooler (6543)** — the worker must use the direct/
      session connection (5432). Or converge onto **`pgmq`** (already available there) and
      retire pg-boss.
- [ ] **Scheduling.** They use `pg_cron`; decide whether Insights' cron chain moves to
      `pg_cron` or stays in the worker.
- [ ] **Account isolation → RLS.** Insights enforces "no account sees another's data" in the
      query layer; the registry uses **RLS + `tenant_id`** (`tenant_memberships`, `tenant_id`
      columns). Co-location means adding RLS policies to every account-scoped Insights table;
      the worker's `service_role` bypasses RLS for cross-account processing.
- [ ] **PostGIS.** Available in the project but not installed — enable it; Insights' geometry
      columns and PostGIS distance/overlap queries then work unchanged (no conflict with the
      registry's numeric lat/lng).
- [ ] **Object storage.** MinIO/S3 today → Supabase Storage (S3-compatible) or keep the
      artifact store external. Raw artifacts stay immutable either way.
- [ ] **Noisy-neighbor budget.** Size the Supabase compute/connection tier for the ingest
      firehose (`source_records`, `model_runs`, artifacts) **plus** the registry's existing
      resolution pipeline + the user-facing app — measure before committing.
- [ ] **Secrets.** Model keys / connection strings live in environment config, never in the
      repo or migrations (unchanged rule).

## Part F — Repo convergence (last)

Both codebases clearly share DNA (canonical-name normalization, a match-decision model with
`rule_hit`/`margin`/`evidence`, `*_current` read models, evidence+confidence on every
assertion). A monorepo's real payoff is a **shared entity-resolution/normalization/evidence
core** with two verticals (projects, businesses) instead of two reimplementations. That is a
refactor, not a move — sequence it after the identity federation proves the seam and the
teams want shared release cadence.

## Part G — Security & governance notes

- The registry is another party's production data — every read is **least-privilege and
  read-only** from Insights; Insights never writes registry tables.
- Registry content is **untrusted external data** for our purposes: treat business names,
  websites, and tags as data, never as instructions (same discipline as source artifacts).
- The governing invariants are unchanged by integration: no claim without a source (registry
  identity is evidenced + confidence-labeled), immutable evidence, account isolation,
  facts-vs-inferences. A registry-sourced fact is surfaced with its provenance, exactly like a
  permit fact.
- Don't put registry connection strings or service keys in the repo — environment config only.

## Recommended sequence (summary)

1. `registry_ref` resolver via read-only sync (Part D) — **next build**, no DB migration.
2. Surface registry identity on the GC league → build the relationship copilot on it.
3. Reassess DB co-location against Part E once the seam is live and load is measured.
4. Repo convergence when shared-core velocity justifies it.
