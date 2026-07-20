# Insights requirements for Solis — updated for the pre-permit product surface

**Client:** Solis Interiors (drywall + painting; UBI 604837560). Independent company —
**not** Lacey Glass (that is a separate client and a separate calibration).
**Last updated:** 2026-07-20, for the expanded pre-permit surface (Olympia
application-stage + Tumwater DRC/SEPA + the registry shared-vocabulary loop).
**Companion docs:** `docs/domain-bid-timing.md` (the bid-window model),
`docs/calibration-prep-solis.md` (the deterministic calibration numbers),
`docs/runbooks/registry-seam-golive.md` (how to turn the surface on).

This is the requirements contract: what Insights must deliver for Solis, what changed
this cycle, and what is deliberately deferred to the calibration session. Every
"MUST/SHOULD" is testable against stored data or an existing unit test.

---

## 0. The product surface (what Solis actually receives)

A weekly digest + in-app opportunity feed of interior work in the home metro, where
each opportunity carries: a **fit score** (Solis scorer, `SCORING_ALGORITHM_VERSION
1.8.0`), a **per-trade bid-window line** (drywall 🔨 / paint 🎨, "bid now / opens in N
wks / likely closed"), an **easy-win** flag ("⚡ Winnable now"), and — once the
registry seam is live — a **GC identity** line (verified GC, warm relationship). The
priority threshold is **80** (~13 changed/week; reviewable). See
`docs/calibration-prep-solis.md` §1–§2 for the standing counts.

---

## 1. What changed this cycle (the delta these requirements encode)

| # | New capability | Why it matters to Solis |
|---|---|---|
| 1 | **Olympia application-stage feed** (`permit_applied`, not just issued) | The commercial bid window is 2–6 months **before** issuance; application-stage is the earliest home-metro lead we can see legitimately. |
| 2 | **Tumwater DRC + SEPA pre-permit feeds** | Plan-review / entitlement stage in the second home-metro city — same early-window rationale. |
| 3 | **Registry shared trade taxonomy** (`trades_taxonomy_v1`) → Insights-derived matcher | Detects finish trades (drywall/paint/glazing) from permit **text**, not a hard-coded list — the trades Solis actually bids. |
| 4 | **Registry identity in scoring** (`verified_gc_on_project`) | "Is the GC on this project a real, resolved entity?" — a trust signal, score-neutral until calibration. |
| 5 | **Warm-network signal** (`warm_gc_active`) | Surfaces projects whose GC Solis already has a relationship with — score-neutral until calibration. |

---

## 2. Requirements by capability

### R1 — Sourcing / pre-permit coverage
- **R1.1 (MUST)** Solis opportunities MUST include home-metro **pre-issuance** records,
  not only `permit_issued`. Olympia contributes `permit_applied` via
  `olympia_smartgov_reports` (applications report); Tumwater contributes
  plan-review/entitlement via `tumwater_development_review` + `tumwater_sepa`.
- **R1.2 (MUST)** These capture-fed sources MUST run only via the operator-local path
  (`pnpm source:run:operator-local`) over genuine-browser captures. No datacenter
  scheduling, no bot driving, no Akamai/`eid` bypass. (Enforced: `cadence: on_demand`
  + `operatorLocalSources()`; live `fetch()` dead-letters.)
- **R1.3 (MUST)** Each captured report MUST self-reconcile before any record is
  emitted — every category count == its printed `Total … : N` and the whole report ==
  its Grand Total (`checkInvariants` empty). A mismatch reds the source and suppresses
  it rather than shipping a mis-parse. (Enforced: Olympia issued 572 / applications
  815, both exact, `parserVersion 1.1.0`.)

### R2 — Trade matching (is this a Solis job?)
- **R2.1 (MUST)** The trade matcher MUST derive from the registry shared vocabulary
  (`registry_public.trades_taxonomy_v1`) when the seam is live, and fall back to the
  built-in permitType-only vocabulary when it is not — byte-identical pre-taxonomy
  behavior with no registry. (Enforced: `packages/resolution/src/trade-taxonomy.ts`
  `fetchTradeTaxonomy` skip-safe → null; `buildTradeMatcher`.)
- **R2.2 (SHOULD)** For a **bound** GC's project, the matcher SHOULD also scan project
  title/description for finish-trade keywords, at a **de-rated** confidence
  (`trade_<code>_desc`, role 0.5, review-gated) — permitType remains authoritative
  (role 1). Rationale: interior scope often lives in the description, not the permit
  type. `general_contractor` has an empty keyword set, so it is never inferred from
  text (assignment-only).

### R3 — GC identity (who is on the other side of the table?)
- **R3.1 (MUST)** When an Insights org is bound to a registry entity by a **strong
  identifier** (human/strong-key only — never auto-bound), scoring MUST expose it:
  `verified_gc_on_project` fires and `gc_identified` lifts. (Enforced:
  `scoring.ts:455`, test at `scoring.test.ts:460`.)
- **R3.2 (MUST)** Registry corroboration MUST be **bounded** — it raises trust, it does
  not fabricate a lead or override a weak signal (`registryCorroborationBonus`, A.4).
- **R3.3 (MUST)** No homeowner PII may cross into the registry bridge. The
  person-vs-business gate keeps `organizations[]` empty for home-metro capture sources;
  Tumwater indexes carry no party data at all.

### R4 — Timing / bid window (can Solis bid this now, and if not, when?)
- **R4.1 (MUST)** Each interior-trades opportunity MUST carry a per-trade bid-window
  line computed on the correct **track**: residential = 4–8 wks (drywall) / 6–12 wks
  (paint) **after** issuance; commercial = 2–6 months **before** issuance (GMP
  buyout). (Enforced: `packages/intelligence/src/bid-window.ts` `tradeBidWindow(s)` +
  `bidTrackFor`; scorer folds it in at v1.7.0; 21 unit tests.)
- **R4.2 (MUST)** The application-stage feed (R1.1) MUST drive the **commercial** side:
  a commercial project at `permit_applied` / plan review is a *live, extended* bid
  window (WA commercial permits take 4–12+ months), not a stale lead.
- **R4.3 (SHOULD)** Residential paint whose estimated exterior-application period lands
  Nov–Apr SHOULD append the PNW exterior-season caveat, always labeled an inference.
- **R4.4 (MUST)** Every timing/bid statement MUST be labeled an inference — it is a
  domain model over public dates, not a fact from the source.

### R5 — Scoring & the §12.3 calibration gate
- **R5.1 (MUST)** New identity/warm signals travel in `signals[]` with **zero account
  weight** until Solis confirms scope. Score is unchanged the day the seam turns on;
  only the rationale gains lines. (`verified_gc_on_project`, `warm_gc_active` are
  score-neutral by construction.)
- **R5.2 (MUST)** Any weight change (identity, warm-network, application-stage
  up/down-weighting, county mix) is made **only** in the calibration session and
  versioned in `config/account-profiles.yaml` + a scorer version bump — never inferred
  silently.
- **R5.3 (SHOULD)** Solis's resolved routing rules stay: no minimum job size; King
  jobs under $10k are digest-band not priority (v1.6.0); residential new construction
  in the home counties is in-scope (v1.8.0).

### R6 — Governance / privacy (invariants, not tunables)
- Capture genuine bytes only; never bypass a bot control. Unknown source field = null,
  never guessed. Registry is another party's production data: Insights reads
  `registry_public` read-only and writes only `registry_partner` staging; adjudication
  is registry-side. Commit → push immediately (Codex handoff). No secrets/captures in
  the repo.

---

## 3. Calibration gate — decisions for the Solis session

Signals ship score-neutral (R5.1); weights are set deliberately here. Below, ✅ items
carry **owner direction (2026-07-20)** and become implementation tasks (versioned in
`config/account-profiles.yaml` + a scorer bump); ◻ items are still open for the
session. Standing counts are in `docs/calibration-prep-solis.md`.

### ✅ Decided (owner, 2026-07-20) — implement, then confirm with Solis

- **Geographic weighting — up-weight the home metro, not King commercial.**
  Thurston / home-metro is up-weighted **relative to King commercial**; **Pierce
  commercial sits roughly equal**; King commercial is the relatively down-weighted
  bucket. Rationale: Solis's home turf and relationship radius, not distant Seattle TI
  volume. (Implement as a routing/geographic component, not a hard filter — King work
  still surfaces, it just doesn't dominate the priority pool. Versioned in
  `account-profiles.yaml`.)
- **Application-stage weighted ABOVE issued.** A `permit_applied` record ranks **above**
  an otherwise-equivalent `permit_issued` one. Earlier = more lead time to get in and
  build the relationship *before* the GC locks its subs ("by issuance, most have already
  lined up their contractors"); and for commercial the application / plan-review window
  is the **only** live bid window — by issuance it is too late (`domain-bid-timing.md`).
  (Implement as a positive stage-timing weight on `permit_applied` / pre-permit stages;
  the R4 bid-window line still reflects the per-track clock, informational.)
- **`warm_gc_active` — small positive weight.** A project whose GC is in Solis's warm
  set gets a **small** lift (relationship-first, per the philosophy above), not a large
  one. (Implement a small weight; keep it bounded so it nudges rather than reorders.)
- **Easy-win radius — layered proximity bands, no floor.** Replace the single flat
  radius with three concentric bands from the Lacey home point, **nearest first: ≤20 mi,
  ≤35 mi, ≤50 mi** (the outer 50 mi widens the prior 60 km / ~37 mi cutoff). The "⚡
  Winnable now" digest section presents easy-wins closest-band-first. **No valuation
  floor — no job is too small** (customer directive stands); the $2M upper sanity cap is
  unchanged. (Implement in `config/account-profiles.yaml → delivery.easy_win`.)

### ◻ Still open — bring to the session

1. **Priority threshold** (currently 80) — re-check now that Olympia application-stage
   volume is flowing (the standing counts predate this feed; ~13 changed/week at 80).
2. **`verified_gc_on_project` weight** — `warm_gc_active` is decided (small); confirm
   whether "GC is a resolved registry entity" should add any lift on its own, or stay
   a trust annotation only.
3. **Easy-win age window** — radius (layered bands) and floor (none) are decided above;
   the one remaining easy-win question is the last-change age window (≤30 d vs ≤60 d).

## 4. Acceptance criteria

- [ ] Operator-local run emits Olympia `permit_applied` + `permit_issued` records and
      Tumwater pre-permit records, all reconciled (R1.3), zero PII (R3.3).
- [ ] A commercial application-stage opportunity shows a "biddable now (plan review)"
      bid-window line; a residential issued one shows "opens in N wks" (R4).
- [ ] With the seam live and a strong-key-bound GC, the opportunity shows
      `verified_gc_on_project`; a warm GC shows `warm_gc_active`; **the numeric score
      is unchanged** vs seam-dark (R5.1).
- [ ] Trade matcher picks up a drywall/paint job described only in the project text of
      a bound GC's permit, at de-rated confidence (R2.2).
- [ ] Turning the whole surface off (unset `OTN_CAPTURE_DIR` / `REGISTRY_DATABASE_URL`)
      returns the pipeline to today's behavior with no errors.

## 5. References
- Bid-timing model: `docs/domain-bid-timing.md`
- Calibration numbers: `docs/calibration-prep-solis.md`
- Go-live procedure: `docs/runbooks/registry-seam-golive.md`
- Scorer: `packages/intelligence/src/scoring.ts` (v1.8.0), bid window:
  `packages/intelligence/src/bid-window.ts`, trade vocab:
  `packages/resolution/src/trade-taxonomy.ts`, registry signals:
  `packages/resolution/src/registry-observations.ts`.
