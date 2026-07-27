# TASTE-insights.md — the Insights cockpit

Status: current
Last reviewed: 2026-07-27

This file documents why the Insights cockpit should feel the way it feels. It is
not a token inventory — `apps/web/app/globals.css` explains *what* to render;
this explains what future design work should optimize for.

Method is adapted from the Registry platform's `TASTE.md` (dials, core moves,
anti-patterns, QA checklist). The *content* is deliberately different: that
document is written for a public directory that must convert high-intent
visitors and stay crawlable. **Insights is a private, login-gated operator
tool.** None of the SEO, crawlability, or conversion rules transfer, and
importing them produces marketing-shaped operator pages.

## Intent

The cockpit should feel like a **decision instrument**: something a contractor
opens at 6am, reads for ninety seconds, and closes knowing which three jobs to
call about and why those three.

It should make the evidence visible, make the recommended action unmissable, and
make an inference impossible to mistake for a fact. It should never look busy in
order to look valuable.

The measure of a good screen here is not beauty. It is: **could the user act on
this without asking us where the number came from?**

## Design Dials

| Surface | DESIGN_VARIANCE | MOTION_INTENSITY | VISUAL_DENSITY |
|---|---:|---:|---:|
| OTN public directory *(reference)* | 4 | 2 | 7 |
| GoBJJ product/admin *(reference)* | 3 | 2 | 8 |
| **Insights cockpit** | **6** | **4** | **7** |
| **Insights admin queues** | **4** | **2** | **8** |

- `DESIGN_VARIANCE` — how far layout may move from predictable symmetry.
- `MOTION_INTENSITY` — how much animation may explain hierarchy and state.
- `VISUAL_DENSITY` — how much information belongs in each viewport.

**Why higher than both references** (owner, 2026-07-27): OTN is public and pays
for crawlability, bundle size and public LCP. Insights is behind a login and pays
none of them, so it can afford richer interaction and more design. That is the
entire justification — it is not licence for decoration.

Density stays at 7, not 3. This is a working tool. An operator wants a hundred
rows on screen; the Compact density mode exists because even 7 is sometimes too
generous.

**Motion at 4 means motion explains state.** A row settling when its band
changes, a gate opening, a bid clock counting down. It does not mean entrance
animations, parallax, or anything that delays the first useful pixel. Every
transition honours `prefers-reduced-motion` (already enforced globally in
`globals.css`).

## Core Moves

### 1. Proof is the material

Do not decorate first. Start from what the pipeline already proved: score and its
components, corroboration across distinct sources, confirmed facts vs.
inferences, publication-gate state, evidence chains, bid windows, stage lag,
detection lag.

Turn those into the visual system — stat tiles, range bars, source chips,
confidence meters, gate badges, stage ladders.

**The strongest asset this product has is that every number is traceable to an
artifact.** Competitors show a number. We can show the number, its sources, its
contradictions, and what we could not verify. Design that, and the UI is doing
the selling.

### 2. One screen, one next action

Every page answers "what do I do next" before it answers anything else. The
recommended action is the loudest element on an opportunity, not a paragraph
under the fold.

If a screen cannot name a next action, that is a product finding worth
surfacing — not a gap to fill with a chart.

### 3. Unknown is a value, and it renders

The pipeline is careful to distinguish *no evidence* from *evidence of zero*: an
orphaned run's `parsed_count` is an unwritten column, not a measurement; a
`county` of null on a statewide solicitation is correct, not missing; "registry
seam offline" is shown instead of a fake zero.

**The UI must preserve every one of those distinctions.** A meter that renders
unknown as an empty bar tells the user something false. Use `—` for absent
values — the convention already established across both codebases. Never `0`,
never a blank cell, never a zero-width bar.

### 4. An inference must never read as a fact

The decision brief validator already rejects unsubstantiated numbers and unknown
evidence refs server-side. The UI must not undo that work visually. Confirmed
facts and inferences get visually distinct treatments that survive a squint test.

### 5. Dense, but ranked

Density without hierarchy is the data dump we are leaving. Every dense surface
needs one obvious entry point: the highest-scoring row, the closest deadline,
the lane with the most work. Rank first, then fill.

## Anti-Patterns

Do not ship:

- a number without its basis when the basis exists;
- unknown rendered as zero, blank, or an empty bar;
- an inference styled the same as a confirmed fact;
- fabricated counts, dates, contractors, or scores to make a layout look fuller;
- cards inside cards;
- a card that has no job — every card is an entity, a proof, an action, a status, or a framed tool;
- generic SaaS gradient heroes, decorative orbs, or abstract blob art;
- centered marketing sections on operational routes;
- giant hero type inside a compact panel;
- gray text on a coloured background with weak contrast;
- a colour pair added without its measured ratio;
- motion that delays first useful content, or that is required to understand the page;
- hover-only affordances where the action disappears on touch;
- duplicate CTAs with the same label and different destinations;
- a nav item that 404s (we shipped one — `/app/admin/coverage`);
- a front-door page unreachable from the nav (we shipped one — `/app/admin/cockpit`);
- changing a `data-testid` or an asserted heading string to suit a layout.

## Design Vocabulary

Terms for future work, so a request is actionable:

- **Clarify** — make the purpose, next action, or ranking basis obvious.
- **Distill** — remove duplicate copy, duplicate CTA, or redundant cards.
- **Proof-load** — replace a bare claim with visible evidence.
- **Bolder** — increase contrast, scale, or hierarchy of one important action.
- **Quieter** — reduce decoration, chroma, shadow, or competing actions.
- **Typeset** — fix hierarchy, line length, wrapping, and metric typography.
- **Harden** — test overflow, empty states, loading, focus, reduced motion, and mobile tap targets.
- **Densify / Loosen** — move a surface along the VISUAL_DENSITY dial deliberately.

## Registers

Two, both defined in `apps/web/app/globals.css`:

- **Dark (default)** — deep evergreen `#061109` with gold `#d4af37`. The premium
  cockpit register. Ported verbatim from OTN so Insights and OTN read as one
  company.
- **Light** — OTN's `--lt-*` clinical template, for daylight and print.

Components never reference a raw hex. They consume the semantic contract
(`--surface-bg`, `--surface-ink`, `--surface-muted`, `--surface-accent-ink`,
`--surface-track`, `--chip-bg`, `--chip-border`), which is the same contract
OTN's `StatTile` / `SourceChip` / `RangeBar` already consume — so those
primitives port without edits and flip registers for free.

## QA Checklist

Before shipping a meaningful UI change:

- Screenshots at **1440x900**, **768x1024**, **390x844** show no overlap,
  overflow, unreadable text, or awkward wrapping.
- The first viewport communicates what the page is and what to do next.
- Every card has a job.
- Every colour pair carries its measured contrast ratio in a comment; body text
  is **≥ 4.5:1**.
- Buttons have distinct purposes and visible focus states.
- Keyboard-only: every action reachable, focus always visible.
- `prefers-reduced-motion` removes motion without removing meaning.
- Empty, unknown, and error states were opened deliberately — not assumed.
- No fabricated value was added to make the UI look fuller.
- **`pnpm --filter @otn/web test:e2e` is green with ZERO edits to any spec
  file.** The suite selects by `data-testid` and ARIA role, so it is the
  regression net that makes redesign safe. If a test fails, the markup is wrong.
