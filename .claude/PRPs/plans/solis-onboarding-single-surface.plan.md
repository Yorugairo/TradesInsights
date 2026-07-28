# Plan: fold the calibration intake into the deck — one evidence-and-answer surface

> **STATUS 2026-07-28 — ARCHIVE CANDIDATE, NOT YET VERIFIED TASK-BY-TASK.** All 3 declared deliverables present, and onboarding work landed in `00ee3c5` (public-works lane; fixes the deck silently dropping pill answers) and `f53e0dc` (every deck figure regenerated from one 2026-07-27 snapshot). No report exists and the plan's tasks were not walked individually, so it stays open rather than being archived on partial evidence.


> **Working doc + source of truth.** Every claim in GROUND TRUTH was read out of the two files,
> not inferred. If a claim here disagrees with the code, the code wins and this file gets fixed.

## Summary

Merge `intake.html` into `presentation.html` so a calibration question is asked **on the slide
that shows the evidence for it**, and the answer is captured there. Target display is a **4K 32"
monitor** — the current deck is capped at `1220px` and letterboxes on that screen, so the
redesign is not "fit the form in", it is "use the width we have been throwing away".

## User Story

As **the operator running a calibration session**, I want the number and the question about that
number on screen together, so that the customer answers what he is looking at instead of what he
remembers — and so the answer is recorded in the moment rather than reconstructed afterwards.

## Problem → Solution

**Current:** two artifacts. The deck shows 67 warm-GC projects on a 1220px column in the middle
of a 3840px display; the question "is +3 right?" lives in a separate file the customer never sees
during the walkthrough. Answers are recalled after the fact.
**Desired:** one file. Evidence left, ask right, answers persisted and exportable, full width used.

## Metadata

- **Complexity**: Medium
- **Repo**: `TradesInsights`, `docs/meetings/2026-07-26-solis/`
- **Package manager**: **pnpm** (`pnpm-lock.yaml`; workspaces `apps/*`, `packages/*`).
  *(The sibling registry repo is npm — do not copy commands between them.)*
- **Estimated files**: 1 rewritten, 1 retired-or-generated, 1 test added

---

## GROUND TRUTH (read 2026-07-26, not assumed)

### What already exists — more than expected

**`intake.html` (587 lines) already solves persistence and export.** This was previously assumed
to be the hard part of the merge. It is not; it is done and can be lifted whole:

| Machinery | Where |
|---|---|
| `const STORE = 'solis-intake-2026-07-26'` | `intake.html:421` |
| autosave on every field | `document.addEventListener('input'/'change', save)` — `:554-555` |
| `save()` → `collect()` → localStorage + live JSON preview | `:519-523` |
| `restore()` from localStorage | `:527` |
| Download JSON / copy to clipboard / print | `:558`, `:567`, `:581` |
| Progress counter that counts **question cards, not answer keys** | `:507-517` (`cards()`, `isAnswered()`) |

**`presentation.html` (1,216 lines)** carries a `Deck` class (`:1119`) with slide array,
`go(n)`, IntersectionObserver-driven state, and keyboard/wheel/touch nav.

### The four real conflicts

1. **Keyboard nav swallows typing.** `presentation.html:1185` binds `keydown` on `document` with
   **no input guard**:
   ```js
   if (['ArrowDown','ArrowRight','PageDown',' '].includes(k)) { e.preventDefault(); this.next(); }
   ```
   A space bar inside a text field advances the slide instead of typing a space. Arrow keys can
   never move a caret. **This breaks the moment a form lands in a slide.**

2. **Wheel nav swallows scrolling.** `:1195` — any `deltaY > 12` advances a slide. A scrollable
   panel inside a slide cannot be scrolled with a trackpad.

3. **Slides clip.** `.slide{height:100vh;overflow:hidden}` and
   `.slide-content{max-height:100%;overflow:hidden}` (`:25`, `:33`). Content taller than the
   viewport is **silently cut off**, not scrolled — a long GC table would simply lose rows.

4. **Two different design languages, with a token that means opposite things.**

   | Token | `presentation.html` | `intake.html` |
   |---|---|---|
   | `--ink` | `#0b1220`, used as a **background** (`.slide.dark{background:var(--ink)}` `:93`) | `#111112`, used as **text colour** (`.why b{color:var(--ink)}`) |
   | `--muted` | `#667085` (cool) | `#6b6b66` (warm) |
   | accent | `--accent:#2f5fff` cobalt | `--signal:#d6203c` red |

   Concatenating the stylesheets does not merge two themes; it silently mis-colours both. The
   intake must be **re-skinned into the deck's Electric Studio language**, not pasted in.

### The 4K problem, which is the actual opportunity

`.slide-content{max-width:1220px;margin:0 auto}` (`:33`). On a 3840px-wide display the deck uses
**32% of the screen** and centres it. The owner's note — *"plenty of space, we need more stuff to
fill"* — is this line. Raising the cap is what makes an evidence-beside-ask layout possible at
all; without it there is nowhere to put the ask except below the fold.

### Deck inventory

14 slides (`grep -c '<section class="slide"'`). Intake has **4 sections**: `01 Confirm or
correct`, `02 Scope & constraints`, `03 Volume & timing`, `04 The GCs`, plus an `ASSUMPTIONS`
array (`:376`) of `{id, setting, why, yamlPath}` and a `RELATIONSHIPS` array (`:449`).

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| **P0** | `presentation.html` | 1113–1213 | The whole `Deck` class — nav is where the merge breaks |
| **P0** | `presentation.html` | 19–40 | Snap container + slide box model + the 1220px cap |
| **P0** | `intake.html` | 495–585 | `collect`/`save`/`restore`/export — lift this wholesale |
| **P1** | `intake.html` | 376–420 | `ASSUMPTIONS` question model — the shared source of truth |
| **P1** | `presentation.html` | 160–180 | `.kpis`/`.kpi` — the evidence component the ask sits beside |
| **P2** | `intake.html` | 8–20 | The token set being retired |

---

## Patterns to Mirror

### SNAP_CONTAINER — the gotcha already paid for
```css
/* SOURCE: presentation.html:19-22 — comment says it outright:
   "Put scroll-snap-type on html and it is silently inert" */
body{overflow-y:auto;scroll-snap-type:y mandatory;scroll-behavior:smooth}
```
With `height:100%` on html+body, **body scrolls while `document.scrollingElement` reports html**.
Do not move the snap declaration.

### PROGRESS_COUNTING — count cards, not keys
```js
// SOURCE: intake.html:507-517
const cards = () => Array.from(document.querySelectorAll('.q'));
// "Keying off a hardcoded total drifts the moment a question is added, and counting keys
//  makes one multi-field card look like eight answers — either way the progress figure lies."
```

### PERSIST — already correct, including the private-mode guard
```js
// SOURCE: intake.html:519-523
try { localStorage.setItem(STORE, JSON.stringify(data)); } catch (_) { /* private mode */ }
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `docs/meetings/2026-07-26-solis/presentation.html` | UPDATE | Gains capture panels, wide layout, guarded nav, answers slide |
| `docs/meetings/2026-07-26-solis/intake.html` | KEEP, regenerate | Standalone leave-behind; must not fork from the deck's question set |
| `docs/meetings/2026-07-26-solis/questions.js` | CREATE | One question model both surfaces read — prevents two drifting copies |
| `tests/deck-4k.spec.ts` (or colocated) | CREATE | Viewport-fit + nav-guard regression |

## NOT Building

- **No build step.** These are hand-openable files that must work from `file://` with no server.
  A bundler would make the artifact undemoable on a borrowed laptop.
- **No backend submit.** Answers stay local (localStorage + download/clipboard). Sending a
  customer's commercial answers anywhere is a decision nobody has made.
- **No new design system.** Electric Studio wins; the intake's warm/red palette is retired.
- **No change to the 2026-07-26 answers already in localStorage** — see Task 1 gotcha.

---

## Step-by-Step Tasks

### Task 1 — extract the question model *(do first; everything else reads it)*
- **ACTION**: Create `questions.js` exporting `SECTIONS`, `ASSUMPTIONS`, `RELATIONSHIPS`, `STORE`.
- **IMPLEMENT**: Move the arrays out of `intake.html` verbatim. Add a `slide` field mapping each
  question to the deck slide whose evidence it belongs beside.
- **GOTCHA**: **Keep `STORE = 'solis-intake-2026-07-26'` byte-identical.** Answers may already be
  saved under that key. A new key silently orphans them and the operator finds out mid-meeting.
- **GOTCHA**: `file://` blocks ES module imports in some browsers. Use a plain `<script>` that
  assigns to `window.CALIBRATION`, not `import`/`export`.
- **VALIDATE**: open both files from `file://`; `window.CALIBRATION.ASSUMPTIONS.length` matches
  the old count.

### Task 2 — guard the nav ⟵ **the merge is broken until this lands**
- **ACTION**: Make `Deck` ignore navigation keys while a field has focus.
- **IMPLEMENT**: In the `keydown` handler (`:1185`), bail early:
  ```js
  const t = e.target;
  if (t.closest('input, textarea, select, [contenteditable]')) return;
  ```
  For `wheel` (`:1195`), bail when the event originates inside a scrollable capture panel.
- **GOTCHA**: Space is in the *next slide* list. In a text field it must type a space. This is the
  single most likely thing to embarrass the demo — a customer types a company name and the deck
  jumps two slides.
- **VALIDATE**: focus a field, press Space/ArrowDown/ArrowUp → caret moves, slide index unchanged.

### Task 3 — widen the stage for 4K
- **ACTION**: Replace the fixed `max-width:1220px` with a token.
- **IMPLEMENT**: `--measure:1220px` default; `--measure-wide:min(2200px, 92vw)` on slides carrying
  an evidence+ask split. Prose-only slides keep the narrow measure — a 3840px-wide paragraph is
  unreadable, and "use the space" does not mean "stretch the text".
- **GOTCHA**: Type scale is `vw`-based (`--title: clamp(1.7rem,5vw,4.2rem)`). At 3840px the
  clamp ceiling is already doing the work, so widening the container will NOT blow up type — but
  re-check `--body` and `--micro`, which have lower ceilings and may look small on a wide stage.
- **VALIDATE**: at 3840×2160 no slide scrolls; at 1440×900 the layout still fits.

### Task 4 — the capture panel
- **ACTION**: Add an `.ask` panel to the `foot`/side of each calibration slide.
- **IMPLEMENT**: Compact control (radio band / number / short text) + the `why` line, re-skinned
  to Electric Studio. Reuse `.q` as the card class so `cards()` counts it unchanged.
- **GOTCHA**: `.slide{overflow:hidden}` **clips** rather than scrolls. Either keep each panel
  short enough to fit, or give the panel its own `overflow:auto` — and if you do, Task 2's wheel
  guard is what makes it usable.
- **GOTCHA**: The GC table (section 04) is the one genuinely tall control. Give it its **own
  slide** with an internal scroll region rather than trying to squeeze it beside evidence.

### Task 5 — answers review slide
- **ACTION**: Final slide aggregating every answer, with the existing download/copy/print buttons.
- **IMPLEMENT**: Lift `collect()`, `save()`, `restore()` and the three button handlers from
  `intake.html:495-585` unchanged. Show `answered / total` live.
- **GOTCHA**: `document.addEventListener('input', save)` is global. If both the deck's own script
  and a lifted intake script bind it, `save()` runs twice per keystroke — harmless but it will
  double-write localStorage on every character. Bind once.

### Task 6 — regenerate the standalone intake
- **ACTION**: Rebuild `intake.html` from `questions.js` so it stays a valid leave-behind.
- **CONTEXT**: He may want to finish alone afterwards, and print mode already exists
  (`intake.html:138`). Two hand-maintained copies of the same questions is how the deck ends up
  asking something the intake does not.

### Task 7 — close-out
Verify at both viewports, commit, update this plan's history with any deviation.

---

## UX Design

### Before
```
┌───────────────────────── 3840px ─────────────────────────┐
│            ┌──────── 1220px ────────┐                    │
│   empty    │  67  warm GC projects  │      empty         │
│   32% used └────────────────────────┘                    │
└──────────────────────────────────────────────────────────┘
        …and the question about it is in another file
```

### After
```
┌───────────────────────── 3840px ─────────────────────────┐
│ ┌──────── evidence ────────┐ ┌──────── the ask ────────┐ │
│ │  67  active near you     │ │ Is +3 right?            │ │
│ │  120 confirmed real      │ │ ( ) less ( ) keep ( )+  │ │
│ │  ── how it's derived ──  │ │ Which have you worked   │ │
│ │  bound · 2+ jobs · in    │ │ with? [__________]      │ │
│ │  territory · relevant    │ │ ▸ saved                 │ │
│ └──────────────────────────┘ └─────────────────────────┘ │
│  ● ● ● ● ○ ○ ○   answered 8/23                           │
└──────────────────────────────────────────────────────────┘
```

---

## Testing Strategy

**Browser pane is a dead end for standalone HTML** (a `file://` outside the project renders as an
unscriptable snapshot; localhost is policy-blocked). Use `@playwright/test` chromium directly.

| Test | Assert |
|---|---|
| viewport fit @ 3840×2160 | every slide's `scrollHeight <= clientHeight` — no clipped content |
| viewport fit @ 1440×900 | same, the laptop fallback |
| **nav guard** | focus an input, press `Space` → value gains a space, slide index unchanged |
| **nav guard** | focus an input, press `ArrowDown` → slide index unchanged |
| nav still works | click the body, press `ArrowDown` → index increments |
| persistence | type, reload, value restored from localStorage |
| store key | `localStorage` key is exactly `solis-intake-2026-07-26` |
| progress | `answered` increments once per card, not once per field |

---

## Validation Commands

**pnpm — not npm.**
```bash
pnpm exec playwright test tests/deck-4k.spec.ts
```
```bash
node --check docs/meetings/2026-07-26-solis/questions.js
```
Manual, and the one that matters:
- [ ] Open `presentation.html` from `file://` on the 4K screen. Walk all slides. Type in a field.
- [ ] Reload mid-deck — answers survive.
- [ ] Download JSON; confirm it carries every section.

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Space bar navigates instead of typing | **Certain without Task 2** | **High — visible to the customer** | Task 2 first; explicit test |
| Content clipped by `overflow:hidden` | High | High — silent data loss on screen | Viewport-fit test at both sizes |
| Token collision mis-colours the merge | High | Medium | Re-skin, never concatenate |
| Existing localStorage answers orphaned | Medium | **High — unrecoverable** | Keep `STORE` byte-identical |
| Widening makes prose unreadable | Medium | Medium | Wide measure only on split slides |
| Two question copies drift | Medium | Medium | `questions.js` is the single source |

---

## Plan history

**2026-07-26 — v1.** Written after reading both files end to end. Two prior assumptions, stated in
conversation, were wrong and are corrected here:

1. *"Persistence is the real work."* It is already built — localStorage autosave, restore,
   download, clipboard, print, and a progress counter that deliberately counts cards not keys.
   The merge inherits all of it.
2. *"It's two HTML files, so folding them together is mostly layout."* They are two **design
   systems**, and `--ink` is a background in one and a text colour in the other. Concatenating
   the stylesheets silently mis-colours both surfaces.

The genuinely hard part is neither: it is that `Deck`'s keyboard handler calls `preventDefault()`
on Space with no input guard, so the deck is unusable as a form until Task 2 lands.

**2026-07-27 — v2. Task 5's "lift `collect()` unchanged" was not done unchanged, and it cost
every pill answer on the deck.**

The lift dropped one branch:

```js
document.querySelectorAll('.pills[data-group]').forEach((g) => {   // absent from the deck
  const picked = g.querySelector('input:checked');
  if (picked) answers[g.dataset.group] = picked.value;
});
```

…and its `restore()` counterpart. Consequence: **radio answers typed into the deck never
reached the export, and were wiped on reload.** Every pill question was affected — the weight
vector, relationship price, closed windows, review depth, certs, scope book, threshold, age
window — i.e. most of what the audit added in the first place.

What made it survive review is worth recording, because the same shape will recur:

1. **The progress counter validated the wrong thing.** `isAnswered()` checks
   `q.querySelector('input:checked')`, so a pill counted as answered. The operator got
   on-screen confirmation *and* an export missing the answer — strictly worse than a visible
   failure, because it is discovered days later while applying the config diff.
2. **The existing tests could not catch it.** "Every question in the model reaches the deck"
   asserts *mounting*. Mounting was never broken; **harvesting** was. A shared question model
   with per-surface I/O needs a **round-trip** test per surface, not a render test.

Pinned by `tests/deck-4k.spec.ts → "a pill answer survives export and reload on the deck"`.
That test must set its own viewport: at the runner's small default the three-card ask column
packs tightly enough that a neighbouring card wins the hit test, which reads as a product bug
and is not one — the deck targets 4K, with 1440×900 as its declared laptop fallback.

Also added in v2: the public-works pair (`sPW1`/`sPW2`) and four questions replacing the single
`public_work` ask, whose framing ("not bonded ⇒ exclude public work") was backwards. See the
session README for the statutory table and its verification date.
