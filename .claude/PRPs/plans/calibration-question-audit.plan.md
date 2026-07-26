# Plan: calibration question audit — what we should be asking and are not

> Audit run 2026-07-26 against `config/account-profiles.yaml`, `packages/intelligence/src/scoring.ts`
> and the live post-rescore signal counts. Every gap below is evidenced, not intuited.

## Summary

The intake covers **everything anyone previously wrote down**: all 7 `owner_assumed` items and
all 8 `calibration_pending` items, each carrying the `yamlPath` its answer maps to. That part is
clean.

What it does not cover is everything we learned **this week** — and one thing nobody ever wrote
down: **the scoring weight vector itself has never been put to the customer**, and it is five
placeholder numbers the config openly calls provisional.

## Verdict

| Question set | Covered? |
|---|---|
| `owner_assumed` (7) | ✅ 1:1 with `ASSUMPTIONS[]` |
| `calibration_pending` (8) | ✅ all asked, all with a yamlPath |
| **The weight vector** | ❌ **never asked** |
| **What a real GC relationship is worth** | ❌ never asked |
| **What `verified_gc_on_project` is worth** | ❌ never asked |
| **Which scope book should rank highest** | ⚠️ asked as prose, never as a weighting |
| **What to do with closed bid windows** | ❌ never asked (46% of his priority list) |
| **WaaS capability confirmations** | ❌ exists in no artifact |

---

## GROUND TRUTH

### The weight vector is five provisional placeholders

```yaml
# config/account-profiles.yaml — solis_interiors
# Spec §12.3 — do NOT finalize weights until Solis confirms scope, territory,
# capacity, minimum job size, preferred GCs, and public-work eligibility.
# These equal-weight placeholders are provisional.
score_components:
  - { component: trade_fit,         weight: 30 }
  - { component: package_size_fit,  weight: 25 }
  - { component: timing,            weight: 20 }
  - { component: geography,         weight: 15 }
  - { component: evidence_quality,  weight: 10 }
```

The intake asks about **geography** (`geo_weight`) and **timing** (`stage_weight`) as behaviours,
and touches trade/package fit sideways through the books A–D ranking. It never asks him to weigh
the five against each other. This is the model that orders his entire list, it is flagged
provisional in its own config, and the one person who can settle it is in the room today.

### Signals that fire but are priced at zero

Post-rescore counts, Solis pool:

| Signal | Fires | Weight today | Asked? |
|---|---:|---|---|
| `warm_gc_active` | 67 | **+3** | ✅ new this session |
| `verified_gc_on_project` | 120 | **0** | ❌ |
| `commercial_bid_window_likely_closed` | 220 | routing only | ❌ |
| `drywall_painting_keywords` | 220 | 0 (§12.3) | ❌ |
| `restoration_scope` | 16 | 0 (§12.3) | ⚠️ prose only |
| `residential_remodel_scope` | 8 | 0 (§12.3) | ⚠️ prose only |
| `specialist_assembly` | 7 | 0 (§12.3) | ⚠️ prose only |

The §12.3 scope signals were shipped deliberately unweighted *"so the evidence accumulates from
today rather than starting at zero the day someone decides to weight them."* That day is today,
and the intake asks him to describe his scope in prose rather than to rank it.

### The relationship lift is unbuilt, and he is here once

`relationships.ts` is real, but only suppression is wired — `blocked` / `do_not_pursue` /
`incumbent_blocked` kill alerts. Nothing reads `active_relationship` or `preferred`. The intake
now says so honestly and asks him to name GCs. It does **not** ask the follow-up: *when we do
wire it, how much should it be worth?* Asking costs one line while he is thinking about the
names anyway; not asking means a second session to price it.

---

## The gaps, ranked by leverage

### G1 — the weight vector *(highest; nothing else reorders his list this much)*
Ask him to rank the five components, or at minimum name the **top one and bottom one**. A full
1–5 ranking from a contractor mid-meeting is optimistic; "which of these matters most / least"
is answerable in ten seconds and is enough to break the equal-weight placeholder.
- **yamlPath**: `score_components[].weight`

### G2 — the price of a real relationship
"Once we can tell that you have worked with a GC before, should that job jump: a nudge like the
+3, a big lift, or straight to the top?" Ask it **on the GC slide**, while he is naming them.
- **yamlPath**: `score_components -> relationship_lift (not yet wired)`

### G3 — the price of a confirmed real company
120 jobs carry it, it is worth nothing, and it is the signal that tells him *he can find out who
to call*. Plausibly worth more to him than warm-GC.
- **yamlPath**: `score_components -> verified_gc_on_project`

### G4 — which book should rank highest
Not "what do you do" (already asked) but "of restoration, Level 5 / smooth wall, TI commercial,
and everyday hanging — which should we push to the top of your list?" Owner research says
**restoration is the best-margin book and is structurally unsourceable from permits**; if that
is right, `restoration_scope` should probably carry real weight and only he can authorise it.
- **yamlPath**: `score_components -> scope book weighting (§12.3 signals)`

### G5 — closed bid windows
220 of 479 priority jobs (46%) are flagged `commercial_bid_window_likely_closed`. Today they are
shown. Ask: hide them, keep showing them lower, or keep them because a late call sometimes
lands? Ask it **on the slide showing the 46%**.
- **yamlPath**: `rules -> routing (closed-window handling)`

### G6 — WaaS capability confirmations
Seven landing pages are built and withheld from search pending confirmation he takes the work:
water damage, popcorn ceiling, soundproofing, fire-rated, metal stud framing, Seattle, Bellevue.
Each answer flips one `indexable` flag. This exists in **no** artifact today.
- **Target**: `apps/registry/scripts/solis-landing-pages.mjs` → `indexable`
- Overlaps G4 but is more concrete: a yes/no per service, not a ranking.

### G7 — minor, worth one line each
- Any other entities or DBAs? (`excluded_ubis` lists one closed entity; is that the only one?)
- Who else should receive the digest? The registry has Javier (Manager) and Daniel (Supervisor)
  on file; today only one forwarding email is captured.

---

## Cost check — this is a session, not a form

Six new questions is real meeting time. Recommended split:

| Ask today | Defer |
|---|---|
| G1 (top/bottom only), G2, G5, G6 | G3, G4 full ranking, G7 |

G2 and G5 cost nothing extra because they ride on slides already being presented. G6 is a rapid
yes/no list. G1 is the one worth interrupting for.

---

## Step-by-Step Tasks

### Task 1 — intake reads `questions.js` *(the alignment fix; do first)*
- **ACTION**: Delete the duplicated `ASSUMPTIONS`/`RELATIONSHIPS`/`STORE` from `intake.html`;
  add `<script src="questions.js"></script>` and read `window.CALIBRATION`.
- **GOTCHA**: `questions.js` uses `->` in `yamlPath`; the intake's `collect()` ran
  `.replace(/&rarr;/g, '->')`. That replace is now a no-op but harmless — leave or drop, do not
  "fix" it into double-escaping.
- **GOTCHA**: Keep `STORE` byte-identical. Answers may already exist under it.
- **VALIDATE**: open `intake.html` from `file://`; all 7 assumption cards render; a saved answer
  from the deck restores in the intake and vice versa (**same key, same shape**).

### Task 2 — add the new questions to `questions.js`
- **ACTION**: Extend with a `QUESTIONS[]` array for the non-assumption asks, each with
  `{id, slide, ask, why, yamlPath, kind}` where `kind` drives the control (`pills` | `text`).
- **IMPLEMENT**: G1, G2, G5 wired to slides already in the deck (`s11`/weights, `sGC`, `s4`).
- **GOTCHA**: The deck's `Capture.mount()` currently renders only `ASSUMPTIONS`. Extend it to
  render `QUESTIONS` too, keyed on the same `slide` field.

### Task 3 — G6 as a capability checklist
- **ACTION**: A compact yes/no list of the seven withheld services on its own slide.
- **IMPLEMENT**: Export answers under `waas_capabilities`, so the flip is mechanical:
  each `yes` → `indexable: true` in `solis-landing-pages.mjs`, then re-run the seed.

### Task 4 — close-out
Re-run `npx playwright test tests/deck-4k.spec.ts` (the fit assertions are what catch a slide
that grew too tall), commit, update Plan history.

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Adding questions overruns the session | **High** | Medium | The defer column above; G2/G5 ride existing slides |
| Asking for a 1–5 ranking gets a shrug | High | Low | Ask top-and-bottom only |
| New questions push a slide past `overflow:hidden` | Medium | **High — silent clipping** | Fit test at both viewports is already written |
| G4 answered casually becomes a real weight | Medium | Medium | Capture as `calibration_pending`, not a live weight, until reviewed |

## Plan history

**2026-07-26 — v1.** Audit found the previously-written question sets complete and well-formed
(every question carries a yamlPath). The gaps are all things learned in the last 48 hours —
plus `score_components`, which has been provisional in config since 2026-07-15 and was never
converted into a question at all.
