# Implementation Report: Queue cockpit — Phase D (Google Place queue)

## Summary
Phase D of `queue-cockpit.plan.md` — the Google Place review queue gets its first
web UI, its long-missing auto-resolver, and a decision write-back lane. The queue
lives in the REGISTRY; Insights now works it through `registry_public` contract
views and writes decisions to `registry_partner`, never touching
`registry_internal`. This also lights up the cockpit's Place card, which Phase C
built to probe a view that did not exist yet.

With this, `queue-cockpit.plan.md` is COMPLETE (A and E remain backlogged by owner
decision).

## Tasks completed
| # | Task | Where | Status |
|---|---|---|---|
| D1 | `google-place-lineage-consolidate.mjs` + 11 gate tests | registry | Complete, **run live** |
| D2 | `google_place_review_v1` + `_blocked_summary_v1` contract views | registry DB + migration | Complete, **live** |
| D3 | `registry_partner.partner_queue_decisions` | registry DB + migration | Complete, **live** |
| D4 | `apply-partner-queue-decisions.mjs` | registry | Complete (no decisions to apply yet) |
| D5 | `google-place-review.ts` + 8 tests | Insights | Complete |
| D6 | decision route + `/app/admin/google-place-review` + breadcrumb | Insights | Complete |

## The investigation that reshaped D1 (do not re-derive)
The plan assumed the 926-row "resolve automatically from lineage" cohort was
largely auto-resolvable. Measured against the live DB, it is not:

| classification | rows | outcome |
|---|---|---|
| Place already accepted for a link whose entity has the **same UBI** | **28** | auto-resolved |
| Accepted claimant has a **different UBI** | 209 | left pending — the genuine conflict |
| **No accepted claimant** for that Place at all | 711 | left pending — no deterministic evidence |

So D1 shrinks the cohort by 28, not by hundreds. That is the honest answer: the
CSV triage saw an offline candidate set we cannot re-derive from the database, and
inventing a rule to close those 711 rows would be fabricating identity decisions.
The script's dry run reproduces this census exactly.

**The one rule**: same UBI = one legal entity, so the pending row is a sibling
licence re-claiming a Place the company already holds — a duplicate claim, not a
new identity question. Hand spot-check confirmed the shape: `Andgar Mechanical
LLC` → accepted `Andgar Home Comfort` (UBI 604255353), `Apollo Sheet Metal` →
`Apollo Heating & A/C` (600443607), `Dear Electric` → `Dear Services` (603435724).

**What D1 does not do**: it never mints or rewrites a profile link. Identity stays
with the scorer or a human — the discipline `geo-corroborated-phone-promote.mjs`
set. It only retires the queue row, naming the justifying claimant in
`resolution_payload`.

## The reason-string finding that reshaped D2
The plan said to exclude "the two automation-tagged reasons". Live data has
**five** long-form automation reasons plus four short human-decidable machine keys.
An exclude-list would therefore fail OPEN — a new automation reason would silently
become operator work.

D2 inverts it: `review_state` is computed from an **include-list** of the four
human keys, with `awaiting_evidence` as the DEFAULT arm. An unseen reason fails
CLOSED (drops out of the human queue, never into it) and shows up as a moving
count in the blocked-summary canary. Live: actionable 201 · awaiting_auto_resolver
920 · awaiting_evidence 1130 = 2,251.

## Validation
| Level | Result |
|---|---|
| Typecheck (`pnpm -r`) | clean — 11/11 projects |
| ESLint (all Phase D files) | clean |
| Unit — Insights | 325/325 (8 new in `google-place-review.test.ts`) |
| Unit — registry gate | 11/11 (`node --test`) |
| Build (`@otn/web`) | clean; `/app/admin/google-place-review` + decision route registered |
| D1 live run | 948 candidates → 28 resolved; rerun 920 candidates → 0 eligible (idempotent) |
| D2 seam check | connected as **`otn_insights`**: both views readable; `registry_internal` denied **42501** |
| Cockpit | C1's existing probe now returns live counts with **no code change** |

## Deviations from plan
- **D1 yield is 28, not the implied hundreds** — measured, not assumed (see above).
  The script reports the full census so the number is never mistaken for progress.
- **D2 is an include-list, not an exclude-list**, and carries all three states in
  ONE view (Phase C's shipped probe counts three `review_state` values from a
  single view; an exclude-only view would have broken that contract).
- **D4 maps `needs_evidence` to a skip, not a resolution.** "I can't tell" is not
  an answer; closing the row would discard an unanswered question.
- **D2/D3 DDL applied live first, then recorded as migration files** so the repo
  matches the database (same approach the owner approved for B1/B2).

## Follow-ups
- Run `apply-partner-queue-decisions.mjs` after operators start deciding (nothing
  to apply until then); consider scheduling it alongside the nightly export.
- The 209 different-UBI rows are real relationship questions — they are the
  natural feedstock for the Phase B relationship lane once someone works them.
- BACKLOGGED by owner: Phase A (PALS + Google enrichment), Phase E (domain lane).
