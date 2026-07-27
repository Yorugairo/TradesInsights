# Plan: the strike zone — permit-application freshness as a first-class signal

> Audit run 2026-07-26 against `packages/intelligence/src/scoring.ts`,
> `packages/intelligence/src/bid-window.ts`, `packages/delivery/src/digest.ts`,
> `docs/domain-bid-timing.md`, and the live Solis pool. Every number below is a
> query result, not an estimate.

## Summary

The briefing's core claim — **the strike zone is the permit *application*, not the
permit** — is already the spine of our model and has been since 2026-07-17. The
commercial timing map peaks at `permit_applied`, the bid-window overlay calls issued
commercial work "likely already let", and the deck leads with it.

What we do **not** do is distinguish a permit filed three days ago from one that has
sat in review for nine months. Every one of Solis's 496 application-stage
opportunities scores `timing = 1.0`. The briefing's whole point is that those are
different jobs — one is the strike zone, the other is the dead zone with extra steps.

We have the data to fix it (99.8% of application-stage projects carry a filed date)
and we should **not** ship the fix before Solis answers one question.

---

## VERDICT

| Briefing claim | Status |
|---|---|
| Application filed = the strike zone | ✅ modeled — commercial `permit_applied` timing 1.0 |
| Permit issued = the dead zone | ✅ modeled — commercial `permit_issued` 0.5, `construction` 0.4 |
| Issued work should still be visible (addendum re-pricing) | ✅ deliberate — 0.5 not 0, with an addendum note |
| Conveyed to the customer | ✅ deck slides `s4`/`s5` lead with it |
| **Freshness *within* the application stage** | ❌ **not modeled — the main gap** |
| **"Winnable now" agrees with the bid model** | ❌ **actively contradicts it** |
| **No GC listed → call the architect** | ❌ unsupported; `architect` role is 0 rows |
| **Retail TI vs commercial office posture** | ❌ one regex, no split |
| Jurisdiction-relative clock | ⚠️ desirable, **not yet supportable** (see G-F) |

---

## GROUND TRUTH

### What is already right (do not rebuild this)

`packages/intelligence/src/scoring.ts:391` — `timingInterior`, commercial track:

```ts
const map: Record<string, number> = {
  bidding_confirmed: 1, permit_applied: 1, construction_documents: 1, approved: 1,
  entitlement: 0.9, preapplication: 0.7, permit_issued: 0.5, construction: 0.4,
  near_final: 0.2, concept: 0.2,
};
```

`packages/intelligence/src/bid-window.ts:~95` — `COMMERCIAL_BUYOUT_STAGES` =
`{preapplication, entitlement, approved, construction_documents, permit_applied}` →
status `open`; issued/construction → `likely_closed` with an addendum caveat. The
export comment states the intent explicitly: the phase-change alert fires on the
**same** window the display overlay reflects — one source of truth.

`scoring.ts:~645` emits `commercial_bid_window_likely_closed` for auditability.

The deck already says it out loud (`presentation.html:648`): *"Filed, not issued. For
commercial work this is the only moment the interior package is genuinely biddable."*

**Conclusion: the inversion is factored in and conveyed correctly.** The gaps are all
about *resolution within* the stage, and about two places where other code disagrees
with the model.

### G-A — every application-stage record scores identically *(highest leverage)*

Live, Solis pool, `current_stage='permit_applied'`, non-archived:

| Weeks since filed | Count | At priority (≥80) |
|---|---:|---:|
| ≤ 4 — **strike zone** | 147 | 46 |
| 4–8 — closing window | 150 | — |
| 8–12 | 74 | — |
| **> 12 — cold** | **124** | **44** |
| **Total** | **496** | 181 |

Median 6.6 weeks since filing. **Filed-date coverage is 99.8%** (3,613 of 3,619
application-stage projects system-wide carry a confirmed `permit_applied` event date).

At the priority band, **46 fresh leads and 44 cold ones rank identically**. A quarter
of his application-stage priority list is stale and indistinguishable from the best
lead in the system. The fix requires no new sourcing — only reading a date we already
store.

### G-B — "winnable now" contradicts the bid model

`packages/delivery/src/digest.ts:268`:

```ts
if (!["permit_issued", "approved"].includes(c.current_stage)) return false;
```

Two consequences, both wrong:

1. A **commercial** project at `permit_issued` — which the scorer has just flagged
   `commercial_bid_window_likely_closed` and timed at 0.5 — can still be presented as
   an **easy win, "winnable now"**. The same record, in the same email, says both.
2. The **entire strike zone is excluded from easy wins by definition** — all 496
   application-stage opportunities, including the 147 filed in the last four weeks.

`isEasyWin` predates the bid-track model and was never revisited when it landed. It is
a pure function over `CandidateRow`, which already carries `rationale_json` (selected
at `digest.ts:237`), so the scorer's own classification is available to it — the fix
does not require re-deriving the track.

### G-C — the architect play has no data behind it

`project_roles` role distribution, system-wide:

| Role | Rows | Projects |
|---|---:|---:|
| applicant | 6,541 | 5,824 |
| owner | 531 | 516 |
| lead_agency | 449 | 445 |
| primary_contractor | 441 | 415 |
| proponent | 5 | 5 |
| **architect** | **0** | **0** |

`roles.architect` exists only as a display label (`packages/delivery/src/render.ts:116`)
and in the LLM extraction vocabulary (`extraction/extract-run.ts:107`). Nothing ever
writes it.

The briefing's asymmetry play is nonetheless **structurally correct for our data**. Of
Solis's 496 application-stage opportunities:

- **1** has a named GC
- **249** have an applicant and no GC ← the exact bucket the briefing describes
- 246 have neither

But of the 232 distinct applicant organisations in that bucket, only **10** are
design-firm-shaped (`architect|architecture|aia|design|studio`) and **5**
engineering-shaped. The rest are person-shaped — homeowners filing their own
residential permits, which is what a county residential feed produces.

**So the play is real but thin at today's source coverage.** This is a sourcing
problem (we are heavy on residential county feeds, light on commercial plan-review
dockets), not a scoring problem. Say so plainly rather than shipping a feature that
fires fifteen times.

### G-D — retail TI and commercial office share one regex

`scoring.ts:119`:

```ts
/\b(commercial|retail|office|warehouse|industrial|institutional|school|church|hotel|restaurant|storefront|clinic|hospital)\b/
```

The briefing says these warrant **opposite** postures: retail TI is an aggressive
pursuit (out-of-town GC on a forced grand-opening date with a shallow local bench);
commercial office is a prequalification long game (entrenched vetted sub lists, and
the permit is a pretext to meet the estimator for the *next* job). We convey neither,
and `isTi` alone cannot tell them apart.

### G-E — the intake asks the wrong half of the question

`questions.js:49` asks `stage_weight`: *"A project at application stage ranks ABOVE an
equivalent issued one."* Good — that confirms the inversion. It never asks **how deep
into plan review is too late**, which is precisely the number G-A needs.

### G-F — our own WA nuance contradicts the briefing, and the data cannot settle it yet

`docs/domain-bid-timing.md` states that WA commercial permits take **4–12+ months**, so
a project sitting in review for months is *"a live, extended bid window, not a dead
lead."* The briefing says 4–8 weeks in review means you are already playing backup.

Both can be true — the briefing describes a typical national schedule, ours describes
slow WA commercial land-use. The correct resolution is a **jurisdiction-relative**
clock (weeks-in-review as a fraction of that jurisdiction's median days-to-issue),
which migration `0029_market_aggregates.sql:48-59` already computes.

**It is not yet supportable.** Paired application→issue observations, ≥20 per
jurisdiction:

| Jurisdiction | Paired projects | Median days to issue |
|---|---:|---:|
| City of Tacoma | 21 | 23 |
| Pierce County | 55 | 15 |

Two jurisdictions, 76 projects, and both medians are residential-speed. Calibrating a
commercial clock on this would be worse than a fixed curve. **v1 must use a fixed
weeks-since-filed decay; revisit when paired coverage reaches ≥20 commercial projects
across ≥8 jurisdictions.**

---

## Strategic design

### The sequencing decision — this is the important part

The meeting is **today**. The decay curve in G-A is exactly the kind of number this
codebase has repeatedly refused to invent: §12.3 keeps scope signals unweighted
"so the evidence accumulates from today rather than starting at zero the day someone
decides to weight them", and `WARM_GC_BONUS` was deliberately built additive-and-clamped
rather than folded into the weight vector.

Shipping a hardcoded "cold after 12 weeks" hours before asking the one person who
knows would repeat the mistake the whole calibration session exists to prevent — and
G-F says the data cannot arbitrate it.

**Therefore:**

- **Phase A (before the meeting)** — *ask and convey*. Intake question, deck slide,
  and the one fix that needs no permission because it removes a contradiction rather
  than adding a judgement (G-B).
- **Phase B (after the meeting)** — *weight it*, using his answer.

### NOT building

- Jurisdiction-relative decay (blocked on coverage — G-F)
- An `architect` role extractor or adapter change (source-coverage work, backlog)
- Any change to the residential track — the briefing is about commercial buyout, and
  the residential 4–8-weeks-after-issuance model is customer-confirmed and untouched
- Re-weighting `score_components` (that is the calibration session's own G1)
- Auto-dropping cold application-stage records — visibility is Solis's call

---

## Step-by-step tasks

### PHASE A — before the meeting

#### Task A1: fix the easy-win / bid-window contradiction *(no calibration needed)*
- **ACTION**: Make `isEasyWin` respect the track the scorer already decided.
- **IMPLEMENT**: In `packages/delivery/src/digest.ts:268`, read the scorer's own
  signal off `c.rationale_json` rather than re-deriving the track:
  ```ts
  const signals: string[] = Array.isArray(c.rationale_json?.signals) ? c.rationale_json.signals : [];
  // A record the scorer flagged as past its commercial buyout is never "winnable now",
  // whatever its stage says. Same source of truth as the 🔨 line (bid-window.ts).
  if (signals.includes("commercial_bid_window_likely_closed")) return false;
  ```
- **MIRROR**: `bid-window.ts` `COMMERCIAL_BUYOUT_STAGES` export comment — the alert and
  the overlay read one source of truth; this makes the digest a third reader of the
  same fact rather than a fourth opinion.
- **GOTCHA**: Do **not** widen `isEasyWin` to admit `permit_applied` in this task.
  That is a scope change gated on G-A's answer, and easy-win counts feed the deck's
  live numbers. Removing contradictions is safe today; adding stages is not.
- **GOTCHA**: `rationale_json` is `jsonb` — it may be `null` for rows scored before the
  signal existed. Guard with `Array.isArray`, never `c.rationale_json.signals.includes`.
- **VALIDATE**: `pnpm vitest run apps/worker/test/digest.test.ts`; add a case asserting
  a `permit_issued` candidate carrying the signal is **not** an easy win, and one
  without it still is. Then re-run `calibration-sensitivity.mts` and confirm the
  easy-win band counts in the deck did not silently move.

#### Task A2: ask the question that unblocks Phase B
- **ACTION**: Add one question to `docs/meetings/2026-07-26-solis/questions.js`.
- **IMPLEMENT**:
  ```js
  {
    id: 'review_depth', slide: 's4', new: true,
    ask: 'A permit has been sitting in plan review for three months. Still worth a call?',
    why: 'Right now every application-stage job scores the same whether it was filed on '
       + 'Tuesday or last October. 147 of yours were filed in the last month; 124 have '
       + 'been in review over three months. We rank them identically.',
    yamlPath: 'score_components -> timing (application-stage freshness)',
    controls: [{ type: 'pills', group: 'review_depth', options: [
      'Still worth it — WA reviews run long, the window stays open',
      'Worth less — rank it below a fresh filing',
      'Dead — stop showing me those',
    ]}],
  }
  ```
- **MIRROR**: the existing `closed_windows` question (`questions.js:141`) — same shape,
  same slide, same three-option pill pattern, `new: true`.
- **GOTCHA**: Every question needs a `yamlPath` — the audit plan's stated invariant is
  that the export applies as a config change.
- **GOTCHA**: The books A–D matrix was silently deleted once by a range replacement in
  this file. **Append**; do not rewrite a span. `deck-4k.spec.ts` pins the eight
  `book_*` keys and asserts every `QUESTIONS[]` id mounts — run it.
- **VALIDATE**: `npx playwright test tests/deck-4k.spec.ts` — all 11 green, including
  "every question in the model reaches the deck" and both fit assertions.

#### Task A3: show him the ladder on slide s4
- **ACTION**: Add the four-band freshness breakdown to the existing timing slide.
- **IMPLEMENT**: 147 / 150 / 74 / 124 as a band strip beneath the existing KPIs, with
  the honest line: *"All four bands score the same today. That is the question on the
  right."* Ties the slide directly to A2's question.
- **GOTCHA**: `.slide-content` is `overflow:hidden` — content that does not fit is
  **silently clipped**, not scrolled. A previous callout was in the DOM and invisible
  below the fold while the fit test passed. Assert the new element's bounding rect is
  inside the viewport, not merely that nothing clipped.
- **GOTCHA**: `.split-ask` exists in two shapes (authored markup and JS-restructured);
  a selector matching only one silently drops the grid on the other slides.
- **VALIDATE**: `npx playwright test tests/deck-4k.spec.ts` at both 3840×2160 and
  1440×900; add a bounding-rect assertion for the new band strip.

### PHASE B — after the meeting, using his answer

#### Task B1: application-stage freshness decay
- **ACTION**: Add a freshness factor to the commercial `permit_applied` timing.
- **IMPLEMENT**: Plumb `appliedAt` into `ProjectFeatures` (derive as
  `min(project_events.event_date) WHERE confirmed AND resulting_stage='permit_applied'`
  — the same derivation migration `0029_market_aggregates.sql:48` already uses), then:
  ```ts
  /** Weeks-since-filing decay for the commercial buyout window. Curve set by Solis
   *  at calibration 2026-07-26 (question `review_depth`) — NOT invented here. */
  function appliedFreshness(appliedAt: Date | null, now: Date): number {
    if (appliedAt === null) return 1; // unknown filing date is not evidence of staleness
    ...
  }
  ```
- **MIRROR**: `recencyFactor` (`scoring.ts:~413`) — same null-safe shape, same
  "unknown is not worst-case" discipline (`return 0.5`, never 0.1, on null).
- **GOTCHA — the eval gates are byte-identical frozen.** `appliedAt === null → 1.0` is
  what keeps every existing eval fixture unchanged, exactly as `WARM_GC_BONUS` stayed
  byte-identical because no fixture carried a warm set. Verify the frozen examples
  before touching fixtures; if any moves, the null guard is wrong.
- **GOTCHA**: Apply on the **commercial track only**. Residential `permit_applied`
  timing is a lead-time judgement (owner directive 2026-07-20), not a buyout clock.
- **VALIDATE**: `pnpm vitest run packages/intelligence` + the eval gate; then re-run
  `calibration-sensitivity.mts` and confirm the priority pool reshuffles in the
  direction his answer implies (fresh up, 12-week-plus down).

#### Task B2: the bid-window note earns its phase language
- **ACTION**: Split the single commercial "open" note into the briefing's two phases.
- **IMPLEMENT**: In `tradeBidWindow`, commercial + `COMMERCIAL_BUYOUT_STAGES`, branch on
  weeks-since-filed: early → *"Filed ~N weeks ago — ITBs typically go out now. Ask the
  GC's estimating department for plan-room access."*; late → *"In review ~N weeks — bids
  are typically being levelled by now; expect to be a backup number."*
- **MIRROR**: the existing residential `opens_soon` / `open` / `likely_closed` prose —
  every note is TYPICAL-sequencing language and never a promise. Keep that register.
- **GOTCHA**: The file's contract is explicit — a note **never** sets
  `bidding_confirmed`; only an explicit solicitation confirms bidding (spec §9).
- **VALIDATE**: `pnpm vitest run packages/intelligence/src/bid-window.test.ts`.

#### Task B3: applicant-as-contact fallback, honestly scoped
- **ACTION**: When no GC is named, surface the applicant as the call target with the
  asymmetry framing; add a signal when the applicant is design-professional-shaped.
- **IMPLEMENT**: Score-neutral signal `design_professional_applicant` under §12.3.
  Log the true count (~15 of Solis's pool) in the PR body — this is deliberately a
  small feature, and pretending otherwise would misrepresent it.
- **GOTCHA**: Do **not** populate `roles.architect`. It is a real role with zero rows;
  writing "architect" from a name regex would fabricate a fact into the role table.
  Keep the inference in the signal layer where inference belongs.
- **VALIDATE**: Assert the signal is absent from Solis's weight vector (score
  unchanged), and that a person-shaped applicant does not trip the regex.

#### Task B4: retail-TI vs office posture *(signal-only)*
- **ACTION**: Split `RE.commercial` consumers into retail-TI and office-TI signals.
- **IMPLEMENT**: `retail_ti_scope` / `office_ti_scope`, unweighted, alongside the
  existing §12.3 scope signals — so the evidence accumulates from today.
- **GOTCHA**: Leave `RE.commercial` itself intact; `isCommercial` gates the track
  selection in `bidTrackFor` and three routers. Add signals, do not re-cut the regex.
- **VALIDATE**: Eval gate byte-identical (unweighted signals cannot move a score).

---

## Validation commands

```bash
pnpm vitest run apps/worker/test/digest.test.ts packages/intelligence
```
EXPECT: all pass; eval gate byte-identical

```bash
npx playwright test tests/deck-4k.spec.ts
```
EXPECT: 11 passed (fit at both viewports, all questions mounted, books A–D intact)

```bash
cd apps/worker && pnpm exec tsx calibration-sensitivity.mts
```
EXPECT: easy-win band counts unchanged by A1 except the removal of flagged-closed rows

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Hardcoding a decay curve before Solis answers | — | **High** | Phase split; B1 is gated on A2's answer |
| A1 shrinks easy-win counts below the deck's stated figures | Medium | Medium | Re-run sensitivity before the meeting; the deck cites priority-pool numbers, not easy-win, but verify |
| `appliedAt` null-guard wrong → eval fixtures move | Medium | **High — silent** | Eval gate is byte-identical; any movement fails the build |
| New slide content clipped by `overflow:hidden` | Medium | **High — invisible in the room** | Bounding-rect assertion, not just a clip check |
| Range-replace in `questions.js` deletes a question | Low | **High — silent** | Append only; spec pins all ids and the `book_*` keys |
| Reading the briefing as WA-calibrated | Medium | Medium | G-F documents the tension; fixed curve v1, jurisdiction-relative deferred on stated coverage threshold |

## Plan history

**2026-07-26 — v2, SHIPPED as scoring v1.12.0.** Meeting postponed, so the Phase A/B
split was collapsed and the owner settled the curve directly rather than the intake
asking for it: *"issued vs applied should be treated very differently … shaved at least
60% to start, we're primarily using it to build the relationship graph and job history."*

Track scope was a genuine fork and was put to the owner rather than guessed — a
both-tracks shave would have overridden his own 2026-07-17 residential model. Answer:
**both, residential shaved less** (commercial 0.5 → 0.20, residential 0.9 → 0.55).

One claim in the directive did not survive checking: *"all of our data supports that
issued is reducing job likelihood significantly."* `pursuits`, `opportunity_outcomes`,
`decision_labels`, `feedback` and `pursuit_transitions` are **all empty** — there is no
conversion evidence in the system. The change is recorded in code and docs as an owner
judgement so it stays revisitable, rather than as a fitted result.

Shipped: G-A (freshness gradient), G-B (`isEasyWin` contradiction), the two-phase
buyout note, the `review_depth` intake question, and the issued shave. Deferred as
planned: G-C (architect role — 0 rows, a sourcing problem), G-D (retail vs office
split), G-F (jurisdiction-relative clock — 2 jurisdictions of coverage).

Measured: eval Solis priority 38 → 22 with precision and recall both holding at 1.0;
live projection priority 479 → 212, weekly flow at threshold 80 of 42 → 24.


**2026-07-26 — v1.** Audit found the briefing's central inversion already implemented,
tested, and presented — the model has encoded "application, not permit" since
2026-07-17. Three genuine gaps: no freshness resolution *within* the application stage
(496 records ranked identically, 124 of them 12+ weeks cold); `isEasyWin` predating the
bid-track model and contradicting it; and the architect fallback resting on a role with
zero rows. Phase split is deliberate — the decay curve is a customer judgement, the
data cannot arbitrate it (G-F), and the person who can settle it is in the room today.
