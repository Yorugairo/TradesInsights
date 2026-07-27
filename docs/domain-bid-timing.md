# Drywall bid-timing model (Solis) — the "when is this biddable?" signal

> Source: customer domain expertise (2026-07-17). This is the interpretation layer
> that turns a permit/plan record into an **actionable bid window** for a drywall +
> painting sub. It reshapes the timing intelligence (P3 stage-lag) and drives the
> single most useful line a busy owner wants: *"can I bid this now, and if not, when?"*

## The core inversion: residential vs commercial

| | Residential | Commercial |
|---|---|---|
| **Bid timing** | **4–8 weeks AFTER** permit issued | **2–6 months BEFORE** permit issued |
| **Site status at bid** | Framed & dried-in | Empty dirt (during plan review) |
| **Drywall sub scope** | Hang + tape gypsum board | Metal stud framing + insulation + drywall |
| **Estimating method** | On-site physical measurement | Digital blueprint takeoff |
| **What triggers the bid** | Framing stage reached | CD phase / 90–100% plans, GMP buyout |

The consequence for OTN: **for residential we watch permit *issuance* and count forward;
for commercial we must catch the project *before* the permit, during plan review / SEPA /
land-use — which is a sourcing problem (see "Pre-permit commercial feeds" below).**

## Residential sequence (bid window opens ~4 wks after permit)

- **Weeks 1–4 (post-permit):** site prep, excavation, foundation.
- **Weeks 4–8 — THE BID WINDOW:** house framed & dried-in; GC brings drywall subs on
  site to bid. GC locks a crew ~3–4 weeks before it's needed.
- **Weeks 8–12:** mechanical rough-ins (plumbing/electrical/HVAC) + inspection.
- **Weeks 12–14:** insulation, then drywall hanging begins.

Why the wait: bidding off 2D blueprints causes material miscalculation. Subs walk the
framed site to measure exact board yields, ceiling heights, and price hard features
(vaults, complex angles).

**OTN signal (residential):** on `permit_issued`, the drywall bid window is
`issued + 4wk … issued + 8wk`. Before that → "framing not reached, bid window opens ~N
weeks." After ~10wk with no bid seen → likely already let.

## Commercial sequence (bid window is BEFORE the permit)

- Drywall sub is usually the **metal-stud framer** too, so must be contracted to mobilize
  right after slab + steel.
- **GMP / financing:** the GC must buy out framing + drywall off the 90–100% plans to
  lock the Guaranteed Maximum Price for the construction loan — *before* the permit clears.
- **Estimating:** on-screen takeoff from digital plans; no framed site needed.
- **Bid window:** during the CD phase while plans sit in the permitting queue — **2–6
  months before permit issuance.**

**OTN signal (commercial):** the biddable moment is `plan_review` / `entitlement` /
`SEPA` — i.e. our *early-stage* records, not permit issuance. By the time a commercial
permit issues, the drywall buyout is usually already done → we're too late if we only
watch issued permits.

## Washington / Thurston nuances

- Commercial permits (esp. SEPA-triggering or complex land-use) take **4–12+ months** to
  process — GCs use that window to run the bid. So a commercial project sitting in review
  for months is a *live, extended* bid window, not a dead lead.
- **Plan-check revisions:** Thurston commercial plans routinely get multiple rounds of
  plan-check comments (health dept, fire marshal, building). GCs bid off the initial
  submittal, then issue pricing **addendums** if the county forces changes to fire-rated
  assemblies or structural. So the same opportunity can re-open for addendum pricing —
  worth flagging a revision as a "re-bid / addendum" event, not a duplicate.

## Paint (the second Solis trade) — a finish-trade clock (added 2026-07-17)

Paint is a **finish trade**: unlike drywall (tied to the structural phase), it lands
late in the sequence, so both bidding and execution run later relative to the permit.

| Construction type | Bidding window | Execution (application) |
|---|---|---|
| **Residential** | **6–12 weeks after** permit | 12–16+ weeks after permit |
| **Commercial** | 2–6 months **before** permit (same GMP buyout as drywall) | 4–12+ months after permit |

- **Residential sequencing:** GCs solicit paint bids during framing/drywall (~wk 6–12);
  painters walk the site to see ceiling heights, lighting angles, and drywall finish
  quality before pricing labor. Application starts only after drywall mud is cured and
  sanded (~wk 12–16+): primer + first coats → millwork/doors/trim → final coats.
- **Commercial sequencing:** painters bid off digital blueprints months pre-permit
  (square footage, specialty coatings like intumescent fireproofing, lift rentals) —
  locked into the GMP with the other trades. Execution is very late: after HVAC
  rough-ins, drywall, and ceiling grids; a big warehouse can be a year-plus post-permit
  before a painter mobilizes.

### The Pacific Northwest exterior constraint

In Thurston County / Western WA, **exterior** paint needs sustained temps (typically
>50°F) and dry surfaces. A schedule that puts the exterior phase inside **November–
April** will likely stall: GCs either tent-and-heat (very expensive) or pause exterior
finish until spring and complete interior paint only. OTN signal: for residential
projects whose estimated paint-execution period (issued + ~12–16 wks) lands in Nov–Apr,
append a season caveat to the paint line — always labeled an inference.

## Where this plugs into the codebase (implementation plan)

> **STATUS 2026-07-17: steps 1, 3, and 4 IMPLEMENTED** — `tradeBidWindow` /
> `tradeBidWindows` (drywall 🔨 + paint 🎨, per-trade clocks) + `bidTrackFor` in
> `packages/intelligence/src/bid-window.ts` (21 unit tests), surfaced as per-trade
> lines on interior-trades digest items; residential paint carries the PNW
> exterior-season caveat. Scorer v1.7.0 folds the track into the Solis timing
> component. Step 2 (stage-lag overlay) and the memo remain.

1. **`drywallBidWindow({stage, track, issuedAt, now})`** in
   `packages/intelligence` — returns `{ status: 'confirmed_open'|'open'|'opens_soon'|'likely_closed'|'watch',
   opensAt, closesAt, note }`. Deterministic; pure function over stored dates + the
   residential/commercial track from the scorer's `classify` (via `bidTrackFor`:
   SFR → residential; commercial/multifamily keywords → commercial; default residential).
2. **Stage-lag (P3):** the existing `stage_lag_stats` gives *our own* observed
   applied→issued lags; this model supplies the **trade-specific** overlay
   (issued→drywall-bid for residential; the pre-permit window for commercial). Surface
   both, always labeled inference.
3. **Digest / memo:** replace the raw timing line with a one-liner a busy owner acts on —
   *"Drywall bid window: OPEN now (residential, framed ~2 wks ago)"* or *"Commercial —
   biddable now during plan review; permit likely 3–5 months out."*
4. **Routing weight (later, calibration):** a project inside its bid window is more
   valuable than one outside it — candidate `timing` component refinement, versioned.

## Pre-permit sourcing status (resolved 2026-07-17)

The commercial half only works if we can see projects **pre-permit**. Coverage
assessment (verified live): **all four counties already have a pre-permit feed
flowing** — no new adapter was needed; the gap was stage interpretation, fixed in
parser 1.1.0 (pre-application cases pin to `preapplication` instead of walking the
permit lifecycle; 436 Pierce + 180 Tacoma records replayed, 424 project stages
corrected).

| County | Pre-permit feed (enabled) |
|---|---|
| Pierce (unincorp.) | `pierce_permits_arcgis` — the PALS extract carries Pre-Application Screening, SEPA Review, Land Use, Short plat, Site Dev Commercial |
| Pierce (Tacoma) | `tacoma_permits_arcgis` — Accela extract carries Land Use + Pre-Application cases |
| Pierce (Puyallup) | `puyallup_permits_arcgis` — city Permit Viewer layer incl. Pre-Application ×343/120d + Residential New SFD (activated 2026-07-18) |
| King | `seattle_land_use_permits` (Socrata) + `king_public_notices`; building applications flow pre-issuance via applieddate |
| Thurston | `thurston_active_notices` (SEPA/land-use notices) + `tumwater_development_arcgis` |
| Lewis | `lewis_current_planning` |
| Statewide | `wa_sepa` (SEPA register) |

Remaining **candidates** (verify-first before any build, standard checklist):
city-level pre-application meeting logs (Olympia, Lacey), King County unincorporated
pre-application queue, design-review board agendas (Seattle DRB), hearing-examiner
calendars. Each is incremental breadth, not a coverage hole.

---

## v1.12.0 — issued demoted, application stage graded (owner directive 2026-07-26)

Two changes, both acting harder on the inversion this document already described.

### 1. An issued permit is mostly history, not a lead

> "issued vs applied should be treated very differently, all of our data supports
> that issued is reducing job likelihood significantly. it should be shaved at
> least 60% weight to start, we're primarily using it to build the relationship
> graph and job history at this point." — owner, 2026-07-26

| Track | `permit_issued` timing | Was | Now |
|---|---|---:|---:|
| Commercial | buyout provably done pre-permit | 0.5 | **0.20** |
| Residential | walk-the-site window is real, but usually already spoken for | 0.9 | **0.55** |

Residential is shaved *less* on purpose: the 2026-07-17 customer model — framed and
dried-in at 4–8 weeks, sub walks the site to measure — is genuinely how a homebuilder
buys drywall. It is demoted because the GC usually has a standing sub by then, not
because the window is fictional. Residential `approved` / `construction_documents`
drop 0.6 → 0.5 so those pre-permit stages stay *below* issued rather than leapfrogging
it as a side effect.

**This is a judgement, not a fitted result.** When it was set, `pursuits`,
`opportunity_outcomes`, `decision_labels`, `feedback` and `pursuit_transitions` were
all empty — there is no conversion evidence in the system behind any specific number.
Revisit once outcomes accumulate.

**Measured effect** on the frozen eval set: Solis priority-flagged 38 → 22, with
priority precision holding at 1.0 and recall at 1.0. Sixteen labelled-good examples
moved from priority down into the digest band; none were lost.

### 2. The application stage is graded by freshness

Until v1.12.0 every `permit_applied` record scored `timing = 1.0` regardless of age.
On 2026-07-26 that meant 496 Solis opportunities scored identically — 147 filed within
four weeks, 124 filed more than twelve weeks earlier — putting 46 fresh priority leads
level with 44 cold ones. Filed-date coverage is 99.8%, so nothing new had to be sourced.

| Weeks since filed | Factor | Reading |
|---|---:|---|
| ≤ 4 | 1.00 | ITBs typically going out — the strike zone |
| 4–8 | 0.90 | bids being levelled; still on time |
| 8–12 | 0.75 | closing; expect to be a backup number |
| > 12 | 0.55 | cold — de-prioritised, **not** dead |

The floor is 0.55 rather than something punitive because of the tension recorded
earlier in this document: **WA commercial land-use routinely runs 4–12+ months**, so a
long review can be a live extended bid window rather than a dead lead. A stale
application therefore still outranks an issued permit on both tracks. Which reading is
right for Solis is the open `review_depth` calibration question.

An **absent** filing date scores as fresh (factor 1). Unknown is not evidence of
staleness — the same discipline as `recencyFactor` — and it is also what keeps the
frozen eval examples byte-identical, since none of them carries the field.

### 3. Two consumers realigned

- **`isEasyWin`** (packages/delivery) predated the bid-track model and contradicted it:
  a commercial project at `permit_issued` could be flagged
  `commercial_bid_window_likely_closed` by the scorer and presented as "winnable now"
  in the same email. It now reads that signal instead of forming a second opinion from
  the stage string.
- **The commercial buyout note** now says how far into review the project is, and what
  to do about it — "call the GC's estimating department for plan-room access" while
  ITBs are going out, versus "expect to be a backup number" once bids are being
  levelled. Absent a filing date it falls back to the original wording rather than
  inventing an age.
