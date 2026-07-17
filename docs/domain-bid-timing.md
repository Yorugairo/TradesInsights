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

## Where this plugs into the codebase (implementation plan)

1. **`bidWindow(stage, isCommercial, issuedAt|appliedAt, now)`** in
   `packages/intelligence` — returns `{ status: 'open'|'opens_soon'|'likely_closed'|'watch',
   opensAt, closesAt, note }`. Deterministic; pure function over stored dates + the
   residential/commercial class the scorer already computes (`classify`).
2. **Stage-lag (P3):** the existing `stage_lag_stats` gives *our own* observed
   applied→issued lags; this model supplies the **trade-specific** overlay
   (issued→drywall-bid for residential; the pre-permit window for commercial). Surface
   both, always labeled inference.
3. **Digest / memo:** replace the raw timing line with a one-liner a busy owner acts on —
   *"Drywall bid window: OPEN now (residential, framed ~2 wks ago)"* or *"Commercial —
   biddable now during plan review; permit likely 3–5 months out."*
4. **Routing weight (later, calibration):** a project inside its bid window is more
   valuable than one outside it — candidate `timing` component refinement, versioned.

## Open sourcing dependency

The commercial half only works if we can see projects **pre-permit**. That is the
"pre-permit commercial data feed" question — see `docs/source-policy.md` candidates and
the response notes: SEPA register (have it), Thurston/Pierce/King **land-use &
pre-application** records, plan-review logs, design-review boards, and published bid
solicitations. Each goes through the standard §14 activation checklist before enabling.
