# Drywall market research — targeting vocabulary and site keywords

**Captured:** 2026-07-26, from owner domain research ahead of the Solis calibration session.
**Status of the numbers:** industry estimates, **not measured from Solis's books**. They frame
questions; the customer's correction is the answer. Never present them to a contractor as facts
about his own business.

Canonical for **both repos**. The registry-side WaaS site work references this file rather than
copying it — the two trees have drifted before.

---

## 1. Where Solis is today

Mostly **smaller-ticket residential**, with a few commercial wins behind them. Everything in §2
below is an **expansion ladder**, not a description of the current book. This distinction matters
operationally: a scorer tuned to where they want to go will starve them of the work they actually
win today, and a scorer tuned only to today will never surface the rung up.

## 2. The four books of business

| | Book | Revenue profile | Permit-visible? |
|---|---|---|---|
| **A** | Commercial TI & multi-family | $100k–$5M+ per contract; ~8–12% net. Largest top line. | **Yes** — best fit for the pre-permit engine |
| **B** | Level 5 custom residential | $3.50–$7.00/sq ft vs $1.50–$3.00 for standard Level 4; ~35–50% gross labour | **Yes** — but the *finish level* is rarely stated; inferred from valuation + address |
| **C** | Restoration & insurance patch | 40–50%+ net, fast turnaround, Xactimate/emergency rates | **No** — see §3 |
| **D** | Turnkey framing + drywall package | +40–60% ticket over drywall-only; WA GCs prefer single-source | **Partly** — a bidding posture, not a project type |

**A scope:** office buildouts (tech/medical in Seattle/Bellevue), multi-family mid-rise, retail,
public/educational. Metal stud framing, hang/tape, fire-rated shaftwall (Type X/C), ACT grid.

**B scope:** luxury builds and remodels in Bellevue, Mercer Island, Medina, Kirkland, Gig Harbor,
Bainbridge. Full skim coat, trimless/flush walls, wrapped window returns, curves, Venetian plaster.

**C scope:** burst pipes, freeze damage, roof leaks, flooding. Demo, dry, patch, seam and texture
match (orange peel, knockdown, smooth), paint.

**D rationale:** bundling light-gauge framing and insulation with drywall protects against labour
margin erosion on single-trade bids.

## 3. The restoration blind spot

**Insurance patch work generally pulls no permit.** The book with the best net margin is therefore
structurally invisible to permit-based sourcing — not a coverage gap that closes with more adapters.

The `restoration_scope` signal exists anyway, to **measure** how little leaks through. A low count
is the expected finding, not a broken matcher. If it ever runs high, that is worth investigating.

## 4. Geography: qualify the drive, do not de-rate the county

The instinct to down-weight King as "distant volume" is the wrong instrument, because a drive is
only expensive **relative to what you drove past**:

- **Worth any drive in range** — data centres (Quincy, Moses Lake, Douglas County), rated shaftwall,
  STC assemblies, Level 5 in Medina/Mercer Island, commercial TI in Bellevue. Few bidders, pays the
  mileage, no local equivalent being passed up.
- **Not worth the drive** — generic Level 4 residential hanging in King, reached by driving past
  dozens of equivalent Pierce and Thurston jobs.

A county weight cannot tell those apart; `specialist_assembly` can. Note also that Central WA data
centres sit **outside** the current county list, and Bainbridge is **Kitsap** — also outside — so a
hard county list is the wrong shape too. Distance should be *paid for* by job type.

## 5. Permit-text targeting vocabulary

Implemented as `RE.specialistAssembly`, `RE.restorationWork` and `RE.residentialRemodel` in
`packages/intelligence/src/scoring.ts`, feeding three **score-neutral** signals (§12.3 — no weight
until Solis confirms scope). Evidence accumulates from today so a future weighting decision starts
with data rather than from zero.

| Signal | Terms |
|---|---|
| `specialist_assembly` | data cent(er/re), server room, clean room · fire-rated, firestop, shaftwall, Type X/C, UL-listed, N-hour rated · soundproof, acoustic(al), QuietRock, resilient channel, ROCKWOOL, mass-loaded vinyl, STC-nn · metal stud, steel stud, light-gauge · Level 5, smooth wall, skim coat, Venetian plaster |
| `restoration_scope` | water damage, flood(ing/ed), burst pipe, freeze damage, mold remediation, smoke damage, restoration |
| `residential_remodel_scope` | popcorn ceiling, basement finish, finished basement, re-texture, knockdown texture, orange peel |

**Deliberately narrow.** `\btype ?-?x\b` not `type x`; `stc` only when followed by a rating. A false
positive here claims specialist work on an ordinary permit, which is worse than missing one — it
would send Solis on a drive the job does not justify.

Terms intentionally **excluded** from `specialist_assembly`: bare `ceiling` and `basement`, both far
too common in ordinary residential permits (`ceiling` already lives in `RE.interior`; `basement
finish` is a remodel cue, not a specialist one).

## 6. WaaS site — pages and keywords

For the Solis site (registry repo, `/sites/[slug]`, same `TradesSiteChrome` pattern as Lacey Glass).
**Constraint:** new sub-routes must reuse the existing `[page]` segment — never add a new
`[pageSlug]` segment.

### 6.1 High-intent commercial & local (ready to hire)

Service + city pages. Highest conversion, highest competition.

- `drywall contractor near me` / `drywall installers near me`
- `commercial drywall contractor [City, WA]` — Seattle, Tacoma, Bellevue, Olympia, Lacey, Spokane
- `residential drywall contractor near me`
- `drywall repair contractor [City, WA]`
- `sheetrock installation company`
- `hire drywall finisher near me`
- `drywall framing and hanging contractors`

### 6.2 High-value niche services (lower competition, higher margin)

One page per specialty. These map **1:1 onto `specialist_assembly`** above — the same vocabulary
that finds the work also wins the search for it, which is the point of running both sides.

| Page | Keywords |
|---|---|
| Level 5 / smooth finish | `level 5 drywall finish contractor`, `smooth wall drywall finish cost`, `level 4 vs level 5 drywall finish` |
| Water damage & patching | `water damage drywall repair`, `ceiling drywall repair service`, `sheetrock patch repair near me` |
| Acoustic & fire safety | `soundproof drywall installation`, `quietrock contractor`, `fire-rated drywall installation`, `type x sheetrock installation` |
| Remodel & prep | `popcorn ceiling removal and drywall finish`, `basement drywall contractor`, `metal stud framing and drywall` |

**Note the asymmetry:** water-damage pages are worth building even though restoration is invisible
to permit sourcing (§3). Search is the *only* channel that reaches that book — which makes the site
strategically more valuable to Solis than the lead feed for their highest-margin work.

### 6.3 Informational / cost (top of funnel)

Long-form pages; traffic and trust rather than direct conversion.

- `drywall installation cost per square foot Washington`
- `how much does sheetrock installation cost`
- `drywall cost per sheet installed`
- `how much to drywall a 2000 sq ft house`

## 7. Capability ladder — what the high-margin sectors demand

Gating requirements, not preferences. Relevant to both what Solis can bid and what the site can
credibly claim.

- **Data centre / industrial** — heavy-gauge structural steel framing, UL-listed 2–3 hour shaftwall,
  thermal control, cleanroom dust containment.
- **Acoustic** — STC 55–60+ assemblies: QuietRock, RC-1 resilient channel, mass-loaded vinyl,
  ROCKWOOL AFB stone-wool batts.
- **Fire-rated** — double-layer Type X/C, head-of-wall deflection joints, certified firestop caulking.

**Route into Tier-1 bidding:** prequalification via Highwire / COMPASS / Vertikal RMS (Turner,
Skanska, Lease Crutcher Lewis, Mortenson, GLY, DPR, Howard S. Wright) — financials, EMR under 1.0,
bonding, $2M–$5M+ GL. Written site-specific safety plan. Manufacturer certification (USG, National
Gypsum, CertainTeed, ROCKWOOL, Trim-Tex). Surety line $1M single / $3M–$5M aggregate. Registration
on WA DES Bonfire and the MRSC Small Works Roster — the cheapest step and the one worth doing first.

## 8. In-job margin levers

Not sourcing, but they decide what a won job is worth. All industry estimates.

| Lever | Effect |
|---|---|
| Board length optimisation | 8/10 ft sheets → 15–20% scrap on tall walls; ordering 12/14/16 ft to match wall height cuts waste under 5% and reduces taping labour. **3–5% margin recovery** |
| Turnkey scope expansion | Hanging alone 10–15% gross; adding framing + insulation → **30–45%** |
| Change-order capture | **10–15% of project value**; lost to verbal agreement. Digital field sign-off recovers cost plus 15–20% O&P |
| Value engineering | Single-layer high-STC or engineered shaftwall instead of double-layer standard → **30–40% fewer field labour hours** at the same contract value |

Change-order capture is the only one addressable in software, and it is the strongest argument for
the field-logging concept.

---

*Deck and intake form built from this research: `docs/meetings/2026-07-26-solis/`.*
