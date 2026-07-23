# Cross-platform identity graph — strategy (2026-07-23)

**Generic (pre-code) plan.** How to elevate the linkage between OTN Insights
(permits / projects) and the Trades registry (WA L&I entities) into a single
**knowledge map** of how projects ↔ companies ↔ contractors ↔ UBIs connect.
A follow-up PRP will turn the chosen phases into code specifics.

> Scope spans BOTH repos: the **registry** (L&I ingest + `registry_public`
> contract views) and **Insights** (`packages/resolution`, the binding/observation
> loop, org enrichment). Task C (strict-tier auto-bind) shipped the first link
> type; this generalizes it.

---

## 1. The goal, in one sentence

Every Insights organization should resolve to its canonical registry entity
(UBI-anchored), and every match should **propagate identifiers** so the next
record links automatically — turning a pile of name guesses into a
multi-signal, self-reinforcing identity graph.

## 2. Why this matters now (verified state, 2026-07-23)

- **Binding is thin:** 3,797 Insights orgs, **20 bound** (19 strict-auto + Solis).
  243 candidates pending review; 233 of them are exact-name / different-city
  (tier2) with no second signal to promote them.
- **The join keys are starved on the Insights side:** of 9,608 permit party
  entries, only **327 carry an address** and **77 a phone**; `organization_identifiers`
  already holds 58 phone / 128 address (most of what exists is mined).
  `organization_aliases` = 0. No Google Places identity on the Insights side.
- **The registry side is rich but one-dimensional for names:** L&I phone 99.95%,
  `google_phone`/`google_rating` present, `registered_address` 100%, `trade_codes`
  92%, `root_domain` lane exists — BUT `registry_entity_aliases` = 0 and the L&I
  ingest captured **no DBA/tradename column** (searched every column in the DB).
- **Matching machinery already exists** (`registry-observations.ts`): name / L&I
  phone / Google phone / registered-address / root-domain indexes, with
  unique-only + poison-on-collision guards. The gap is **fuel** (identifiers to
  match on) and **propagation** (turning one match into linked strong keys), not
  the matcher skeleton.

**Conclusion:** the leverage is in (a) filling the join keys and (b) letting a
match on ANY key propagate the UBI/contractor# so identity becomes transitive.

## 3. The model — a multi-key identity graph with transitive propagation

Nodes: Insights `organizations`, registry `entities`, and the projects/permits
that reference them. Edges: **equivalence evidence** keyed on any of the signals
below. The anchor edge is `organizations.registry_ref → entity_id` (already the
binding). Everything else is evidence that creates or corroborates that edge.

The transitive rule (the "knowledge map" the request describes):

> If an Insights org shares **any** trusted key (phone / address / domain /
> place / DBA / UBI / contractor#) with a registry entity, bind them AND stamp
> the entity's strong keys (UBI, contractor#) onto the org. Then every other
> Insights record carrying that UBI or a known name-variant links automatically
> on the next pass.

Task C already does the last step for *accepted* binds (`backfeedAcceptedIdentity`
writes UBI/contractor# with `provenance='registry_accept'`). Generalizing it to
fire on cross-signal matches is the core of this plan.

## 4. The signals (join keys) and where each is sourced

| Signal | Insights source | Registry source | Today |
|---|---|---|---|
| Legal name (normalized) | `canonical_name` | `canonical_name_normalized` | used (crossNameKey) |
| **DBA / trade name** | permit name-variants | **L&I DBA (not yet ingested)** | **gap both sides** |
| UBI | org.ubi (≈0) | `ubi` 100% | strong-key; Insights starved |
| Contractor # | org.contractor_registration (rare) | `contractor_numbers` | strong-key; rare on Insights |
| Phone | id `phone` (58) + party phone (77) | L&I `phone` 99.95% + `google_phone` | matcher exists; Insights thin |
| Address | id `address` (128) + party address (327) | `registered_address` 100% | matcher exists; thin |
| Website / root domain | id `root_domain` (≈0) | `root_domain` lane | matcher exists; both thin |
| **Google Place** (place_id, phone, addr, rating, website) | **none — needs Places enrichment** | `google_phone`/`google_rating` present | not on Insights side |

## 5. The enrichment sources (to FILL the keys)

1. **Permit-array mining (Insights, free):** the `organizations` array already
   carries party name-variants + the 327 addresses / 77 phones. Backfill into
   `organization_identifiers` + `organization_aliases`.
2. **L&I DBA ingest (registry, authoritative):** extend the L&I ingest to capture
   DBA/tradenames → `registry_entity_aliases`; surface on the contract view so
   Insights can match a permit name against a registry DBA, not just the legal name.
3. **Shared normalization SoT:** one canonical normalizer for name / phone /
   address / domain used (or mirrored deterministically) by BOTH systems, so
   "LLC/Inc/&/punctuation" never causes a miss OR a spurious exclude.
4. **Google Places enrichment (Insights, external):** for unbound orgs, fetch
   place_id / phone / canonical address / website / rating → new keys to match
   back to the registry.

## 6. Phased roadmap (leverage-per-cost order)

Each phase adds edges to the graph and states its **decision** + **risk**.

### Phase 0 — Shared normalization (prerequisite, cheap)
- One canonical normalizer for name (legal-suffix/`&`/punctuation folding),
  phone (E.164/10-digit), address (USPS-style), domain (root + denylist), reused
  across both systems so keys can't drift.
- **Why first:** every later match quality depends on it; it directly fixes the
  "expecting/excluding LLC" problem.
- **Decision:** shared package vs mirrored-deterministic implementations (the seam
  is read-only, so likely mirror the registry's normalizer in Insights and pin it
  with a cross-system equality test).
- **Risk:** low. Over-normalization can merge genuinely-distinct names — guard with
  the existing "distinctive token required" rule.

### Phase 1 — Mine existing data (cheap, no external calls)
- Permit-array → `organization_identifiers` (addresses/phones) + `organization_aliases`
  (name-variants), with per-record provenance.
- Fold each contractor's **business-address city** (from the party address) into
  the locality signal — this is what actually splits tier2 for orgs that have an
  address (a Tacoma plumber's business city corroborates the Tacoma registry
  entity even when the permit job is elsewhere).
- **Outcome:** more binding candidates + tier upgrades from data we already hold.
- **Risk:** low; bounded by the 327/77 that exist. Honest ceiling — most of tier2
  still won't split until Phase 4.

### Phase 2 — L&I DBA ingest (registry side, authoritative)
- Extend the L&I ingest to capture DBA/tradenames → `registry_entity_aliases`;
  add `trades_aliases_v1` (or an `aliases` column) to the contract so Insights
  matches against DBAs.
- **Decision:** does the L&I source we ingest actually expose DBA/tradename? Must
  verify at the source before committing (it's not in the current dataset).
- **Risk:** medium — depends on L&I source fields + a re-ingest; scope the
  incremental-vs-full ingest in the PRP.

### Phase 3 — Cross-signal matching + transitive propagation (the knowledge map)
- With keys filled (Phase 1/2), run bidirectional matching on phone / address /
  domain / DBA; on a trusted match, bind AND propagate UBI/contractor# onto the
  org (generalize `backfeedAcceptedIdentity`). Confidence tiers/gates
  (`evaluateStrictBind` + `classifyReviewTier`) decide auto-bind vs review.
- This is the "phone appears in Insights → find the Trades entity → link the UBI"
  loop, made transitive so linked orgs pull in their siblings.
- **Decision:** which cross-signal combinations earn AUTO-bind vs review (e.g.
  unique-L&I-phone + name-corroboration as a new strict tier).
- **Risk:** medium-high — phone recycling / shared call-tracking numbers and
  transitive runaway can contaminate the graph. Mitigate with the existing
  unique-only + poison-on-collision guards, explicit provenance, confidence
  gates, and reversibility (Task C's pattern).

### Phase 4 — Google Places enrichment (external, FREE-only, biggest unlock)
- For **all unbound orgs**, enrich via Places using the registry's already-proven
  **zero-cost technique** (owner, 2026-07-23): call only the basic Places **text
  search** to pull the **place_id** (free), reconstruct the business URL from the
  id, then do our OWN lookup to pull the place details — never the paid Details
  API. This was already built for the registry and is repeatable for Insights.
  Yields place_id / phone / canonical address / website / rating → match back to
  the registry (phone / address / name).
- **Decisions (resolved 2026-07-23):** scope = **all ~3,777 unbound** orgs;
  **free-only, no paid** API tiers; human-review gate for Places-derived binds.
- **Risk:** rate limits + ToS/caching only (no spend). Registry/L&I stays the
  identity authority — Places is corroboration, never overwrites L&I (mirrors the
  `google_phone` rule). Reuse the registry's existing free-lookup code as the
  reference implementation.

### Phase 5 — Feedback loop + surfacing (mostly exists)
- `alias_export` already feeds Insights-discovered aliases back to the registry
  (fires for bound orgs — now growing). `partner_project_facts` already surfaces
  project activity on registry profiles; the Insights opportunity already shows
  registry identity/license/rating. Each new match propagates keys → the next
  pass is smarter. This phase is verification + surfacing, not new plumbing.

## 7. Cross-cutting principles (carry from Task C)

- **Registry/L&I is the identity authority.** Insights + Places corroborate; never
  overwrite L&I values.
- **Unknown = null, never guessed.** No fabricated identifiers or consent.
- **Every edge has provenance + is reversible.** Confidence gates decide
  auto-vs-review; softer stays in the human queue.
- **Person-vs-business gate** and the unique-only/poison guards stay in force.

## 8. Open decisions for you (the point of this generic pass)

1. **Graph home:** keep Insights-side `registry_ref` + propagated keys as the graph
   (recommended — no new store), or a dedicated equivalence table?
2. **Auto-bind expansion:** which cross-signal combos join the strict auto-bind tier
   vs stay in review?
3. **L&I DBA availability:** verify the L&I source exposes DBA before Phase 2.
4. **Google Places budget + ToS/caching** and enrichment scope (all unbound vs tier2).
5. **Sequencing:** proposed **0 → 1 → 3 (partial) → 2 → 4**, i.e. normalize + mine +
   propagate on existing data first (cheap, immediate), then L&I DBA, then Places
   last. Confirm or reorder.

## 9. What the PRP will add (next step, not now)

Concrete files/functions, schema/migrations, the exact matcher/propagation
changes, Places client + budget guardrails, L&I ingest field mapping, test
fixtures, and validation commands — one PRP per phase (or a combined PRP for
0+1+3, then separate PRPs for 2 and 4).

---

*Grounding note:* current-state figures are verified live (2026-07-23) against
`arbmeioglflvzoffgtii`. The L&I ingest internals live in the registry repo and
are **to be confirmed in the PRP** (DBA field availability is the key unknown).
