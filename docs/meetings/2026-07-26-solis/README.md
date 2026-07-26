# Solis calibration session — 2026-07-26

Two self-contained HTML files. No server, no network, no dependencies — double-click
either one. Fonts load from Google when online and fall back to system faces when not,
so both work offline in a customer's office.

| File | Use |
|---|---|
| `presentation.html` | 18 slides + 6 appendix. Arrow keys / space / swipe / scroll. |
| `intake.html` | The working form. Fill in live; export at the end. |

Slide numbers are **generated at runtime** (`Deck.number()`), main as `01..` and
appendix as `A1..`. Insert a slide anywhere without renumbering anything; mark
appendix slides with a bare `data-appendix` attribute.

## Order of play

1. **Slides 1–6** — the product, the timing argument, the live numbers.
2. **Slides 7–9** — the four books of business, which of them we can actually see,
   and the King County tension. **Slide 9 is the most valuable slide in the deck.**
3. **Slide 11** — the seven settings we applied without asking. Switch to the form here.
4. **`intake.html` section 1** — walk those same seven, confirm or correct each.
5. **Sections 2–4** — books of business, scope, certifications, the unknowns, then the
   GC list (highest value in the session).
6. **Download answers** — writes `solis-calibration-2026-07-26.json`.
7. **Appendix A1–A6** — only if the conversation goes there. Capability ladder, margin
   levers, route into Tier-1 bidding, and two software concepts.

## The three findings to lead with

- **Slide 9 — assumption 2 may be backwards.** Commercial TI concentrates in Seattle and
  Bellevue; Level 5 luxury in Bellevue, Medina, Mercer Island and Kirkland. All King County
  — the county the geographic weighting cut from 334 priority opportunities to 142. If A
  and B are where the money is, the setting is suppressing his best work. This is the single
  highest-value correction available in the session.
- **Slide 8 — restoration is structurally invisible.** Insurance patch work generally pulls
  no permit, so the book with the best net margin is one the sourcing cannot reach. Say it
  before he discovers it.
- **Slide 16 — the verified-contractor signal fires zero times.** Volunteering a gap he
  cannot yet see is what makes the numbers credible.

## Margin figures are labelled, deliberately

Every industry figure carries a `~` marker and the slides say plainly that they are estimates,
not measurements of Solis's books. Telling a drywall contractor what his own margins are, from
a slide, is the fastest way to lose the room — the numbers are there to frame the question,
and his correction is the answer.

## Why the form is shaped this way

Section 1 is a **confirm-or-correct** pass, not an interview. Territory, geographic
weighting, the easy-win bands and "no job too small" were set from the owner's knowledge
of Solis and are live in scoring today — Solis has never been asked. Presenting them as
open questions would re-open settled decisions and read as disorganised; presenting them
as settled would let an assumption harden into a fact. So they are shown as live settings
awaiting a yes.

The assumption list is authoritative in
`config/account-profiles.yaml → accounts[solis_interiors].owner_assumed`. The form mirrors
it in the `ASSUMPTIONS` array in `intake.html`. **If one changes, change the other** —
they are deliberately 1:1.

## The export

Every captured answer carries the `yamlPath` it maps to, so the JSON can be applied as a
config diff rather than re-typed. Re-typing is where a calibration answer quietly becomes
a different setting.

```json
{
  "account": "solis_interiors",
  "confirmations": [
    { "id": "territory", "yamlPath": "territory.counties_included",
      "verdict": "correct", "correction": "Drop Lewis, add Mason" }
  ],
  "answers": { "threshold": "80", "age_window": "60" },
  "gcs": [{ "name": "…", "relationship": "Worked with" }]
}
```

Answers autosave to browser localStorage as you type, so an interruption loses nothing.
Nothing is transmitted anywhere until someone presses download.

## Numbers in the deck

All from `docs/calibration-prep-solis.md` §0, regenerated 2026-07-26 via
`cd apps/worker && set -a && . ../../.env && set +a && pnpm exec tsx calibration-sensitivity.mts`.

Two are worth knowing before you present them:

- **Slide 12 says a signal fires zero times, and that is deliberate.**
  `verified_gc_on_project` and `warm_gc_active` have never fired for Solis. Leading with
  that costs nothing and buys the credibility that makes the rest believable.
- **Slide 8's Thurston bar is small on purpose.** The home-metro up-weight is working;
  Thurston volume is genuinely thin (38 of 477). That is a coverage problem to own, not
  a weighting problem to explain away.

## After the session

Apply the export against `config/account-profiles.yaml`, moving each confirmed item out of
`owner_assumed`. Weight changes follow the §12.3 protocol — name the label evidence, apply
on a branch, rerun `pnpm eval:run`, re-baseline the gates with the owner present.
