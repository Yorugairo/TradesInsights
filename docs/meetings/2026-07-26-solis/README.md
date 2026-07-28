# Solis calibration session — 2026-07-26

Two self-contained HTML files. No server, no network, no dependencies — double-click
either one. Fonts load from Google when online and fall back to system faces when not,
so both work offline in a customer's office.

| File | Use |
|---|---|
| `presentation.html` | 24 slides + 6 appendix. Arrow keys / space / swipe / scroll. |
| `intake.html` | The working form. Fill in live; export at the end. |

Slide numbers are **generated at runtime** (`Deck.number()`), main as `01..` and
appendix as `A1..`. Insert a slide anywhere without renumbering anything; mark
appendix slides with a bare `data-appendix` attribute.

**Order of play is written by slide title, not number, on purpose.** Numbers are
generated at runtime, so any insert silently shifts every number printed here and the
operator ends up reading a runbook that disagrees with the screen mid-session.

## Order of play

1. **Opening through "Drywall and paint are not bought at the same moment"** — the
   product, the timing argument, the live numbers.
2. **"Where drywall money is" → "We can see two of the four"** — the four books of
   business and our honest coverage of them.
3. **"Washington built a bidding lane" → "Bonding is not the gate"** — the public-works
   pair. A fifth book, and the only one where our sourcing is structurally *strongest*.
   Four questions capture here.
4. **"Distance is the wrong filter"** — the King County tension. **This is still the most
   valuable single slide in the deck.**
5. **"Seven settings we chose for you without asking"** — switch to the form here.
6. **`intake.html` section 1** — walk those same seven, confirm or correct each.
7. **Sections 2–4** — books of business, scope, certifications, the unknowns, then the
   GC list (highest value in the session).
8. **Download answers** — writes `solis-calibration-2026-07-26.json`.
9. **Appendix A1–A6** — only if the conversation goes there. Capability ladder, margin
   levers, route into Tier-1 bidding, and two software concepts.

## The five findings to lead with

- **Slide 9 — assumption 2 may be backwards.** Commercial TI concentrates in Seattle and
  Bellevue; Level 5 luxury in Bellevue, Medina, Mercer Island and Kirkland. All King County
  — the county the geographic weighting cut from 334 priority opportunities to 142, and which
  now sits at **85** after the v1.12.0 issued shave. If A and B are where the money is, the
  setting is suppressing his best work. This is the single highest-value correction available
  in the session.
- **Slide 8 — restoration is structurally invisible.** Insurance patch work generally pulls
  no permit, so the book with the best net margin is one the sourcing cannot reach. Say it
  before he discovers it.
- **"Nearly half your list was past bidding" — lead with the fix, not the problem.** That
  slide used to argue 46% of the priority list was already too late to bid. Scorer v1.12.0's
  issued shave changed it: re-measured 2026-07-27 it is **3.9%** (9 of 233), and application
  stage went 38% → **62%**. The slide now runs as a before/after. **Do not present it as an
  open problem** — you would be showing Solis an unsolved version of something already fixed.
  The honest half: the 194 closed-window jobs were *demoted to the digest*, not deleted.
- **The contractor signals no longer fire zero times.** `verified_gc_on_project` now carries
  **125** jobs (**31** on the priority list) and `warm_gc_active` **72** (**16** priority).
  The old "it fires zero times" disclosure has **expired** — it was a good credibility play
  while true, and repeating it now would be inaccurate in our own favour's opposite direction.
  The live disclosure is that verified-GC is still **worth nothing to the score**.
- **"Bonding is not the gate" — we were about to exclude the wrong thing.** The form used
  to ask one question, *"are you bonded? if not we exclude public work"*. That is wrong in
  the direction that costs money: **RCW 39.08.010** lets a contractor swap the performance
  and payment bond for 10% retainage on any contract of **$150,000 or less** — which is
  precisely the band a five-person drywall crew works in. A "no" would have suppressed the
  one public-works segment that needs no bond at all. The real constraint is working
  capital, and it is now asked as its own question.

## Public works — the figures on those two slides

Every statutory number shown to the customer was **verified live against MRSC on
2026-07-27**, not recalled. Re-check before reusing this deck: the roster ceiling is on a
legislated escalator and the citations changed recently.

| Shown | Authority | Note |
|---|---|---|
| Small works roster ≤ **$350k** | RCW 39.04.151 | Current ceiling **through 31 Dec 2026** |
| Rising to **$650k** by July 2030 | HB 2420 (2026) | Phased: $530k Jan 2027 → $560k → $590k → $620k → $650k Jul 2030 |
| Direct contracting **< $150k** | RCW 39.04.152(4)(b) | Flat — the escalator does **not** move this |
| Rule of six, and rotation | RCW 39.04.152 | 6+ certified small businesses ⇒ award **must** go to one, rotating |
| 10% retainage **instead of** bonds ≤ $150k | RCW 39.08.010 | **At the contractor's request**, 30 days after final acceptance |
| Under $5k, both waivable | RCW 39.04.152(5) | **Agency's discretion** — not an automatic removal |

Two traps worth knowing before you are asked:

- **Between $5k and the ceiling, P&P bonds are still required.** Retainage can be reduced
  or waived there, but the bond cannot. The ≤$150k retainage swap is the only real bypass,
  which is why the slide says "a lane, not a loophole".
- **RCW 39.04.155 is superseded** — replaced by RCW 39.04.151–154 effective 1 July 2024.
  Any older note citing `.155` is out of date.

The `~30–60 day` payment-terms figure carries a `~` because it is **industry practice, not
statute** — it follows the same labelling rule as the margin figures below.

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

Originally from `docs/calibration-prep-solis.md` §0 (2026-07-26), **re-measured against
production 2026-07-27** after scorer v1.12.0 landed. Regenerate with
`cd apps/worker && set -a && . ../../.env && set +a && pnpm exec tsx calibration-sensitivity.mts`.

**Every figure in the deck now comes from the same 2026-07-27 snapshot.** That matters more
than any single number: the previous deck mixed a pre-v1.12.0 slide (s4's 46%) with a
post-v1.12.0 world, and the two contradicted each other on screen. If you refresh one figure,
refresh them all from one run.

The current snapshot, for cross-checking:

| | Value |
|---|---|
| Live pool (score ≥ 65, not archived) | 1,244 |
| Priority (≥ 80) | 233 |
| Weekly flow at 80 (30-day average) | ~29 |
| Stage mix of priority | applied 145 (62%) · issued 84 (36%) · later 4 |
| Past bidding, in priority | 9 (3.9%) |
| Past bidding, whole pool | 194 — demoted to digest |
| County mix | Pierce 123 · King 85 · Thurston 13 · Lewis 12 |
| `verified_gc_on_project` | 125 (31 priority) |
| `warm_gc_active` | 72 (16 priority) |
| Application-stage jobs | 531 — 170 filed ≤4wk, 96 in review >12wk |

Two things worth knowing before you present them:

- **The weekly figure is the 30-day average, not a single week.** A one-week point measure
  on this data is one sample of a bursty process — it read 13/wk on 2026-07-26 against a true
  ~29, understating the product roughly 2×. Quote the averaged number.
- **Slide 9's Thurston bar is small on purpose.** The home-metro up-weight is working;
  Thurston volume is genuinely thin (13 of 233). That is a coverage problem to own, not
  a weighting problem to explain away.

## After the session

Apply the export against `config/account-profiles.yaml`, moving each confirmed item out of
`owner_assumed`. Weight changes follow the §12.3 protocol — name the label evidence, apply
on a branch, rerun `pnpm eval:run`, re-baseline the gates with the owner present.
