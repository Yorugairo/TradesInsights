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

**Recommendation (layers, lowest-risk first — they compose, they are not alternatives):**

1. **Build the identity match once.** Resolve `organizations.registry_ref` →
   `registry_business_entities.entity_id` on a **strong UBI key**, via a read-only sync of the
   registry's identity slice. Zero DB migration. This is the shared spine both integration
   directions ride on (Part C). **Do this first.**
2. **Ship the thin trades link next** (Insights → registry): a read-only, **public-only** API
   that serves each contractor's project/permit history onto their registry profile, plus the
   contact/company-match lookup. Lowest-risk, immediately makes the registry richer, exposes
   no account-private data.
3. **Then the login-walled CRM** (registry → Insights enrichment): the premium intelligence
   product for paying accounts, consuming registry identity — where the account-isolation/RLS
   work actually lives.
4. **Defer full DB co-location** (Part E) and **repo convergence** (Part F) until the seam is
   proven and load is measured.

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

-- External profiles (Google Business Profile etc.) — a provider-agnostic
-- SATELLITE table linked to entities. The Google Place ID is external_id with
-- external_provider='google'. Being actively populated (added 2026-07).
registry_entity_external_profiles(
  external_profile_id uuid, vertical_key text, external_provider text, external_id text,
  display_name text, profile_url text, canonical_url text, address_raw text, phone_raw text,
  website_url text, category text, rating numeric, review_count int,
  source_system text, source_run_id text, first_observed_at, last_observed_at,
  profile_payload jsonb, created_at, updated_at)

registry_entity_external_profile_links(          -- entity ↔ external profile match
  profile_link_id bigint, vertical_key text, external_profile_id uuid, entity_id uuid,
  source_record_id bigint, link_status text, relationship_type text, match_method text,
  match_score numeric, match_confidence numeric,
  public_surface_policy text, phone_write_policy text,   -- govern the REGISTRY's public surface
  evidence jsonb, decision_provenance jsonb, decided_by text, decided_at,
  superseded_by_link_id bigint, superseded_at, created_at, updated_at)
-- plus registry_google_place_review_queue — the human-review workflow for place↔entity matches.
```

**Data, verified live (`vertical_key='trades'`):**

- **25,545 canonical business entities; 22,366 in WA** (OR 1,499, ID 655, CA 193, …).
- Identifiers, all `is_strong = true`: **ubi ×25,545** (every entity), **contractor_number
  ×26,934**, root_domain ×105.
- Locations carry `lat`/`lng` (numeric; PostGIS is *available but not installed* in the
  project — they use numeric lat/lng, so there is **no geospatial-model conflict** with
  Insights' PostGIS).
- **External/Google profiles are landing (added 2026-07):** `registry_entity_external_profiles`
  ×3,817, `registry_entity_external_profile_links` ×4,052 — an in-progress backfill (~15% of
  entities linked so far). Google fields (place id, rating, review_count, website, phone,
  address, category, raw payload) live here, **not** as identifier rows or entity columns.
  `registry_entity_websites` is nearly empty (×1) — URLs come via `external_profiles.website_url`.
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

**Enrichment after the bind (not a match key):** once `registry_ref` → `entity_id` is set,
Insights pulls the registry's enrichment for that entity — canonical identity, trade
assignments, locations, and the **external/Google profile**: `entity_id →
registry_entity_external_profile_links` (active/confirmed `link_status`) `→
registry_entity_external_profiles` where `external_provider='google'`, yielding the Google
Place ID (`external_id`), rating, review_count, website, phone, address, and category. Google
data therefore evolves entirely inside that satellite table — it is never a match key and
never touches the identity contract (see H.4). **The `public_surface_policy` /
`phone_write_policy` link flags govern the REGISTRY's own public directory, not the Insights
CRM** — see Part C's boundary note.

## Part C — Connection topology & mechanism

### Two directions, one identity spine

The integration is **not one-directional.** There are two data flows serving two audiences,
and a single identity match underneath both:

```
                    ┌─────────────────────────────────────────────┐
                    │   identity match (the spine, built once)     │
                    │   organizations.registry_ref  ↔  entity_id   │
                    │   resolved on strong UBI (Part B)            │
                    └─────────────────────────────────────────────┘
        (a) registry → Insights                 (b) Insights → registry
   enrich the GC league / CRM with         serve public project/permit history
   contractor identity, contact, trades    onto contractor registry profiles;
   [Insights CONSUMES]                      answer "who is this company" for
   → the login-walled premium CRM           contact + company matching
                                            [registry CONSUMES]
                                            → the thin "trades link"
```

- **(a) Registry → Insights** — the login-walled CRM. The registry is a data source *into*
  Insights: resolve `registry_ref`, then surface verified identity, contact, and trade
  assignments on the GC league / org pages. Powers the relationship copilot. Insights
  consumes.
- **(b) Insights → Registry** — the thin trades link. Insights is a data source *into* the
  registry: every contractor profile shows its real project/permit history, and the registry
  can ask Insights "who is this company / what's their contact / which Insights org is this"
  for matching. Registry consumes.

Neither system reaches into the other's private tables. Both ride the same
`registry_ref ↔ entity_id` match.

### The boundary that makes (b) safe: public evidence vs private intelligence

Insights holds two very different data classes, and they map exactly onto the two surfaces:

| Class | Examples | Exposure |
|---|---|---|
| **Public evidence** | permits, projects, org↔project roles, stated valuations/dates — all from public records | **Shareable.** "This contractor pulled these permits" is public fact → this is what the **thin trades link** serves onto registry profiles. |
| **Account-private intelligence** | opportunities, scores, routes, pursuits, briefs, digests | **Never leaves the login wall.** One account never sees another's → this is the **CRM only.** |

The thin link is therefore a **read-only, public-only** API keyed by `entity_id`/UBI (e.g.
`GET /public/contractors/{ubi}/projects`) that serves *only* the public project graph for the
organization bound to that entity — the public/private split is enforced in code (a dedicated
query layer that never touches `opportunities`/`pursuits`/`model_runs`), not by convention.
The CRM is a separate login-walled surface for paying accounts on the same spine.

**Whose exposure policy applies where (important):** the registry's
`registry_entity_external_profile_links.public_surface_policy` and `phone_write_policy` govern
**the registry's OWN public directory** — what One Trade Network publishes to the world.

- **Direction (a), the Insights CRM, does NOT gate on those flags.** The CRM is login-locked
  to paying customers — a private, authenticated, paid tool, not a public surface — so it
  **surfaces every piece of information it can obtain for that client** (registry contact,
  phone, Google profile, rating, website, and all of Insights' own evidence). The registry's
  public-surface/phone-write policies are about the registry's public pages, not about what a
  paying Insights customer is allowed to see.
- **Direction (b), the thin link,** lands data on the registry's public surface, so the
  registry applies its own `public_surface_policy`/`phone_write_policy` there — that
  enforcement is the registry's, and Insights only sends public project/permit facts anyway.

So the split is: **Insights CRM = surface everything for the paying client; registry public
directory = the registry's policy flags decide.** The one hard line that never moves is
account-private intelligence (opportunities/scores/pursuits/briefs), which stays inside the
login wall and never crosses to another account or to the registry.

### Mechanism per direction

Both systems are Postgres today, so the mechanism differs by access pattern, not by product:

- **(a) Registry → Insights identity resolution — use SYNC.** Nightly pull the
  `vertical_key='trades'` identity slice (`registry_business_entities` + `_identifiers` +
  `_trade_assignments` + `_locations`, WA-first) into an Insights-side mirror
  (`registry_business_mirror`); resolve `registry_ref` against the mirror. Identity is
  slow-changing, the resolver runs in bulk over thousands of orgs, and the mirror keeps the
  Insights ingest engine independent of registry availability. Isolation + local indexes win
  here.
- **(b) Insights → Registry project history — use an API** (registry pulls, or Insights
  pushes a read model). A thin read-only endpoint lets Insights **enforce the public-only
  boundary in code** and version the contract across two teams, which a raw DB grant cannot.
- **Live single-entity reads** (e.g. an on-demand "current registry profile" panel in the
  CRM) — reach for **`postgres_fdw`** (both projects have `postgres_fdw`/`wrappers`) or a
  registry API for that one lookup; never put a live cross-DB call in the ingest critical
  path.

**Sync vs FDW, at a glance** (for direction (a) and any batch use):

| | Sync (mirror + schedule) | FDW (live foreign tables) |
|---|---|---|
| Freshness | last run (nightly is plenty for UBI/license/name) | always live |
| Failure coupling | none — registry down ≠ Insights down | coupled — a slow/down registry stalls queries |
| Latency | local table + local indexes; fast in bulk | network round-trip; limited join push-down |
| Security | one scoped read-only pull | credentials stored *inside* Postgres (user mapping) |
| Schema drift | absorbed in one mapping | a column rename breaks the foreign table |
| Point-in-time | dated snapshot (fits immutable-evidence ethos) | always "now" |

**Decision:** sync for batch identity resolution/enrichment; API for the thin link; FDW/API
only for a live single-entity lookup. The **resolver logic is identical** and lives in
Insights (`packages/resolution`) regardless of mechanism — and if the DBs are ever co-located
(Part E), the whole sync/FDW question collapses into a plain cross-schema join, so starting
with sync locks you into nothing.

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

## Part H — Durability & schema evolution

The registry is under active development (e.g. `google_places_id` and website URLs are being
added). The integration must survive those changes without breaking or silently binding stale
data. The durability is a **contract decision made before building**, not cleverness in the
sync code.

### H.1 — Integrate against a contract the registry owns, not its physical tables

The single most important rule: **Insights must not read `registry_internal` physical tables
directly.** Bind instead to a stable, versioned contract the registry publishes and owns:

- **A registry-owned VIEW** — e.g. `registry_public.trades_identity_v1` — is the lightweight
  option (no service to build). The registry maps its physical tables to the view; column
  adds/renames/refactors are absorbed *on their side*.
- **The thin API** (`v1`) is the same idea over HTTP, and additionally enforces the
  public/private boundary (Part C) and versions the contract across two teams.

Either way, **`v1` is a promise; internal columns are not.** One Trade Network can restructure
`registry_business_entities` freely as long as the `v1` contract still resolves — Insights
never notices.

### H.2 — Tolerant reader + raw-blob capture (the pattern Insights already runs)

The identity sync mirrors the `source_records` split Insights already uses
(`raw_fields_json` vs `normalized_json`):

- **Select named fields, never `SELECT *`** — a new column never changes the shape Insights
  parses.
- **Also stash the whole contract row as `raw jsonb`** on `registry_business_mirror`. When
  `google_places_id`/URLs appear in the contract, they are already sitting in the raw blob;
  **promoting one to a typed Insights column is a one-line migration when Insights actually
  needs it**, and nothing breaks in the interim.

### H.3 — Drift fingerprint (reuse D3), additive vs breaking

Apply Insights' existing **schema-fingerprint drift** health check (D3) to the registry
contract — hash the set of contract field names and act on change:

- **Additive drift** (a new field like `google_places_id`) → info/amber; safe, captured in
  the raw blob, no break.
- **A field Insights depends on disappears or changes type** → **red: fail the sync**, do not
  bind stale or mis-typed identity. A schema change becomes a visible signal, never a silent
  corruption or a crash.
- **Contract versioning:** additive is non-breaking; a breaking change is an explicit `v1` →
  `v2` bump (same discipline as the §13 AI contract and parser versions already in the repo).

### H.4 — Rows / satellite tables over columns (the registry already does this)

The registry models new attributes **not as columns on the entity** but as rows or linked
satellite tables — inherently extensible:

- **Identifiers as rows** — `registry_entity_identifiers(identifier_type, value_normalized,
  is_strong)`. A new strong identifier is a new `identifier_type`; the sync picks it up for
  free and the resolver ladder (Part B) simply gains a rank.
- **External profiles as a linked satellite** — **this is the path they took for Google**
  (confirmed live 2026-07): `registry_entity_external_profiles` (provider-agnostic; Google
  Place ID = `external_id` with `external_provider='google'`; rating/review_count/website/
  phone/address/`profile_payload`) linked via `registry_entity_external_profile_links`. Google
  data evolves entirely inside that satellite + its jsonb payload — **it never touches the
  entity row or the identity contract, and the sync just adds the join.** This is the most
  durable shape of all.

So `google_places_id` and website URLs are **already handled by construction** — they live in
the external-profiles satellite, not as entity columns and not (currently) as identifier rows.
The `v1` contract's enrichment slice therefore includes the external-profile join
(`external_provider`, `external_id`, `rating`, `review_count`, `website_url`, `phone_raw`,
`category`) — and the sync reads whichever of these the registry exposes, tolerating additions
via the raw blob (H.2). The only genuinely new *column* to watch for would be one added
directly to `registry_business_entities`; that is what the registry-owned view (H.1) absorbs.

### H.5 — What to settle now vs build later

- **Now (no code):** the rows-vs-columns question is largely answered — Google/website data is
  in the external-profiles satellite (H.4), so the remaining task is to agree the `v1` identity
  + enrichment contract (identity fields + the external-profile join Insights consumes) and
  have the registry stand up the view (or API stub). Confirm whether the Google backfill
  (~15% linked today) is complete enough to rely on, or treat the profile as best-effort
  enrichment until it is.
- **Later (build):** the sync reads the *contract*, mirrors typed fields + raw blob, and
  drift-fingerprints it; the `registry_ref` resolver runs on the mirror. Column changes after
  that are absorbed by the contract; additive fields ride the raw blob until promoted.

Net: **wait on the build, not the design.** The wait is spent making the seam contract-shaped
so the registry's column work never ripples into Insights.

## Recommended sequence (summary)

0. **Now, no code** — lock the `v1` identity + enrichment contract (Part H): the field list
   (identity + the external-profile/Google join, H.4) and the registry-owned view/API stub.
1. **Identity match** — `registry_ref` resolver via read-only sync (Part D), reading the
   contract from H.1. **First build**, no DB migration; the spine both directions ride on.
2. **Thin trades link** (Insights → registry) — a read-only, public-only `projects-by-
   contractor` + contact/match API onto registry profiles. Lowest-risk, immediately enriches
   the registry, exposes no private data.
3. **Login-walled CRM** (registry → Insights) — surface registry identity on the GC league →
   build the relationship copilot; this is where the account-isolation/RLS work lives.
4. Reassess **DB co-location** against Part E once the seam is live and load is measured.
5. **Repo convergence** (Part F) when a shared entity-resolution core justifies it.
