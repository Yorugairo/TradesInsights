# Plan: Queue cockpit v2 — fuel the phone lane first, then close the loops

> **STATUS 2026-07-28 — PARTIALLY SHIPPED, NOT CLOSEABLE.** Reports exist for phases A0, B, C and D (`.claude/PRPs/reports/queue-cockpit-phase-{a0,b,c,d}-report.md`). **Remaining: Tasks A1–A6** (the `organization_enrichment` table, export/ingest CLIs, enrichment phones in the match ladder, evidence display) **and Tasks E1–E2** (domain-match evidence path + strategy note, gated on Phase A enrichment coverage). Task B3 (loader `relationship` branch) lives in the REGISTRY repo. Do not archive this plan on the strength of the four phase reports.


> **v2 (2026-07-24), supersedes v1 in place.** What changed and why:
> 1. **Owner reprioritization**: "6 should be resolved first, then 4 and 2. 1, 3, 5
>    will need to be progressively chunked or have more information gathered."
>    Queue 6 (google phone as an Insights match key) is now Phase A; the
>    corporate-family accept loop is Phase B; the cockpit moves up to Phase C so
>    the operator can work queues 2 and 4 immediately; Google Place work is
>    Phase D as an explicit *chunking* strategy; domain is Phase E groundwork.
> 2. **New live finding — the 926 were NEVER auto-resolved.** Every row tagged
>    "Potential duplicate… resolve automatically from UBI/name/address/phone
>    lineage before asking a human" is still `pending`. The only automation that
>    has ever resolved ANYTHING in the DB queue is `auto:geo_corroboration`
>    (590 rows, all `google_phone_differs_from_lni`, the geo-promote script).
>    The "resolve automatically" label was a *classification* made by the
>    CSV-era triage tool (`google_place_manual_review_triage.py`); the DB-side
>    resolver it presupposed was never built. `google_place_shared_decision_
>    consolidate.py` is not it — its own docstring says "offline… does not call
>    a web service or database". Phase D now builds that missing resolver.
> 3. **New live finding — queue 6 is UNFUELED, not gated.** Insights holds only
>    **61 distinct party phone numbers** in the whole corpus, and **zero**
>    overlap with registry L&I phones OR registry Google phones (3,596 of
>    which exist registry-side). No gate-tuning can make `binding_google_
>    phone_match` fire; the fuel has to be created. Phase A therefore pairs the
>    match-key activation with its fuel: Google Places enrichment of unbound
>    Insights orgs — the previously-deferred "Phase 4" from the seam roadmap.
>    This is also what the owner means by "it could shift the rest of the
>    queues": enriched org phones → new binding candidates → queue 2 refills
>    with high-quality rows → accepts stamp `registry_ref` → families,
>    rollups, and Google Place corroboration all strengthen.

## Summary
Every review queue in this system exists to build the SAME asset: a
cross-referenced knowledge graph (person ↔ contractor ↔ entity ↔ enterprise ↔
DBA ↔ operating identity: phone/place/domain) that no competitor scraper has,
because every competitor is pulling the same raw L&I feed we are. The graph is
what lets the registry answer "who do I actually contact, and who is the money
flowing to" instead of "here is a business name and a phone number." This plan
(A) creates the phone connective tissue that lets Insights and the registry
recognize the same operation from opposite sides, (B) closes the
corporate-family loop so confirmed relationships flow BACK into the registry,
(C) puts one cockpit in front of all queues with the owner's process order,
(D) chunks the Google Place queue honestly — including building the
auto-resolver that 926 rows have been silently waiting on — and (E) lays the
domain groundwork for when the operational data can fuel it.

## User Story
As the operator, I want the phone/place/relationship lanes actually flowing and
one cockpit showing what genuinely needs my judgment in what order, so every
hour I spend reviewing compounds the graph instead of draining into a queue
that refills identically tomorrow.

## Problem → Solution
Today: the highest-leverage match lane (phone) is structurally dead — 61
Insights phones, zero overlap; corporate-family findings evaporate (read-only);
926 Google Place rows wait on an auto-resolver that was never built; 1,081 more
wait on evidence gathering; two repos' queues have no shared front door. →
Phone fuel + active match lane; relationship accept → registry export;
cockpit with the owner's order (2 → 4 actively; 1, 3 chunked); the missing
auto-resolver built on the geo-promote precedent; domain path documented and
pre-wired but not prematurely activated.

## Metadata
- **Complexity**: **XL** — five independently shippable phases across two repos.
  Implement ONE phase per `/prp-implement` pass, in order (C may run any time).
- **Source**: owner direction 2026-07-24 ("6 first, then 4 and 2; 1, 3, 5
  progressively chunked"; domain strategy: "domain is more related to the
  operation than it is to the entity registration" — Insights will fuel domain
  discovery better than L&I ever could registry-side; deprioritized
  deliberately because many trades have no website) + strategic framing
  2026-07-23 (knowledge-graph differentiation, who-to-contact / how-the-money-
  flows).
- **Estimated Files**: ~28 (12 registry, 16 Insights)
- **Repos**: registry `release/trades-staging`; Insights `claude/tmux-install-320aiz`
- **Builds on**: `corporate-family-tier.plan.md` (completed), geo-promote
  precedent (`auto:geo_corroboration`, 590 resolved), partner staging pipeline
  (`registry_partner` + `ingest-otn-insights.mjs`).

### Verified live inventory (2026-07-24) — the corrected picture
| # | Queue / lane | Where | State | Disposition (owner) |
|---|---|---|---|---|
| 6 | `binding_google_phone_match` (+ `binding_phone_match`) | Insights code lane | **0 ever — UNFUELED: 61 org phones, 0 overlap w/ 3,596 registry google phones or any L&I phone** | **Phase A: fuel + activate FIRST** |
| 4 | Corporate families + principal↔person | `/app/admin/corporate-families` | 217 families / ~100 pairs, read-only | **Phase B: accept → registry export** |
| 2 | Registry review | `/app/admin/registry-review` | 278 pending (254 `binding_name_exact`) | work now; Phase A refills it |
| 1 | Resolution review | `/app/admin/review` | 2,278 pending (proximity_org 1,518 / address_name 717 / parcel_overlap 43) | chunk via existing bulk-triage clusters; cockpit surfaces chunks |
| 3 | Google Place review | registry `registry_google_place_review_queue` | 2,279 pending: **~272 human-ready; 926 awaiting a NEVER-BUILT auto-resolver; 1,081 awaiting evidence-gathering automation**. 590 resolved to date, ALL by `auto:geo_corroboration` | Phase D: build resolver for the 926 + UI for the ~272; 1,081 stays deferred |
| 5 | `binding_domain_match` | Insights code lane | 0 ever — root cause verified: 0/3,797 orgs carry `website`. Deliberate historical deprioritization (many trades have no site) | Phase E groundwork; activation gated on Phase A enrichment coverage |

---

## UX Design

### Before
```
Phone lane: structurally dead. Family findings: evaporate. 926 Place rows:
waiting forever on automation nobody built. Operator: no single front door.
```

### After
```
┌─ /app/admin/cockpit ────────────────────────────────────────────────┐
│ Mission: the graph is the moat (2 lines, dismissible)                │
│ WORK NOW:   2. Registry review   278 (+N from phone lane)  →         │
│             4. Corporate families 217 fam / ~100 pairs  [accept live]│
│ CHUNKED:    1. Resolution review  2,278 → shown as triage clusters   │
│             3. Google Place       272 ready · 926 auto-resolver run  │
│                                   · 1,081 blocked on evidence        │
│ LANES:      6. phone match ACTIVE (n candidates/wk) · 5. domain: gated│
└──────────────────────────────────────────────────────────────────────┘
Data flow added by Phase A:
  unbound org → (existing self-scrape pipeline) → org_enrichment (raw kept)
    → org gains phone/website evidence → binding candidates (review-only)
    → queue 2 → accept → registry_ref → families/rollups/place corroboration
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Unbound org with a Google listing | invisible to matching | phone/website evidence, review-gated candidates | never auto-binds |
| Corporate-families page | read-only | Confirm-relationship per pair | Phase B |
| Google Place 926 | frozen | auto-resolver script (dry-run default) works them down | Phase D |
| Google Place ~272 | Python script | `/app/admin/google-place-review` | Phase D |
| Admin nav | 3 disconnected pages | cockpit + breadcrumbs | Phase C |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `packages/resolution/src/registry-observations.ts` | 61-64, 620-720, 930-976, 1391-1451, 1471-1510 | `OBSERVATION_TYPES`; the phone/google-phone/address/domain match ladder Phase A extends (`PHONE_MATCH_MIN_NAME_SIMILARITY`, `GOOGLE_PHONE_IDENTIFIER_COMPONENT`, the `!hit` precedence); `alias_export` insert shape; decide dispatch; export lane |
| P0 | `<registry>/apps/registry/scripts/geo-corroborated-phone-promote.mjs` | 1-60 | THE precedent for Phase D's auto-resolver: pure gate function, `auto:` actor, dry-run default, in-scope reason constant, idempotency note, rerun-clobber caveat |
| P0 | `<registry>/apps/registry/scripts/entity-resolution/ingest-otn-insights.mjs` | all (143) | loader Phase B adds the `relationship` branch to; invariants in docstring |
| P0 | `<registry>/.../migrations/20260719095534_registry_partner_inbound_staging.sql` | all | partner schema, `otn_insights_writer`, the CHECK to widen |
| P0 | `apps/web/app/api/admin/registry-observations/[id]/decision/route.ts` | all (25) | `withAdmin` + zod + `jsonError` route pattern for every new route |
| P1 | `packages/db/migrations/` + `packages/db/migrations/meta/_journal.json` | — | Insights migrations are HAND-AUTHORED; journal `when` +1000 per idx; NEVER `drizzle-kit generate`. Find next free index at implement time |
| P1 | `apps/web/app/app/admin/corporate-families/page.tsx` | all | dual-repo page pattern (`createRegistryPool()` + `db()`); Orientation panel convention |
| P1 | `packages/resolution/src/registry-link.ts` | 20-22, 243-292 | `RegistryPoolLike`; ladder-degrade discipline (only the expected error code is swallowed) |
| P1 | `<registry>/.../migrations/20260723203000_google_place_review_queue_geo_view.sql` | all | queue columns + the geo view Phase D's resolver and UI read |
| P2 | `packages/resolution/src/entity-corroboration.ts` | all | evidence shape reused verbatim in relationship payloads |
| P2 | `apps/worker/src/schedules.ts` | 137-156 | one pool = reader AND writer in production (see architectural fact) |
| P2 | `packages/db/src/schema.ts` | 78-133 | `rawArtifacts`/`sourceRecords` shape — store-raw-before-parse precedent Phase A's enrichment table mirrors in miniature |

## External Documentation
None — internal patterns and the owner's established Google self-scrape
pipeline. Phase A does NOT introduce new scraping technology or policy; it runs
the registry's existing pipeline over a new input list and ingests its output.

---

## ⚠️ Verified architectural facts (do not re-derive)

1. **`createRegistryPool()` (env `REGISTRY_DATABASE_URL`) is reader AND writer.**
   The `otn_insights` login role is a member of both `otn_insights_reader`
   (SELECT on the two `registry_public` views) and `otn_insights_writer`
   (SELECT/INSERT/UPDATE on the two `registry_partner` tables). Proven in prod
   by `schedules.ts:137-152`. `registry_internal` is unreachable from Insights
   under both roles — which is why Phase D needs a `registry_public` view and a
   registry-side script, not a direct write.
2. **Insights `registry_observations.observation_type` has NO DB CHECK** (type
   union only). The registry's `partner_observations.observation_type` DOES
   (`IN ('alias','trade_evidence')`) — widening it is a migration (Task B2).
3. **Phone-match rules gate on name similarity** (`PHONE_MATCH_MIN_NAME_
   SIMILARITY`) because numbers get recycled — Phase A keeps that gate for
   enrichment-sourced phones, unchanged.
4. **The 590 resolved Place rows all carry `resolution='auto_accepted_geo_
   corroboration'`, `resolved_by='auto:geo_corroboration'`** — the only
   automation precedent, and the shape Phase D's resolver must match.

---

## Patterns to Mirror

### AUTO_RESOLVER_SHAPE (Phase D's new script)
// SOURCE: geo-corroborated-phone-promote.mjs:33-46 — constants block:
```js
const PROMOTION_KEY = "geo_promotion";
const DECIDED_BY = "auto:geo_corroboration";
const IN_SCOPE_REASON = "google_phone_differs_from_lni";
```
Pure gate function ("the single authority on whether a queue row may be
auto-promoted. Pure so the gate is testable without a database; the SQL filters
broadly and this decides"), `--dry-run` default, provenance actor `auto:<key>`,
rerun-clobber caveat documented in the header.

### OBSERVATION_INSERT_SHAPE
// SOURCE: registry-observations.ts:963-976 — `alias_export` insert: typed
observationType, ruleKey, payload, components, `dedupeKey` = `<kind>:<scope>:<key>`.

### DECIDE_ACCEPT_DISPATCH (default fall-through)
// SOURCE: registry-observations.ts:1415, 1443-1450 — export types take NO
branch; `applied` stays `"queued_for_export"`, `applied_at` stays NULL, the
nightly export picks them up.

### PARTNER_LOADER_ADJUDICATE
// SOURCE: ingest-otn-insights.mjs:74-140 — validate entity active → per-type
branch → `ON CONFLICT DO NOTHING` → stable `action` string → stamp
`applied_at`/`applied_action`.

### DECISION_ROUTE
// SOURCE: apps/web/app/api/admin/registry-observations/[id]/decision/route.ts —
`withAdmin<{id}>` + zod body + `jsonError(409, err.message)`.

### CONTRACT_VIEW + RE-GRANT / SKIP_SAFE_READ
// SOURCE: trades_identity_v1 migrations + registry-link.ts ladder — idempotent
`CREATE OR REPLACE`, re-assert ONLY `otn_insights_reader`; reads swallow ONLY
the one expected error code (42703 for a missing column; 42P01 for a missing
view) and rethrow everything else.

### STORE_RAW_BEFORE_PARSE
// SOURCE: rawArtifacts/sourceRecords discipline (schema.ts:78-133, spec §5) —
Phase A's enrichment ingest keeps the full raw row (jsonb) before deriving
phone/website fields; unknown = null, never guessed.

---

## Files to Change

| File | Action | Phase |
|---|---|---|
| `packages/db/migrations/<next>_organization_enrichment.sql` (+ journal) | CREATE | A |
| `packages/db/src/schema.ts` | UPDATE | A |
| `apps/worker/src/cli/org-enrich-export.ts` | CREATE | A |
| `apps/worker/src/cli/org-enrich-ingest.ts` | CREATE | A |
| `packages/resolution/src/registry-observations.ts` | UPDATE | A (evidence + rule), B (export lane) |
| `packages/resolution/src/registry-observations.test.ts` | UPDATE | A, B |
| `apps/web/app/app/admin/registry-review/{page,actions}.tsx` | UPDATE | A (evidence display for new rule) |
| `<registry>/.../migrations/<ts>_registry_entity_relationships.sql` | CREATE | B |
| `<registry>/.../migrations/<ts>_partner_observations_relationship_type.sql` | CREATE | B |
| `<registry>/scripts/entity-resolution/ingest-otn-insights.mjs` | UPDATE | B |
| `apps/web/app/api/admin/corporate-families/relationship/route.ts` | CREATE | B |
| `apps/web/app/app/admin/corporate-families/{page,actions}.tsx` | UPDATE/CREATE | B |
| `packages/intelligence/src/cockpit-summary.ts` (+ test) | CREATE | C |
| `apps/web/app/app/admin/cockpit/page.tsx` | CREATE | C |
| queue pages (breadcrumbs) | UPDATE | C |
| `<registry>/scripts/google-place-lineage-consolidate.mjs` | CREATE | D |
| `<registry>/.../migrations/<ts>_google_place_review_v1.sql` | CREATE | D |
| `<registry>/.../migrations/<ts>_partner_queue_decisions.sql` | CREATE | D |
| `<registry>/scripts/entity-resolution/apply-partner-queue-decisions.mjs` | CREATE | D |
| `packages/resolution/src/google-place-review.ts` (+ test) | CREATE | D |
| `apps/web/app/api/admin/google-place-review/[id]/decision/route.ts` | CREATE | D |
| `apps/web/app/app/admin/google-place-review/page.tsx` | CREATE | D |
| domain-lane wiring + strategy doc | UPDATE/CREATE | E |

## NOT Building
- New scraping technology, new rate policies, or any bypass of access controls —
  Phase A reuses the owner's existing self-scrape pipeline unchanged; Insights
  only produces its input list and ingests its output file.
- Auto-binding from ANY new lane. Enrichment-phone matches, relationships, and
  Place decisions are all review-gated or operator-run. `evaluateStrictBind`'s
  gate is untouched.
- Evidence-gathering automation for the 1,081 "insufficient deterministic
  evidence" Place rows — that is its own future workstream; Phase D only names
  it and keeps those rows visibly separated.
- Domain-match ACTIVATION as a default lane. Phase E wires the evidence path and
  documents the strategy; turning it on is gated on enrichment website coverage
  being demonstrably real (explicit go/no-go query in E1).
- Registry-side admin auth (Place UI lives in Insights, which has it).
- Bulk accept for relationships (private-individual claims stay one-click-one-
  claim).

---

## Step-by-Step Tasks

### PHASE A — Fuel and activate the phone lane

> **⛔ BACKLOGGED (owner decision, 2026-07-24) — do NOT implement.** After A0
> shipped (`d22b41c`) the operator ran it and hit two script stalls
> (`page.evaluate`/hash-only-goto same-document navigation, fixed in `866d44b`)
> AND, on inspecting the yield, a bigger finding: the whole phone-fuel premise
> is worth less to Solis than the cockpit itself. **The entire plan's focus is
> now the QUEUE COCKPIT (Phases B, C, D) — "nail that down before expanding."**
> A0's shipped code stays in the repo (harmless, disabled behind operator-local
> + on_demand) but no further batches are run and A1–A6 are NOT built.
>
> **The deeper reason A0 is low-value right now — the registry L&I pull is
> itself incomplete (investigated 2026-07-24, live numbers):** L&I serves
> **75,364** active contractors; our corpus holds **26,934** (36%). EC 99.7% /
> PC 99.2% complete, but **CC is 28%** — the gap is **48,290 CC:01 "pure
> general" contractors deliberately dropped** by the `--launch-pools-only` flag
> in `ingest-wa-lni-contractors.mjs` (keeps a CC:01 general only if its business
> NAME contains a trade token). That flag was a workaround for a Postgres 53100
> "No space left on device" crash on the materialized-view refresh during the
> 2026-07-04 full load (owner infra gate OTN-14, never lifted). "Southwest
> Plumbing" (`SOUTHWP807OJ`, CC:01, name "SOUTH WEST PLBG…" — "PLBG" misses the
> `/plumb/` rule) is one of the 48k. So enriching Insights→registry via PALS
> licences will keep hitting ~50% registry-coverage misses until the registry
> itself is fully loaded. **The proper fix is a full-corpus L&I reload
> (decouple the raw ingest from the disk-heavy public MV refresh; verify current
> instance sizing) — a SEPARATE owner-gated PRP, not this one.** Recorded for
> later; not to be started without owner go-ahead.

> **Fuel verdict (verified 2026-07-24, all 18,530 source records):** the phones
> are NOT being dropped by parsers — they are absent from the feeds. The only
> structured phone field in any source is `wa_sepa.leadagencycontactphonenumber`
> (572 rows, agency desk numbers — parsed correctly, useless as a contractor
> key; they ARE the 61). Pierce's 121 phone-shaped values live inside free-text
> `workDescription` (event/emergency contacts, often individuals' cells —
> attribution too murky to use as org evidence). Contractor LICENSE numbers:
> zero in every feed, structured or in-text — jurisdictions collect them at
> intake but do not publish them in the extracts. The feeds publish contractor
> NAMES only. Hence A0 (licenses, one hop away) and A1-A6 (Google enrichment).

### Task A0: PALS `contrLicNum` hydration — measure, then STOP for owner decision
- **ACTION**: `fixtures/pierce_pals_contractor/` (captured 2026-07-19) proves
  the Pierce PALS permit-header endpoint returns **`contrLicNum` — the
  authoritative contractor license number** — for a known `applPermitId`.
  Pierce is the LARGEST source (6,145 records). A license number is a STRONG
  key: it lands in `organizations.contractor_registration` and the existing
  `linkRegistry` lane binds it DETERMINISTICALLY (`contractor_number_exact`,
  no review row, no new match rule) — categorically stronger fuel than any
  phone. This task is measure-first: run a LOW-VOLUME sample (~50 known Pierce
  permits, stratified by permit type, honoring the capture discipline
  documented in the fixture metadata verbatim — genuine-visitor flow, no
  bot-gate bypass, known-permits-only) and report `contrLicNum` non-null rate
  by permit type (the opened fixture, an owner-performed church repair, has
  None — exempt/owner work won't carry one; commercial fixtures do, e.g. the
  Lennar example in metadata).
- **GOTCHA — HARD STOP built into the task**: the PALS Terms of Use (recorded
  verbatim in `fixtures/pierce_pals_contractor/metadata.json`) restrict
  commercial use of lists of INDIVIDUALS and state the system's intended
  county-staff use. Lookup-class rules already apply (source-adapter skill:
  "enrich known records only, never the sole alert source"). Scaling beyond
  the measurement sample is an OWNER DECISION on ToU posture and volume —
  present the yield numbers and stop. Do not build the full adapter in this
  task.
- **VALIDATE**: yield report exists (non-null rate by permit type, projected
  deterministic-bind count against the registry's contractor_number index);
  owner go/no-go recorded before any Phase A follow-up work on this lane.

### Task A1: `organization_enrichment` table (Insights migration)
- **ACTION**: Hand-authored migration at the NEXT free index (check
  `packages/db/migrations/meta/_journal.json`; `when` = prior +1000):
  `organization_enrichment (organization_id uuid PK REFERENCES organizations(id),
  provider text NOT NULL DEFAULT 'google_maps', external_place_id text,
  phone_normalized text, website text, root_domain text, address_raw text,
  rating numeric, review_count int, raw jsonb NOT NULL,
  source_run_id text NOT NULL, retrieved_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())`
  plus `CREATE INDEX organization_enrichment_phone_ix ON organization_enrichment
  (phone_normalized) WHERE phone_normalized IS NOT NULL`. Mirror drizzle table in
  `schema.ts`.
- **MIRROR**: STORE_RAW_BEFORE_PARSE — `raw` holds the untouched scraper row;
  derived columns are parsed FROM it and re-derivable.
- **GOTCHA**: one row per org (PK = organization_id), upsert on re-ingest with
  `updated_at = now()`. `phone_normalized` = digits only (same treatment as
  `entity-corroboration.ts`'s `digits()`); `root_domain` derived from `website`
  at ingest so Phase E reads a stable column, not a URL parse at query time.
- **VALIDATE**: migration applies to local test DB via the harness; duplicate
  upsert leaves one row.

### Task A2: `org-enrich-export` CLI — the scraper's input list
- **ACTION**: `apps/worker/src/cli/org-enrich-export.ts` — write a CSV/JSONL of
  `(organization_id, canonical_name, city_hint)` for UNBOUND orgs
  (`registry_ref IS NULL`), where `city_hint` = the org's most frequent
  `projects.permitting_jurisdiction` (ties → most recent). EXCLUDE person-shaped
  names using `personCoreKey` + the index surname set when a registry pool is
  available (privacy + relevance: we enrich BUSINESSES; a sole-proprietor human
  is the principal lane's job, not a Places lookup target). `--limit=N` default
  500, deterministic ORDER BY so batches are stable and resumable.
- **MIRROR**: existing CLI shape in `apps/worker/src/cli/` (e.g.
  `alias-backfill.ts` / `brand-backfill.ts` — logger, env, visible skip states).
- **VALIDATE**: dry output includes no person-shaped names; rerun with same args
  is byte-identical (determinism).

### Task A3: run the EXISTING registry self-scrape pipeline (operator step, not code)
- **ACTION**: documented runbook step, not new code: feed A2's list to the
  registry's established `google_maps_place_self_scraper.py` pipeline (same
  environment, cadence, and discipline it already runs under). Output lands as a
  file for A4.
- **GOTCHA**: this plan does NOT modify the scraper. If its input format needs a
  header tweak, adapt A2's output to the scraper — never the reverse.
- **VALIDATE**: a batch of ≥100 unbound orgs produces an output file with
  place_id/phone/website columns populated where Google has them.

### Task A4: `org-enrich-ingest` CLI
- **ACTION**: `apps/worker/src/cli/org-enrich-ingest.ts --file=<path> [--dry-run]`
  — parse the scraper output, match rows back by `organization_id` (carried
  through the pipeline via A2's list), store raw + derived columns into
  `organization_enrichment` (upsert). Reject rows whose organization_id is
  unknown; count and report `noResult` rows (Google had nothing) WITHOUT writing
  fabricated empties — absent listing = no row, not a null-stuffed row.
- **MIRROR**: DERIVE_FROM_LNI_SCRIPT discipline (dry-run default reporting,
  JSON summary, idempotent rerun adds 0).
- **VALIDATE**: rerun on the same file inserts 0 new rows; a row with a bogus
  org id is reported and skipped.

### Task A5: enrichment phones enter the match ladder (review-only)
- **ACTION**: in `generateRegistryObservations` (registry-observations.ts):
  where each org's `phones` evidence set is built, UNION in
  `organization_enrichment.phone_normalized` for that org, tagged by source.
  Add rule key **`binding_enrichment_phone_match`** for hits where the
  enrichment phone equals a registry **L&I** phone (cross-system agreement —
  the strong direction), and let enrichment phones also feed the existing
  `binding_google_phone_match` path (google↔google, DE-RATED — both sides could
  descend from the same Google listing, so agreement is weaker evidence).
  Payload gains `phone_evidence_sources` (e.g. `["party","google_enrichment"]`)
  and `enrichment_place_id` so the reviewer can see WHERE the number came from,
  with the org's Google listing citable next to the registry's L&I page.
- **MIRROR**: the existing google-phone branch (lines 657-677) — "distinct rule
  key so it earns its own reviewed accept history" is the established rationale;
  follow it. Name-similarity gate (`PHONE_MATCH_MIN_NAME_SIMILARITY`) applies
  unchanged. `!hit` precedence order: L&I party-phone paths first, then
  enrichment-phone vs L&I phone, then google-phone paths — strongest evidence
  claims the match first.
- **GOTCHA**: governance unchanged — `binding_name_match`-type observations NEVER
  auto-accept regardless of rule; `evaluateStrictBind` is not touched; a phone
  is corroboration for a reviewed bind, not an auto-bind key. ALSO: do not let
  enrichment phones feed the `phone_adoption` lane (that lane offers REGISTRY
  phones to orgs; offering an org its own scraped phone back is circular).
- **VALIDATE**: unit — org with enrichment phone matching a registry L&I phone
  and name sim ≥ gate → ONE `binding_enrichment_phone_match` candidate,
  review-only; same phone but name sim below gate → nothing; bound orgs →
  nothing (only `registry_ref IS NULL` orgs generate binding candidates,
  existing behavior).

### Task A6: evidence display for the new rule
- **ACTION**: `registry-review/{page,actions}.tsx` — `extractEvidence` +
  `Evidence()` learn `phone_evidence_sources` / `enrichment_place_id`; the
  describe() line for `binding_enrichment_phone_match` reads "phone from the
  org's own Google listing agrees with L&I". Lesson from the brand-phone bug
  (recorded in memory): a payload field that isn't plumbed into EvidenceView
  sits invisible for a session — plumb it in the SAME task that creates it.
- **VALIDATE**: a seeded candidate renders the source tag and both citation
  links; `next build` clean.

---

### PHASE B — Corporate-family accept → registry relationship export (owner priority #2)

*(Carried from v1 unchanged in substance; renumbered. Full task text retained.)*

### Task B1: `registry_entity_relationships` table *(registry)*
- **ACTION**: Migration: `registry_internal.registry_entity_relationships
  (entity_id_a uuid, entity_id_b uuid, relationship_type text NOT NULL DEFAULT
  'principal_shared', principal_key text, confidence numeric, evidence jsonb NOT
  NULL DEFAULT '{}', source text NOT NULL DEFAULT 'otn_insights', created_at
  timestamptz DEFAULT now())`, `PRIMARY KEY (entity_id_a, entity_id_b,
  relationship_type)`, CHECK `entity_id_a < entity_id_b` (canonical ordering),
  CHECK `relationship_type IN ('principal_shared')`, both FKs ON DELETE CASCADE
  to `registry_business_entities`, index on `entity_id_b`, RLS enabled.
- **MIRROR**: `registry_entity_aliases` DDL (20260706121331:229-251).
- **VALIDATE**: inserting `(b, a, …)` with `b > a` violates the CHECK.

### Task B2: widen the `partner_observations` CHECK
- **ACTION**: DROP + re-ADD the constraint as `IN ('alias', 'trade_evidence',
  'relationship')`; update the table comment with the relationship payload shape
  `{entity_id_b, relationship_type, principal_key, confidence, evidence}`.
- **VALIDATE**: row count identical before/after; a test 'relationship' insert
  succeeds (rolled back).

### Task B3: loader `relationship` branch
- **ACTION**: add to `adjudicate()` in `ingest-otn-insights.mjs`: validate
  `entity_id_b` present, ≠ entity_id, active; sort pair canonically (the SORT
  decides storage order — never assume `obs.entity_id == entity_id_a`
  downstream); duplicate → `skipped:duplicate_relationship`; insert with source
  'otn_insights'; return `relationship_added`.
- **MIRROR**: PARTNER_LOADER_ADJUDICATE.
- **VALIDATE**: dry-run on a seeded row → `relationship_added`; rerun →
  `skipped:duplicate_relationship`; unknown entity_b → skipped, no write.

### Task B4: widen the Insights export lane
- **ACTION**: add `"relationship_export"` to `OBSERVATION_TYPES`; widen
  `exportRegistryObservations`'s filter (line ~1488) and type mapping (~1491):
  third arm → `"relationship"`.
- **VALIDATE**: typecheck clean; existing tests pass (superset union).

### Task B5: `recordRelationshipAcceptance`
- **ACTION**: new exported function in registry-observations.ts — direct INSERT
  of an already-`accepted` `relationship_export` row (the human decision and the
  observation's creation are the same click; there is no prior pending row).
  `dedupeKey` = `relationship:<sortedA>:<sortedB>`; payload carries explicit
  `entity_id_a`/`entity_id_b`/`principal_key`/`confidence` (= corroboration
  points) and the full `EntityCorroboration` as evidence; `applied_at` NULL ⇒
  nightly export picks it up. `ON CONFLICT (dedupe_key) DO NOTHING`, return
  `{id, alreadyExisted}`.
- **GOTCHA**: `organization_id` is NOT NULL on registry_observations — the
  caller anchors on ONE bound Insights org (prefer entity A's); it is
  provenance ("who clicked from"), the payload is the claim.
- **VALIDATE**: unit — argument order does not change the dedupe key; replay
  returns `alreadyExisted: true` with no duplicate.

### Task B6: relationship decision route
- **ACTION**: `apps/web/app/api/admin/corporate-families/relationship/route.ts` —
  POST, `withAdmin`, zod `{organizationId, registryEntityIdA, registryEntityIdB,
  principalKey nullable, corroboration (opaque json — already validated by
  `corroborateEntities`'s return type Insights-side)}`.
- **MIRROR**: DECISION_ROUTE.
- **VALIDATE**: 401 unauthenticated; 400 malformed; success then
  `alreadyExisted` on replay.

### Task B7: accept buttons on the corporate-families page
- **ACTION**: `actions.tsx` client component `ConfirmRelationshipButton`, used on
  family-pair disclosure rows AND principal↔person rows. Family pair anchor org:
  entity A's bound org, else B's, else DISABLED with tooltip ("no Insights
  organization bound to either company yet"). Success state: green badge
  "confirmed — queued for registry export" (nightly-export language, not an
  instant-write claim). **No button on `contradicted` pairs** — one click must
  not override a middle-initial conflict; `name_only` shows a de-emphasized
  button.
- **VALIDATE**: manual accept on a strong pair → observation row with
  `relationship:` dedupe key; replay shows confirmed, no duplicate.

---

### PHASE C — Cockpit shell (any time; before D helps the operator now)

### Task C1: `cockpit-summary.ts`
- **ACTION**: `queueSummary(db, registryPool)` returning
  `{resolutionReview: {total, clusters: top-5 of triageReviewQueue},
  registryReview: {total, byRule}, families: {count, pairsNew, pairsStrong},
  googlePlace: {actionable, awaitingAutoResolver, awaitingEvidence} | null,
  lanes: {enrichmentPhoneCandidates30d, domainGated: true}}`.
  `googlePlace` is **null** (never zeroed) without a registry pool. Reuse
  `triageReviewQueue`/`listPendingReviews`/existing group-bys — one canonical
  count source, no page-local drift.
- **MIRROR**: rollup options-object shape; unknown = null discipline.
- **VALIDATE**: unit — null pool ⇒ `googlePlace: null`.

### Task C2: `/app/admin/cockpit`
- **ACTION**: landing page. Mission statement (dismissible `<details open>`,
  Orientation-panel convention). Sections in the OWNER'S order:
  **Work now** — 2 (registry review; note "+N phone-lane candidates" once
  Phase A ships) and 4 (families). **Chunked** — 1 shown AS ITS TRIAGE CLUSTERS
  (top patterns with counts + bulk-decision link), not as a raw 2,278; 3 shown
  as three explicit chunks (272 ready / 926 auto-resolver / 1,081 evidence).
  **Lanes** — 6 active (candidates last 30d), 5 gated with one-line reason.
- **VALIDATE**: unauth redirect; renders with `REGISTRY_DATABASE_URL` unset
  (registry sections degrade to "seam offline", never fake zeros); build clean.

### Task C3: breadcrumbs
- **ACTION**: "← cockpit" on review, registry-review, corporate-families, and
  (when built) google-place-review. Keep existing cross-links.
- **VALIDATE**: click-through both directions.

---

### PHASE D — Google Place queue, chunked (owner: "progressively chunked")

### Task D1: `google-place-lineage-consolidate.mjs` — the resolver the 926 have been waiting on
- **ACTION**: NEW registry-side script working the `Potential duplicate…`
  cohort. Investigation-first inside the same task: the triage classifier
  (`google_place_manual_review_triage.py`) documents WHICH lineage relationships
  it saw (same UBI, same address, same phone, name-DBA overlap) — port those
  deterministic checks into a pure gate function over the queue row's payload +
  current DB state (e.g. `payload.match.conflict_flags` like
  `place_id_multiple_lni`; shared UBI across the licenses claiming one Place ⇒
  same legal entity ⇒ canonicalize links, resolve row `auto_accepted_lineage`;
  genuinely different UBIs sharing a Place with no lineage ⇒ LEAVE PENDING and
  tag for the human queue). Actor `auto:lineage_consolidation`; dry-run default;
  per-decision `resolution_payload` recording exactly which lineage rule fired.
  **Anything the gate cannot decide deterministically stays pending — the
  script shrinks the 926, it does not zero it by force.**
- **MIRROR**: AUTO_RESOLVER_SHAPE (geo-promote precedent, including the
  rerun-clobber caveat: `google_place_db_stage_import.mjs` upserts queue status
  — a CSV re-import can revert resolutions; the script is idempotent, rerun it
  after any import).
- **VALIDATE**: dry-run reports per-rule would-resolve counts; live run then
  rerun applies 0; spot-check 10 resolved rows against L&I by hand before
  trusting the cohort.

### Task D2: `registry_public.google_place_review_v1` (+ blocked-summary sibling)
- **ACTION**: contract view over `status='pending'` EXCLUDING the two
  automation-tagged reasons (verbatim strings), joined to entity name/UBI;
  sibling view `google_place_review_blocked_summary_v1` returning `reason,
  count(*)` for the excluded rows (the canary + the honest "these exist"
  display without exposing unvetted payloads). GRANT both to
  `otn_insights_reader` only.
- **MIRROR**: CONTRACT_VIEW + RE-GRANT.
- **GOTCHA**: reason-string drift silently un-excludes — the canary count in the
  UI (D6) is the safeguard, not the WHERE clause.
- **VALIDATE**: view count ≈ live human-ready count (recompute at implement
  time — D1 will have shrunk the 926 cohort and possibly re-tagged rows);
  `anon` still has no USAGE.

### Task D3: `registry_partner.partner_queue_decisions`
- **ACTION**: as v1 — identity PK, `queue_type` default 'google_place',
  `resolution` CHECK, `dedupe_key` = `google_place:<review_id>` UNIQUE,
  `applied_at`/`applied_action`, GRANT to `otn_insights_writer`.
- **VALIDATE**: writer can INSERT; duplicate dedupe_key rejected.

### Task D4: `apply-partner-queue-decisions.mjs`
- **ACTION**: registry-side applier: pending decisions → `UPDATE … SET
  status='resolved' … WHERE review_id=$1 AND status='pending'` (already-resolved
  ⇒ `skipped:already_resolved`, never overwritten — D1's resolver may have got
  there first); stamp `applied_at`/`applied_action`.
- **MIRROR**: AUTO_RESOLVER_SHAPE loop + PARTNER_LOADER_ADJUDICATE stamping.
- **VALIDATE**: dry-run; idempotent rerun.

### Task D5: `google-place-review.ts` (Insights fetch)
- **ACTION**: `fetchGooglePlaceReviewRows(pool)` + blocked-summary fetch; swallow
  ONLY `42P01` → `[]` (deploy-order degrade), rethrow everything else; parse
  `payload.lni`/`payload.match`/`payload.google` sub-objects, pass the rest as
  `raw`.
- **MIRROR**: SKIP_SAFE_READ; `RegistryPoolLike` reused, not redefined.
- **VALIDATE**: unit — 42P01 ⇒ `[]`; other codes rethrow.

### Task D6: decision route + page
- **ACTION**: route — POST `withAdmin`, `Number(review_id)` validated, INSERT to
  `partner_queue_decisions` via `createRegistryPool()`, **explicit 503 when the
  pool is null** (first interactive route to need it — a batch-style silent skip
  would strand the operator). Page — `/app/admin/google-place-review`:
  Orientation panel (what claim is being judged); L&I columns vs Google columns
  with `website`/`maps_url` as real links (`target="_blank"
  rel="noreferrer noopener"`); reason badge; decide buttons; below, the
  blocked summary ("N awaiting auto-resolver run · M awaiting evidence
  gathering — not human decisions yet") sourced from the sibling view as the
  canary.
- **MIRROR**: DECISION_ROUTE; registry-review page structure;
  corporate-families Orientation convention.
- **VALIDATE**: unauth redirect; idempotent double-decide (ON CONFLICT ⇒ still
  200); page's actionable count matches D2's view; build clean.

---

### PHASE E — Domain lane groundwork (owner: valuable later, fueled by Insights)

### Task E1: wire enrichment websites into domain evidence — behind a go/no-go
- **ACTION**: extend the org `domain_evidence` collection in
  generateRegistryObservations to read `organization_enrichment.root_domain`.
  GATED: before enabling, run the go/no-go query — `SELECT count(*) FROM
  organization_enrichment WHERE root_domain IS NOT NULL` and its overlap with
  registry `root_domain` identifiers (105 exist today). If overlap < 5, leave
  the wiring behind a disabled flag and record the number — activation without
  fuel is how lane 6 spent months silently dead; do not repeat that with lane 5.
- **MIRROR**: A5's evidence-source tagging (`domain_evidence_sources`).
- **VALIDATE**: with the flag on in tests: enrichment domain matching a registry
  root_domain + name gate ⇒ ONE review-only `binding_domain_match` candidate.

### Task E2: strategy note
- **ACTION**: `.claude/PRPs/reports/queue-cockpit-domain-lane-finding.md` —
  record: root cause (0/3,797 org websites; L&I carries no operational web
  presence), the deliberate early deprioritization (many trades have no site),
  and the owner's direction verbatim: Insights should fuel domain discovery
  because "domain is more related to the operation than it is to the entity
  registration" — the dependency chain is Phase A enrichment → website/root_
  domain coverage → E1 go/no-go → activation. Include the C2-style
  google-phone finding (61 phones, 0 overlap) as the cautionary precedent.
- **VALIDATE**: file exists; no code change.

---

## Testing Strategy

### Unit (no DB)
| Test | Expected |
|---|---|
| A5: enrichment phone = L&I phone, name ≥ gate | one `binding_enrichment_phone_match`, review-only |
| A5: name below gate | nothing |
| A5: enrichment phone feeds nothing when org already bound | nothing |
| A2 export: person-shaped org name | excluded from scrape list |
| B5 dedupe: (A,B) vs (B,A) | same key |
| D1 gate function: shared-UBI case | resolvable; different-UBI-no-lineage | stays pending |
| D5: 42P01 | `[]`; other error | rethrow |
| C1: null registry pool | `googlePlace: null`, never zeros |

### Integration (testDb)
| Test | Expected |
|---|---|
| A4 ingest rerun | 0 new rows |
| B route fresh/replayed | row created / `alreadyExisted`, count unchanged |
| B4 export widened | accepted `relationship_export` exported alongside alias/trade |
| D6 decision route replay | ON CONFLICT no-op, 200 |

### Edge Cases Checklist
- [ ] Org with Google listing but no phone → website stored, no phone evidence, no fabricated empty
- [ ] Family pair, neither entity bound → disabled button, not broken
- [ ] `contradicted` pair → no accept button at all
- [ ] Place decision with `REGISTRY_DATABASE_URL` unset → 503, not 500
- [ ] D2 canary count matches blocked reality after D1 shrinks the cohort
- [ ] Partner CHECK widen rejects no existing row

---

## Validation Commands

### Insights
```bash
pnpm -r run typecheck && PG_PORT=5433 docker compose up -d postgres && pnpm exec vitest run
```
EXPECT: 848 baseline + new, green. Run 3×.

```bash
pnpm --filter @otn/web build
```
EXPECT: clean; `/app/admin/cockpit` and `/app/admin/google-place-review` listed as ƒ.

### Registry
```bash
node apps/registry/scripts/google-place-lineage-consolidate.mjs --dry-run
node apps/registry/scripts/entity-resolution/apply-partner-queue-decisions.mjs --dry-run
node apps/registry/scripts/entity-resolution/ingest-otn-insights.mjs --dry-run
```

### Governance assertions
```sql
SELECT has_schema_privilege('anon','registry_public','USAGE') AS must_be_false;
SELECT count(*) FROM registry_partner.partner_observations;  -- unchanged by B2
```

### Manual
- [ ] Phase A end-to-end: unbound org → scrape batch → ingest → candidate in
      queue 2 with "phone from the org's own Google listing agrees with L&I"
- [ ] Phase B end-to-end: accept strong pair → nightly export →
      `ingest-otn-insights.mjs --dry-run` reports `relationship_added`
- [ ] Phase D: dry-run consolidator per-rule counts; hand-verify 10 against L&I
- [ ] Cockpit shows the owner's order and true chunk counts

---

## Acceptance Criteria
- [ ] Phone lane FUELED and ACTIVE: enrichment rows exist, ≥1 real
      `binding_enrichment_phone_match` candidate reaches queue 2, review-only
- [ ] Relationship accepts export via the widened EXISTING pipeline
- [ ] The 926 cohort is shrunk by a deterministic, provenance-stamped,
      idempotent resolver — remainder honestly re-tagged for human review
- [ ] ~272-row Place UI live; 1,081 evidence-blocked rows visible but inert
- [ ] Cockpit reflects the owner's process order with live counts
- [ ] Governance unchanged: nothing auto-binds, no principal/relationship is a
      match key, `anon` gains nothing, `registry_internal` stays unreachable
      from Insights

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Scrape coverage for small trades orgs is thin → Phase A yields few candidates | Med | Med | A3 runs a ≥100-org pilot batch first; yield measured before scaling; even modest yield refills queue 2 with the highest-quality rule yet |
| Google↔Google phone agreement overweighted (same-source echo) | Med | Med | A5 de-rates it explicitly; L&I-agreement rule is the strong one; both review-only |
| D1 resolver mis-consolidates a genuine two-owner shared Place | Low | High | deterministic lineage rules only; undecidable stays pending; 10-row hand-verify gate before trusting the cohort |
| Reason-string drift un-excludes blocked rows | Med | High | D2 sibling canary view + D6 on-page count |
| XL sprawl | High if rushed | High | five phases, one per `/prp-implement` pass, each independently valuable |

## Notes
- Implement order **REVISED 2026-07-24: A is BACKLOGGED (see the Phase A banner);
  active order is C → B → D.** C (the cockpit shell / front door) is the direct
  Solis value and now leads; B (family accept → registry export) closes the loop;
  D (Google Place UI + the 926-row auto-resolver) surfaces the one queue with no
  UI. E (domain) stays deferred behind the backlogged enrichment. Original
  A→B→C→D→E ordering assumed phone-fuel came first; owner reprioritized to the
  cockpit itself.
- Insights migrations: hand-authored + hand-maintained journal (`when` +1000);
  registry migrations: applied by file, verified by querying the object (no
  ledger). Both established this session and unchanged.
- **Confidence: 7/10.** Everything that was assumption in v1 is now measured
  (926 untouched; 61/0 phone fuel; the sole `auto:` precedent). The residual
  risk concentrates in two places: Phase A's real-world scrape yield for small
  trades (unknowable until the pilot batch) and D1's lineage-rule port from the
  CSV-era classifier (investigation-first inside the task). Neither blocks the
  other phases.
