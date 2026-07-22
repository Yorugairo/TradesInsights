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
- **Small-job / residential scope — RESOLVED (2026-07-17):** residential is a valid
  Solis trade, **particularly Thurston/Lewis/Pierce**. King (distant) jobs **under $10k**
  are "valid but lower" (weekly-digest band, not priority); everything else keeps full
  fit. Implemented in scorer v1.6.0 + eval v2. *Still open for the session:* confirm the
  $10k King threshold feels right, and whether other counties want any price banding.
- **No $2M–$5M projects are being excluded** (cap change: 65 → 65). Band cap can stay.
- Age 30 → 60 days nearly doubles the pool. If Solis says GCs buy out interiors within
  ~6 weeks of permit issuance, 60 d is right; if sooner, tighten to 30 d.

**DECIDED (owner, 2026-07-20):** the easy-win radius is **layered into concentric
proximity bands** — **≤20 mi, ≤35 mi, ≤50 mi** from the Lacey home point, nearest band
shown first (the 50 mi outer bound widens the prior flat 60 km / ~37 mi cutoff). **No
valuation floor — no job is too small** (directive stands); the $2M upper sanity cap is
unchanged. Still open: the last-change age window (≤30 d vs ≤60 d). A delivery-config
follow-up in `config/account-profiles.yaml → delivery.easy_win`. See
`docs/solis-requirements.md` §3.

## 3. Solis priority mix (context for the conversation)

By county (score ≥ 80): **King 334, Pierce 148** — the priority pool is King-heavy
(Seattle commercial/TI volume).

**DECIDED (owner, 2026-07-20):** up-weight **Thurston / home-metro relative to King
commercial**; **Pierce commercial sits roughly equal**; King commercial is the
relatively down-weighted bucket. It's Solis's home turf and relationship radius, not
distant Seattle TI volume — but King still surfaces (a geographic routing weight, not a
hard filter), versioned in `config/account-profiles.yaml`. This is a routing/scorer
follow-up, not yet implemented. See `docs/solis-requirements.md` §3.

By stage (score ≥ 80): permit_issued 295, permit_applied 178, complete 6, near_final 2,
unknown 1 — the pool is concentrated exactly where an interior sub wants it
(issued/applied), which supports the easy-win framing.

**DECIDED (owner, 2026-07-20):** application-stage is weighted **ABOVE** issued — a
`permit_applied` project ranks above an otherwise-equivalent `permit_issued` one.
Earlier = more lead time to get in before the GC locks its subs ("by issuance, most
have already lined up their contractors"), and for commercial the application /
plan-review window is the only biddable one (issuance is too late,
`docs/domain-bid-timing.md`). Also decided: a **small** positive weight for
`warm_gc_active` (relationship-first). Both are `account-profiles.yaml` + scorer
follow-ups.

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

## 5. Label ledger — what the humans actually decided (flywheel Phases 1–4)

Every decision since Phase 1 lands in `decision_labels` (migration 0027) with a
snapshot of what the human SAW at decision time (score, band, signals,
corroboration) — plus, since Phase 4, pursuit outcomes (won / lost / no_bid).
These queries are run LIVE at the session; this doc ships queries, not stale
numbers.

```sql
-- Volume by kind
SELECT kind, count(*) FROM decision_labels GROUP BY kind ORDER BY kind;

-- Promote/dismiss by score decile — the core calibration curve
SELECT width_bucket((snapshot->>'score')::numeric, 0, 100, 10) AS decile,
       count(*) FILTER (WHERE kind = 'promote') AS promotes,
       count(*) FILTER (WHERE kind = 'dismiss') AS dismisses
FROM decision_labels WHERE kind IN ('promote', 'dismiss')
GROUP BY 1 ORDER BY 1;

-- Which disclosed signals precede a dismissal
SELECT s.value ->> 'key' AS signal, count(*)
FROM decision_labels d, jsonb_array_elements(d.snapshot->'signals') s
WHERE d.kind = 'dismiss' GROUP BY 1 ORDER BY 2 DESC;

-- Pursuit outcomes (4A.2): what the score said when the human called it
SELECT snapshot->>'outcome' AS outcome, count(*),
       round(avg((snapshot->>'score')::numeric), 1) AS avg_score_at_decision,
       round(avg((snapshot->>'outcomeValue')::numeric)) AS avg_value
FROM decision_labels WHERE kind = 'pursuit_outcome' GROUP BY 1 ORDER BY 1;

-- Per-account precision headline (priority-band dismiss rate = FP proxy;
-- promoted-then-lost is nuance, not error)
SELECT ap.key,
       round(100.0 * count(*) FILTER (WHERE d.kind = 'dismiss')
             / NULLIF(count(*) FILTER (WHERE d.kind IN ('promote','dismiss')), 0), 1) AS dismiss_pct,
       count(*) FILTER (WHERE d.kind IN ('promote','dismiss')) AS decided
FROM decision_labels d JOIN account_profiles ap ON ap.id = d.account_profile_id
GROUP BY ap.key;
```

## 6. Matching evidence — `pnpm --filter @otn/worker match:audit` (4B.5)

Run at the session. Prints, per observation rule (`binding_name_exact`,
`binding_phone_match`, `binding_google_phone_match`, `binding_address_match`,
`binding_domain_match`, `phone_from_lni`, `phone_from_google`,
`alias_name_variant`, `trade_*`): queued/pending/accepted/rejected/auto counts,
the HUMAN-reviewed Laplace accept rate (exactly the `ruleHistory` trust
component the next generation pass uses), trust min/median/max, and the
near-floor band `[0.55, 0.65)` — the population a `MIN_QUEUE_TRUST` change
would admit or evict.

Decisions this evidence supports (never automatic):
- lower/raise `MIN_QUEUE_TRUST` per observed precision of the near-floor band;
- promote a rule toward auto-accept only when its HUMAN history clears the
  existing gates (≥10 decisions, ≥95% accepts — identity bindings stay human
  forever);
- de-rate or retire a rule whose accept rate stays poor after real volume.

## 7. §12.3 weight-change protocol (freeze-lift criteria)

Weights are frozen until this session. To change any:
1. Name the label evidence (§5) motivating each proposed change.
2. Apply on a branch; run `pnpm eval:run` — re-baseline the gates deliberately
   with the owner present, never silently.
3. Update the score-neutrality pins in the same commit as the weights.
4. Freeze lifts only when ≥1 account has ≥50 decided labels.

Standing constraints calibration does NOT touch: identity bindings never
auto-accept; unknown = null; contradictions cite both values; the registry's
Contractor Activity Score (display-side, Phase 4A.1) is never an input to
opportunity scoring.

---

*Regenerate all numbers: `cd apps/worker && set -a && . ../../.env && set +a && pnpm exec tsx calibration-sensitivity.mts`.*
