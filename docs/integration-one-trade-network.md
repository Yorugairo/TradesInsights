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
4. **Sequence DB co-location** (Part E) and **repo convergence** (Part F) after the seam is
   proven and load is measured. Convergence is a **decided direction, not an open question**:
   the Insights web app re-homes into `apps/crm` as the trades vertical (shared SaaS chassis,
   trades-specific product module), with the ingest/evidence engine staying a backend service.

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

## Part F — Repo convergence: Insights becomes the trades vertical of `apps/crm`

**Decision of record (product owner):** the Insights web app comes to live inside
`apps/crm`. `apps/crm` (`@gobjj/crm`) is the SaaS/CRM product to the vertical spin-offs;
the gym coaching product (`/coach/*`) is its first skin. Insights becomes the **trades
skin** on that same chassis. The stated ideal is that Insights be *byte-identical* to the
gobjj CRM app — "may not be possible at this point," so read this as: the **chassis is
shared verbatim; the trades product module is the vertical-specific delta.**

### What `apps/crm` already is (the chassis)

`@gobjj/crm` is a Next.js 16 / React 19 multi-tenant SaaS CRM in the registry monorepo.
The parts that are vertical-agnostic and meant to be shared unchanged:

- **Auth & tenancy** — Supabase SSR auth (`tenantAuth.ts`), per-tenant isolation.
- **Entitlements** — `moduleAccess.ts` gates which product modules a tenant can see; this
  is exactly the mechanism that lets one chassis serve gym tenants and trades tenants.
- **Platform admin** — `platformAdmin.ts`, routes under `/admin/*`.
- **Billing** — Stripe.
- **Comms** — Twilio (SMS) + Resend (email); Upstash for rate/limits and queues.
- **AI** — OpenRouter via the Vercel AI SDK (`aiModels.ts` / `aiGeneration.ts`).
- **Registry handoff** — `registryHandoff.ts` already exists: the CRM is designed to
  consume the registry.
- **Design system** — the shared app chrome/layout.

The gym product (`/coach/*`: roster, billing, messages, rollcall, POS) is a **module on
top of that chassis**, not the chassis itself. Trades is a second module of the same shape.

### The split: byte-identical chassis, vertical-specific module

| Layer | Trades vertical | Sharing |
|---|---|---|
| Auth / tenancy / entitlements / billing / comms / platform-admin / design | reused as-is | **byte-identical** — the "same coin" chassis |
| Product module (routes, screens, domain vocab) | Insights: opportunity briefs, ROI ledger, first-look coverage, GC/relationship views | **vertical-specific** — the trades skin |
| Ingest → parse → resolve → score → evidence **engine** | the current `apps/worker` + `packages/*` | **stays a backend service** — not merged into the CRM app |

The engine does **not** move into the Next.js app. Insights' collectors, parsers,
resolution, scoring, and the evidence graph remain an independent worker/DB tier. The CRM
trades module reads that tier through the **same contract seam** Parts C/D/H define — it is
another consumer of the evidence graph and the registry contract view, exactly like the
digest/email path today. Keeping the engine out of the request path preserves the §13 AI
contract, the immutable-evidence invariant, and account isolation regardless of how the UI
is packaged.

### Why this order (forcing function)

This convergence is **downstream of Part E co-location and the Part C/D/H contract**, not a
prerequisite. The seam that lets the CRM render Insights is the same account-scoped read
API the current web app already uses; co-location (Part E) is what makes it a local read
instead of a cross-service call. So the sequence is: prove the identity federation and the
contract view (Parts B–D, H) → co-locate the data (Part E) → **then** re-home the UI into
`apps/crm` as the trades module. Doing it in that order means the move is a re-skinning of a
proven read path, not a rewrite of the engine.

### Known deltas (why "byte-identical" is aspirational)

Insights and `apps/crm` diverge in four places that must be reconciled during the move, not
assumed away:

1. **Auth** — Insights uses its own app-layer account scoping; the CRM uses Supabase SSR
   auth + `tenantAuth`. Insights' account isolation maps onto CRM tenancy; the account
   profile becomes a tenant/entitlement, not a bespoke scope.
2. **Data access** — Insights uses Drizzle + hand-authored SQL migrations against
   Postgres/PostGIS; the CRM uses Supabase (raw client). The engine tier keeps Drizzle; the
   CRM trades module reads through the contract/read layer, so the ORM mismatch stays on the
   engine side of the seam.
3. **Design system** — Insights' current UI must be reskinned onto the CRM chrome/design
   system to reach chassis parity.
4. **AI** — Insights routes models through its own `providerFromEnv` + budget contract;
   the CRM routes through `aiModels.ts`/`aiGeneration.ts`. The §13 budget/validation
   contract must be preserved wherever the brief generator ultimately runs — re-homing the
   *call site* is fine; dropping the Zod-validated evidence-ID contract and per-job/monthly
   budget is not.

Both codebases already share DNA (canonical-name normalization, a match-decision model with
`rule_hit`/`margin`/`evidence`, `*_current` read models, evidence+confidence on every
assertion), which is why the chassis fit is real and not forced. The deeper prize — a
**shared entity-resolution/normalization/evidence core** with two verticals (projects,
businesses) instead of two implementations — is a further refactor beyond the UI move;
sequence it only after the trades module ships on the chassis and the teams want a shared
release cadence.

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

## Part I — Bidirectional learning & the source-identity inventory

The integration must **learn in both directions**: the registry teaches Insights *identity*;
Insights teaches the registry *activity*. This part records what each side actually has to
give (from a live inventory of every adapter + the production data, 2026-07-19) and specifies
the two learning feeds.

### I.1 — What Insights' sources actually carry (inventory, verified live)

The binding constraint is the parser contract: the normalized `Organization`
(`packages/domain/src/normalized-record.ts`) is **`{name, role, evidenceText}` only**
(`.strict()`) — there is no slot for an identifier or contact, so nothing richer can flow
into the graph today even where a source exposes it.

| Identity field | In Insights? | Where / notes |
|---|---|---|
| Company/contractor **name** | **Yes** | `primary_contractor` ×1,043 (lewis_issued_permits `primaryContractor`, centralia `contractor`, tacoma `applicant_name`, bid-inbox `general_contractor`); plus `applicant`/`owner`/`proponent`/`lead_agency` names. ~1,580 of 5,151 orgs look company-shaped. |
| Person full name | Yes (mostly non-contractors) | `applicant` ×7,109 + `owner` ×1,122 — largely owner-builders/homeowners. |
| **UBI** | **No source carries it** | `organizations.ubi` column exists, 0-populated. |
| **Contractor license / L&I registration** | **No source carries it** | `organizations.contractor_registration` exists, 0-populated. |
| **Phone / email** | Effectively no | `organization_contacts` was empty; only the private bid-inbox `estimator_contact` (kept un-normalized by design, M4.4 high-risk) and SEPA lead-*agency* phone. |
| Org mailing address | Trapped | king_permit_reports bundles "NAME & ADDRESS" into one un-parsed name string. |

Only 8 of ~20 adapters emit any party at all. The **high-volume feeds (Pierce PALS, Puyallup,
Seattle) carry zero contractor identity** in their extracts — project/parcel/valuation only.

**The asymmetry that shapes the design:** Insights has *names + live activity* but no strong
keys and no contact; the registry has *strong keys (UBI+license, 22k WA) + contact/Google*
but is a static directory with no live activity. Each side's surplus is the other's gap.

### I.2 — Feed 1: registry → Insights (identity adoption)

The Part D resolver, sharpened by the inventory:

- Match **contractor-role orgs only** (exclude the 8k+ applicant/owner person names —
  owner-builders must not pollute a company registry); gate on a person-vs-company check
  (`organization_type`).
- Because Insights holds **no strong key of its own**, the working match is **name + county**
  (normalized-name exact → auto-bind candidate at high confidence; anything fuzzy → review).
  The Part B rank-1/2 strong-key rungs apply only to the handful of orgs where a UBI/license
  is already known out-of-band (e.g. Solis itself).
- On bind, **adopt into the columns that already exist and sit empty**: `organizations.ubi`,
  `contractor_registration`, `website` (+ `verified_at`, `registry_ref`), and phone/Google
  into `organization_contacts` as **global public-business rows** — `account_profile_id`
  IS NULL, legal only for `source_type='public_business'` (migration
  `0020_public_business_contacts`, **implemented 2026-07-19** with the app-level guard in
  `addContact` and the org-view query returning own + global rows). Consistent with Part C:
  the login-locked CRM surfaces everything available for the client; customer-supplied
  contacts stay strictly account-scoped.

### I.3 — Feed 2: Insights → registry (the observation feed — "learning company identifiers
and assigning contractors to companies")

Insights publishes **contractor observations** into the registry's own ingest
(`registry_source_records` with `source_system='otn_insights'`, or the equivalent API), one
observation per (org-role × project-event). What Insights can honestly teach:

| Signal | From | Registry destination |
|---|---|---|
| **Liveness** — "pulled a permit on DATE in CITY" | project_events + roles | freshness/activity on the entity |
| **Project history** — permit/project per contractor | the public project graph | contractor profiles (feeds the thin link, Part C-b) |
| **Name aliases** — real-world spellings ("Century Communities, LLC" vs "…of WA LLC") | organization_aliases + raw names | `registry_entity_aliases` |
| **Trade evidence** — permit work-type × contractor role | records + classification | supports `registry_trade_assignments` (sparse at inspection) |
| **Co-occurrence** — GC↔sub appearing on the same project | roles per project | relationship edges |
| **New-entity candidates** — a contractor the registry hasn't minted | unmatched contractor-role orgs | `registry_match_candidates` / review |

Honest boundary: Insights **cannot teach a strong identifier** (it has none to give) — it
teaches *name + activity + location + trade*, which the registry resolves through its own
matcher (`registry_match_decisions` + review queue, never auto-merged). Public evidence only
— account-private intelligence never enters the feed (Part C boundary).

**The compounding loop:** Insights sees "Century Communities, LLC" on a permit → binds to the
registry entity → adopts UBI/license/Google → pushes the permit as activity → the registry
gains the project + the name variant → the next variant spelling resolves instantly for both
sides.

### I.4 — Closing the identity gap upstream (two build items)

1. **Extend the normalized `Organization` contract** with *optional* typed fields —
   `identifiers?: { type: 'ubi' | 'contractor_registration' | ...; value }[]` and
   `contact?: { phone?; email? }` — mirroring the registry's own typed-identifier model, so a
   source that exposes a strong key or contact can finally carry it into the graph instead of
   stranding it in `rawFields`. Unblocks: un-bundling king_permit_reports' "NAME & ADDRESS";
   promoting the bid-inbox `estimator_contact` **under the existing M4.4 high-risk review
   rules** (contact data always human-reviewed, never auto-delivered); any future
   license-bearing source.
2. **Portal detail-page enrichment (directive 2026-07-19: pull contractor info from the
   portal detail pages).** The big feeds' extracts lack the contractor, but the permit
   portals' *detail pages* may carry contractor name + license. This becomes a
   **verify-first enrichment track** — each portal goes through the standard activation
   checklist (robots/terms/access-class/rate-limits; bounded: enrich routed opportunities
   first, never blanket-crawl), superseding the earlier citation-only note *only after* a
   portal passes. First-probe feasibility (2026-07-19, one page each, honest results):
   - **PALS (Pierce)** — `pals.piercecountywa.gov` serves a 3KB Angular SPA shell; detail
     data loads from a backing JSON API. The right target is **API discovery** (the app's
     own REST endpoints), not page scraping — most promising of the three; needs a proper
     probe. robots.txt: 302, unresolved.
   - **Accela (Tacoma)** — no robots.txt (404); `urlrouting.ashx` deep links redirect to a
     session-stateful landing page (`Tacoma.aspx`). Technically heavy (ACA session flow);
     defer unless the value case is strong.
   - **Puyallup Portal** — no robots.txt (404); `StatusReference` pages ARE server-rendered
     (80–160KB real HTML) but the public status view exposes **conditions boilerplate only —
     no party names** (checked on an SFR permit). No win available on the public page.
   - **Better lever for identity specifically:** the registry itself already holds
     UBI+license for 22k WA contractors — the portals' unique value is the **permit↔contractor
     edge** (which contractor on which project), not identity. Weigh each portal build against
     simply improving the name-match + observation feed.

### I.5 — What to link / match / improve (priority order)

1. Registry→Insights identity adoption (I.2) — fills the empty identity columns; contractor
   orgs get real companies behind them. *(Schema prerequisite shipped: migration 0020.)*
2. Insights→registry observation feed (I.3) — liveness/history/aliases/trade evidence.
3. `Organization` contract extension (I.4.1) — stop stranding identity in rawFields.
4. PALS API discovery (I.4.2) — the one portal probe worth doing next; Accela deferred;
   Puyallup public page confirmed party-less.

## Part J — Registry codebase findings (Yorugairo/BJJRegistry @ release/trades-staging, verified 2026-07-19)

Direct read of the registry repo (the Trades vertical is one vertical of a vertical-agnostic
engine; the BJJ gym registries are the other). This confirms and sharpens the DB-only picture.

### J.1 — Batch pull pipeline; NO ingest API and NO public contract exist yet

- The engine is staged Node ESM scripts under `apps/registry/scripts/entity-resolution/`:
  **ingest → normalize → mint (deterministic Tier A) → link (Tier B/C, review-only) → report** —
  idempotent, replayable, "deterministic before fuzzy, precision before recall." Schema in
  `db/baseline-v1.2/18_entity_resolution.sql`. **Core-vs-skin:** vertical-agnostic tables +
  a `trades-config.mjs` skin holding the WA-L&I specifics.
- Everything is `registry_internal`, **RLS-enabled and granted to `service_role` only** (no
  anon/authenticated); Supabase auto-exposes only the `public` schema. **So Insights cannot
  read the identity tables at all except via a service_role connection or a surface the
  registry builds.** There is **no `registry_public` schema, no `trades_identity_v1` view, no
  external/GraphQL API** — the H.1 contract is confirmed *unbuilt*. Its home is a new
  `registry_public.trades_identity_v1` view (a migration under
  `apps/registry/supabase/migrations/` mirrored into `db/baseline-v1.2/`) or a thin public
  route in `apps/registry`.
- The repo has two Next.js apps — `apps/registry` (the pSEO contractor directory,
  `/contractor/{slug}`) and **`apps/crm`** — plus `packages/shared-routes`. (Worth noting given
  the "Insights = the CRM" framing: a CRM app already exists here; clarify how they relate.)

### J.2 — The engine auto-resolves on STRONG keys only; Insights has none — so Insights carries the entity_id

- `mint-entities.mjs` clusters on **strong identifiers only** (`{ubi, contractor_number,
  root_domain}`), union-find, exact. A record with no strong id → `status='unresolved'` (never
  auto-matched, never minted). The name+state **fuzzy tier is defined but NOT built**;
  `link-candidates.mjs` only writes the review queue, never auto-merges.
- **Feed 1 consequence:** Insights runs its *own* name+county match on the synced identity
  slice (Part D) — it cannot lean on the registry's matcher, which isn't built.
- **Feed 2 consequence — the elegant fix for the whole asymmetry:** a name-only Insights
  observation would land `unresolved` in the registry. But because Insights binds
  `registry_ref` (entity_id) on its own side *first*, **its observations carry the resolved
  `entity_id` + match evidence** — the registry attaches them as evidence-tagged candidates to
  the *known* entity (respecting its precision-first, never-auto-merge invariant) instead of
  re-matching a keyless record. Insights proposes the link; the registry adjudicates it. This
  is how Insights teaches activity without ever needing a strong identifier of its own.

### J.3 — Write targets exist but their loaders are dormant; Feed 2 needs registry-side code

- `registry_source_records` has one writer, `ingest-source-records.mjs`, which **pulls** from
  `public.tenants WHERE settings->>'source'=<system>`; one `source_system` exists today
  (`wa_lni_g526_rd4x`). An Insights feed = a new sibling `ingest-otn-insights.mjs` writing
  `source_records` with `source_system='otn_insights'`, `vertical_key='trades'`,
  `tenant_id=NULL`, upsert on `(vertical_key, source_system, source_natural_key)`. There is no
  push API — this is net-new registry code.
- `registry_entity_aliases`, `registry_entity_locations`, `registry_trade_assignments` all
  EXIST but have **no populator yet** (registry Phases 4-5). Feeding Insights' name variants /
  project locations / trade evidence means the registry writes the first loader for each,
  keyed by `entity_id` + `source_record_id` provenance.
- **So Feed 2 is not unilateral** — it needs registry-side work (the new source_system, the
  carry-`entity_id` adjudication path, and the dormant enrichment loaders).

### J.4 — Google Place is schema-only; L&I is the phone/identity authority

- The Google satellite (`20_google_external_profiles.sql` + the #6 `21_google_place_
  productization.sql`) is a **schema-only release candidate**: no data import, no phone writes,
  no publication yet; the enrichment column `registry_gym_page_bundle_current.
  external_profile_enrichment` has zero UI references.
- **L&I remains identity + phone authority.** `phone_write_policy` is DB-CHECK-pinned to the
  single value `lni_phone_authoritative`; Google `phone_raw` is evidence-only and **never**
  surfaces on the registry's public directory. `public_surface_policy` (free-text, computed
  upstream) is public-safe only for `profile_enrichment_ready` / `primary_only`. The
  entity↔profile link is **identity-anchored** (re-resolved requiring strong
  contractor_number AND ubi), so Google enrichment only ever attaches to an entity with
  confirmed L&I identity.
- **For the Insights CRM** (login-locked, paid — surfaces everything for the client, Part C):
  adopt the surfaceable Google fields (website, rating, review_count, category, maps_url) and
  use the **L&I phone as the authoritative contact**; the Google `phone_raw` is supplementary
  evidence, labeled as such. Because the Google data is unpopulated today, treat it as *future*
  enrichment behind the identity bind.

### J.5 — Updated dependency reality

Both feeds have registry-side prerequisites that are *designed but unbuilt*:

| Feed | Registry-side prerequisite | Data ready? |
|---|---|---|
| 1 — identity adoption (registry→Insights) | the `v1` contract view/API (J.1), or a service_role sync grant | **Yes** — 22k WA entities, strong UBIs populated |
| 2 — observation feed (Insights→registry) | new `otn_insights` source_system + carry-`entity_id` adjudication + the dormant alias/location/trade loaders | n/a (Insights supplies) |
| Google enrichment | run the import + publication pipeline (schema-only today) | Not yet — ~15% linked, unpublished |

This makes the **"now, no code" contract step (H.5) the unambiguous first move**: the registry
decides the `v1` view shape *and* whether it will accept Insights' carried `entity_id` as a
reviewed candidate; both teams then build against that single agreement.

## Recommended sequence (summary)

0. **Now, no code (both teams)** — one agreement (Parts H + J.5): the `v1` identity+enrichment
   contract shape, the reachability (a registry-owned `registry_public.trades_identity_v1` view
   or a service_role sync grant — J.1: nothing else is reachable), and whether the registry
   will accept Insights' carried `entity_id` as a reviewed candidate (J.2).
1. **Identity match + adoption** — `registry_ref` resolver via read-only sync (Part D),
   Insights-side name+county match (the registry's matcher is unbuilt — J.2), adopting
   identity/contact per I.2 (the 0020 global-contact migration is already in). **First build**;
   the spine both directions ride on. *Registry prerequisite: the `v1` view or a read grant.*
1b. **Observation feed** (I.3) — Insights writes observations carrying the resolved `entity_id`;
   the registry teaches itself liveness/history/aliases/trade evidence. *Registry prerequisite:
   the `ingest-otn-insights.mjs` source_system + the dormant alias/location/trade loaders (J.3).*
2. **Thin trades link** (Insights → registry) — a read-only, public-only `projects-by-
   contractor` + contact/match API onto registry profiles. Lowest-risk, immediately enriches
   the registry, exposes no private data.
3. **Login-walled CRM** (registry → Insights) — surface registry identity on the GC league →
   build the relationship copilot; this is where the account-isolation/RLS work lives.
4. Reassess **DB co-location** against Part E once the seam is live and load is measured.
5. **Repo convergence** (Part F) — re-home the Insights web app into `apps/crm` as the trades
   vertical (chassis reused, engine stays a service); a shared entity-resolution core is a
   further refactor after that.
