# Solis calibration prep — Sunday session (numbers as of 2026-07-17)

Purpose: put real, deterministic numbers behind each decision the calibration session
needs to make. Every figure below is a direct SQL count over stored opportunities /
projects (script: `apps/worker/calibration-sensitivity.mts`, rerunnable). Nothing here
is a model output.

**Scope: Solis Interiors only** (drywall + painting; UBI 604837560). Solis is an
independent company — **not** affiliated with Lacey Glass. The two Lacey Glass accounts
(At Home = residential glass; Commercial = Division 08) are a separate client and a
separate calibration conversation; nothing about them belongs in this session. (The At
Home Pierce-volume question is tracked as its own Lacey Glass item in `docs/STATUS.md` §22.)

Decisions to leave the session with:

1. **Priority threshold** (currently 80)
2. **Easy-win parameters** (`config/account-profiles.yaml` → `delivery.easy_win`, all provisional)
3. **Capacity snapshot (S0)** — crew size, package band, concurrent-bid appetite
4. **Disposition cadence** — who reviews, when, and how feedback flows back

---

## 1. Priority threshold

Standing (non-archived) Solis opportunities at each cutoff:

| Score ≥ | Standing count | Changed in last 7 days | Changed in last 30 days |
|---:|---:|---:|---:|
| 65 | 953 | — | — |
| 70 | 809 | — | — |
| 75 | 671 | — | — |
| **80 (current)** | **482** | **13** | **171** |
| 85 | 369 | 11 | 151 |
| 90 | 142 | 4 | 69 |
| 95 | 22 | — | — |

**Key framing:** the 482 is a *standing backlog* accumulated from ~2 years of backfill;
the number that hits a Monday email is the *changed-this-week* column — **~13/week at
the current threshold**, which is already reviewable. Recommendation to discuss:

- Keep threshold **80** for the digest flow (13/week is fine), and treat the backlog
  separately — a one-time "top 25 by score" review in the app rather than raising the
  threshold to shrink a number nobody pages through weekly.
- Raising to 90 cuts weekly flow to ~4 — likely *too quiet* for relationship-building.

## 2. Easy-win parameters (the "⚡ Winnable now" section)

Current provisional values: home = Lacey (−122.823, 47.046), radius 60 km,
last-change ≤ 60 days. **No minimum job size** (customer directive 2026-07-17: Solis
takes small jobs; a floor is added only if Solis asks). Upper cap $2M kept as a sanity
ceiling. Counts of *qualifying* opportunities (the digest shows at most 3, highest
score first):

**Radius × age grid** (valuation ≤ $2M, no floor):

| | ≤30 d | ≤60 d | ≤90 d |
|---|---:|---:|---:|
| 40 km | 38 | 61 | 72 |
| **60 km (current)** | 42 | **65** | 76 |
| 80 km | 42 | 65 | 78 |

**Valuation floor sensitivity** (radius 60 km, age ≤60 d, upper cap $2M):

| Lower floor | Qualifying |
|---|---:|
| **none (current)** | **73** |
| $25k | 65 |
| $50k | 65 |
| $100k | 46 |

What the data says (worth confirming against Solis's real capacity):

- **Radius beyond 60 km buys nothing** (65 → 65). The pool is inside 60 km; the real
  question for Solis is whether 40 km is the *practical* crew radius (61 vs 65 — barely
  narrower). Ask where they actually take work: Olympia–Tacoma? Up to Seattle?
- **No floor is now the default** (per customer directive): 73 qualifying, +8 over a
  $50k floor. If Solis later names a smallest-worthwhile package, a $100k floor would
  cut a third (73 → 46). Ask: is there a job size below which it isn't worth a bid?
- **Small-job scope question (raised by the scorer change, v1.5.0):** removing the
  size floor also removed it from `package_size_fit` in the scorer. That lifted Solis
  recall to 100% but pulled 4 small **residential** remodels ($5k–$39k basement/ADU/
  bedroom jobs) into priority in the eval. They were labeled "not a fit" under the old
  minimum-size rule. **Decide at calibration:** does "small jobs" mean small *commercial/
  TI* work, or also small *residential* remodels? If residential is out, that's a
  residential-exclusion filter (a different knob), not a size floor.
- **No $2M–$5M projects are being excluded** (cap change: 65 → 65). Band cap can stay.
- Age 30 → 60 days nearly doubles the pool. If Solis says GCs buy out interiors within
  ~6 weeks of permit issuance, 60 d is right; if sooner, tighten to 30 d.

## 3. Solis priority mix (context for the conversation)

By county (score ≥ 80): **King 334, Pierce 148** — the priority pool is King-heavy
(Seattle commercial/TI volume). Worth asking whether Solis actually wants King work or
whether Pierce/Thurston should be up-weighted (a routing-rule change, versioned in
`config/account-profiles.yaml`).

By stage (score ≥ 80): permit_issued 295, permit_applied 178, complete 6, near_final 2,
unknown 1 — the pool is concentrated exactly where an interior sub wants it
(issued/applied), which supports the easy-win framing.

## 4. Also bring to the session

- **Capacity snapshot (S0)**: crews, max concurrent bids, package sweet spot — feeds
  the valuation band and any future capacity-aware scoring.
- **Relationship state seeding**: the GC league table ranks orgs; Solis marking even
  10–15 known GCs (`existing relationship` / `do not pursue`) makes the "worth meeting"
  list immediately sharper.
- **Bid-inbox forwarding**: authorization is live; confirm the forwarding address /
  process so invitations start flowing (fills the "⏰ Deadlines" digest section).
- **Disposition loop**: agree who clicks pursue/dismiss (one-tap in the email works
  without login) and that dismiss-reasons are worth the extra tap — they feed
  calibration after two digest cycles.

---

*Regenerate all numbers: `cd apps/worker && set -a && . ../../.env && set +a && pnpm exec tsx calibration-sensitivity.mts`.*
