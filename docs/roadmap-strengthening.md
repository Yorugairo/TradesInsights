# Roadmap — product strengthening + sourcing durability

> Execution plan folding the GPT-consultant **Product Strengthening Addendum**
> (Additions A–G / stages S0–S6) together with the durability workstream from
> the 2026-07-16 sourcing review. Planning artifact — not yet built. Governed by
> the same invariants as `docs/BUILD_SPEC.md` (never fabricate, immutable
> evidence, facts vs inferences, AI never system of record, a permit is not a
> bid, account isolation, human-only pursuit outcomes). Work strictly in order;
> pass each exit gate before the next. Update STATUS.md + data-dictionary.md
> in-pass, exactly as M0–M4.

## Divergence of record

The addendum re-sequences the pilot around **Solis-first S0–S6** and says it
wins over the companion spec on pilot sequencing/product behavior. Recorded as
an **approved extension** to the finished M0–M4 backlog. `BUILD_SPEC.md` stays
read-only; this doc is the authority for the S-track. Nothing in the addendum
conflicts with the governing invariants — it tightens several (human-only
transitions, urgent-alert whitelist, correction immutability).

## What already exists (do NOT rebuild — extend)

| Addendum asks for | Already in repo | Gap to close |
|---|---|---|
| A. Decision memo fields | `DigestItem` + opportunity page carry whatChanged / whyItFits / confirmed facts / inferences / missingCriticalFacts / nextAction / route / score / components (M3.5/M3.6) | Formalize as a typed, **versioned** `OpportunityDecisionMemo` service; add `procurementState`, `capacityAssessment`, `decisionVersion`, per-component `reason`+`evidenceIds`; re-lead the page per §3 order |
| C. Capacity | `account_profiles.capabilities_json` / static capacity config | Versioned `account_capacity_snapshots`; rescore-on-new-snapshot; penalty explanations |
| D. Invitations | M4.6: `CustomerBidInboxAdapter`, `sources.account_profile_id`, `artifact_access_log`, `/app/invitations`, account isolation | `.eml` upload + inbound-email webhook; `bid_invitations`/`inbound_messages`/`bid_invitation_events`/`bid_documents`; deadline/addendum events; graph matching |
| F. ROI | M3.7 feedback (relevant/new/timely/worth_pursuing), `deliveryQualityMetrics`, feedback rollup | `opportunity_outcomes`/`roi_events`/`research_time_entries`; scorecard; human-confirmed attribution |
| G. Trust | Digest coverage/caveat section, red-source suppression, unit-count dual-citation | `account_suppressions`/`claim_corrections`; urgent-alert whitelist; suppression-before-assembly |
| B, E | — | Net-new: pursuit pipeline; GC relationship graph |

17 new tables total; ~15 API routes; 7 UI sections. This is effectively a
second product build on the M0–M4 base — plan it as its own milestone series.

## Gating reality (be honest up front)

- **S0 is customer-gated** — its exit ("versioned Solis profile + capacity
  snapshot approved") needs Solis's actual scope, capacity, contract-size
  limits, and preferred/blocked GCs. We can build the *schema* and seed
  *provisional* values now (flagged provisional, spec §12.3), but cannot close
  S0 without the customer. Same gate we've hit throughout §22.
- **Model-key-gated:** the memo's prose fields, capacity narrative, and
  invitation extraction ride the extraction→verification pipeline (needs
  `ANTHROPIC_API_KEY`). The deterministic memo skeleton, scoring, state machine,
  and matching all work key-free.
- **Durability track (D1–D5) is fully un-gated** — buildable today, and it
  protects the evidence the memos cite. It should lead.

## Integrated execution order

### Phase D — sourcing durability (start here; un-gated)

Protects data integrity that every downstream memo depends on.

- **D1 — runtime parser invariants.** ✅ **Shipped 2026-07-16.** Optional
  `SourceAdapter.checkInvariants` hook (`source-sdk/invariants.ts`), called by
  the runner per artifact; violations stored in `source_runs.metrics_json` and
  turned red by `evaluateSourceHealth`. Lacey census reconciles the PDF's own
  printed permit count, dwelling-unit total, and valuation grand total (the
  manual-audit checks, now every fetch) + a units-shape ceiling; Lewis
  inspections guards permit-id format + column-shift. Zero false positives on
  both live layouts; catches dropped-row, units↔valuation swap, and column
  drift. *Closed the "silent mis-parse looks green" hole — the worst failure
  mode for a no-fabrication product.* (The heavier "golden-diff re-parse each
  run" is deferred: the printed-total reconciliation already catches live layout
  drift, and the fixture golden tests catch parser-code regression in CI, so a
  runtime fixture re-parse is redundant for now.)
- **D2 — field-fill (null-rate) instrumentation.** ✅ **Shipped 2026-07-16.**
  The runner records per-run fill over `MONITORED_FILL_FIELDS` into
  `source_runs.metrics_json.fieldFill`; `evaluateSourceHealth` reds a source when
  a field that was ≥50% present drops >20% relative vs its previous parsed run —
  the spec §14 "required-field drop >20%" trigger that health.ts documented but
  never implemented. Self-referential per source, so structurally-null fields
  never false-trip.
- **D3 — schema-fingerprint drift action.** ✅ **Shipped 2026-07-16.**
  `evaluateSourceHealth` now compares the two most recent parsed runs'
  `schema_fingerprint` (recorded since M0, never compared); a change raises amber
  with a "review the parser" reason — a visible canary rather than a value that
  sat unused in a column.
- **D4 — substitute-coverage dependency.** Model "`wa_sepa` mitigates
  Pierce/Tumwater/Olympia" as first-class; escalate severity when a
  substitute source goes red (currently a hidden single point of failure).
- **D5 — parser replay by `parserVersion`.** Reprocess stored immutable
  artifacts after a parser fix (raw artifacts already retained forever).

**Exit:** a layout shift that moves a column (no field-name change, no volume
drop) trips red; a null-rate collapse trips red; fingerprint drift raises a
canary; the substitute-coverage alert fires; a parser fix can replay history.

### Phase S0 — Solis calibration (customer-gated)

Build `account_capacity_snapshots` schema + seed provisional Solis snapshot
(drywall/painting stored separately per addendum §5); record pilot success
criteria as data. **Exit (customer):** Solis-approved profile + first real
snapshot. *Proceed to S1 structurally on provisional values; do not claim S0
closed until the customer signs off.*

### Phase S1 — decision memo + feedback (Addition A)

Typed versioned `OpportunityDecisionMemo` service over existing components;
add `procurementState`/`capacityAssessment`/`decisionVersion`; extend verifier;
re-lead opportunity page per §3; API `GET .../decision-memo` +
`POST .../regenerate-memo`. Depends on C-schema (capacityAssessment).
**Exit:** memo renders for every qualified opportunity; unsupported-fact count
0; unchanged opportunity fails the "new" gate; bidding never inferred from a
permit.

### Phase S2 — pursuit board (Addition B)

`pursuits`/`pursuit_transitions`/`pursuit_tasks`/`pursuit_notes`; **server-side
state machine** (invalid transitions blocked; `estimating`/`submitted`/`won`/
`lost`/`no_bid` human-only, never AI; reasons required; audited). List + Kanban;
filters; overdue indicator. Fold in my **review-queue throughput** UX here
(keyboard triage, bulk actions, reason-first) — the 30–60 min/week target lives
in this surface. **Exit:** full bid/no-bid workflow; invalid transitions blocked;
AI cannot trigger human-only states; history preserved.

### Phase S3 — invitation ingestion (Addition D; extends M4.6)

`.eml` upload first, then provider-agnostic inbound-email webhook;
`bid_invitations`/`inbound_messages`/`bid_invitation_events`/`bid_documents`;
deterministic extraction (dates + timezone, GC, estimator, addenda,
prevailing-wage); match to project graph (reuse resolver; ambiguous → review);
deadline changes = material events; **human verification before any deadline
alert**; duplicate-idempotent; account-scoped with `artifact_access_log`.
**Exit:** duplicate-safe ingestion; private evidence isolated; deadline changes
create events; ambiguous matches enter review.

### Phase S4 — GC relationships (Addition E)

`account_organization_relationships`/`organization_contacts`/
`relationship_interactions`; GC view; **public roles vs customer-verified
relationship state kept distinct**; blocked/do-not-pursue suppress alerts.
⚠ Security-sensitive: this promotes contact data (kept to `rawFields` only in
M4.6) to a stored, account-scoped, audited entity — route through the
`security-reviewer` and reuse M4.6 isolation + access-audit. Fold in my **map
view** here (PostGIS geometry exists, never visualized). **Exit:** relationship
data account-specific; provenance separated; suppression honored.

### Phase S5 — ROI + trust controls (Additions F, G)

`opportunity_outcomes`/`roi_events`/`research_time_entries` +
`account_suppressions`/`claim_corrections`; scorecard reproduces from events
(dashboard == digest totals); **suppression applied before delivery assembly**;
corrections immutable; urgent-alert whitelist (only the 5 addendum categories);
source-health disclosure in digest (partly done). Human-confirmed attribution
only (`influenced_by_otn`). **Exit:** metrics reproduce from stored events; no
edited aggregates; unsupported-fact count 0.

### Phase S6 — Lacey sample (config only)

Home/Commercial profiles reuse shared services (mostly done: M3.2 routing +
M3.8 samples); 3–5 reviewed sample opportunities; **no Lacey-specific product
code / no org-ID-conditional behavior**. **Exit:** sales-ready sample, zero
bespoke code.

## Recommended first move

**Phase D (D1 especially).** Un-gated, high-leverage, and it hardens the
evidence base before we build a decision desk that quotes it. Then S0-schema +
S1 skeleton (structural, on provisional Solis values) while the real S0
calibration is pending with the customer. S2–S6 follow in order.

## Tests per phase

Mirror the addendum §13 matrix (decision-memo evidence/change/bid gates; state
machine invalid-transition + human-actor + reason + history; invitation
idempotency + tz + addendum + cross-account denial; capacity historical-score
immutability + rescore + pre-model exclusions; ROI reproduce-from-events +
human-confirmed attribution + dashboard==digest) plus D-track: mis-parse canary
trips red, null-rate drop trips red, fingerprint drift raises canary, replay
reproduces corrected records.
