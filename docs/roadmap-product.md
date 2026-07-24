# Product roadmap — Solis-first (2026-07-17)

> Decision of record: **Solis Interiors (drywall + painting) is the first client and the
> design-lead account.** Every phase below is specified for Solis first; Lacey Glass
> surfaces inherit the same mechanics with their own profile rules. L&I license
> enrichment is **deferred** — the customer's One Trade Network registry database will
> supply contractor identity (see P1.4 join point).
>
> **STATUS 2026-07-17: P1–P5 executed** (see STATUS.md ledger). Remaining: Sunday calibration replaces provisional P2.1 values; OTN-registry import fills `registry_ref` (P1.4).
>
> Companion docs: `docs/BUILD_SPEC.md` (invariants still govern), `docs/STATUS.md`
> (ledger), `docs/roadmap-strengthening.md` (completed hardening track).

## Why Solis-first changes the shape

An interior-trades sub wins work through **GC relationships**, not owner outreach. Paint
and drywall packages are let by the GC weeks-to-months *after* permit issuance, so:

- The **organization graph is the primary product surface** for Solis (P1), with project
  sourcing feeding it — the inverse of the glass-shop framing.
- "Easy win" for Solis = TI/commercial/multifamily at $50k–$2M stated valuation,
  permit issued in the last ~60 days, GC identified, within the service radius —
  the interior package is being priced *right now*.
- The customer-gated **bid inbox (S3)** is Solis's highest-intent signal; ship the
  digest around it so the day authorization lands, invitations slot in.

## P1 — GC relationship intelligence v2 (the league table)

Goal: answer "**which GCs keep running interior-relevant work in my area, and which of
them don't know me yet?**" from stored roles/valuations/counties. Live graph today:
3,128 applicant orgs / 6,140 projects, 118 primary contractors.

- **P1.1 Org activity rollup** (`packages/intelligence` or `resolution`): per
  organization — active projects, counties, stage mix, stated-valuation sum/median,
  **interior-relevance share** (TI/commercial/multifamily classification reused from the
  scorer), first/last seen, trend (90d vs prior 90d). Deterministic SQL; excludes
  placeholder names (`NO PRIMARY APPLICANT AVAILABLE` and person-name heuristic
  filtered *by flag, not deletion*), weighted so GCs rank above high-volume trade subs
  (role + valuation + multi-project weighting).
- **P1.2 Target list**: rollup ∩ account profile — orgs above an activity threshold in
  the account's counties/package band with S4 relationship state `unknown`/`research
  needed`. This is the weekly "relationship play" generator.
- **P1.3 UI/API**: `/app/organizations` upgraded from a list to the league table
  (sort/filter, relationship state inline, drill-down keeps existing org view);
  digest gains a **"GC worth meeting"** section (cap 2, only when target list is
  non-empty). Account-scoped as always.
- **P1.4 OTN registry join point (deferred integration)**: add nullable
  `organizations.registry_ref` (+ optional `ubi`) via migration, populated ONLY by a
  future import from the customer's One Trade Network registry — never scraped. All P1
  features function without it; when present it upgrades name-matching to identity.
- Exit: league table reproduces from stored rows; target list for Solis is non-empty and
  face-valid on manual review of top 10; digest section renders; tests + E2E.

## P2 — Digest restructure: the 10-minute Monday (Solis edition)

Goal: the email is the product. Hard caps, one action per item, no login required.

- **P2.1 Easy-win cut** (deterministic, on top of the score): stage ∈
  {permit_issued ≤60d, TI approved}, valuation in the account capacity band (S0),
  GC/applicant present, geo within service radius (geometry now 88%+). Flag stored in
  `rationale_json`; never replaces the score — it *sections* the digest.
- **P2.2 Sections & caps**: (1) *Winnable interior packages* — cap 3; (2) *GC worth
  meeting* — cap 2 (from P1.2); (3) *Deadlines* — bid-invitation dues (S3; empty until
  Solis authorizes, disclosed as such) ; (4) *Radar* — cap 2 early-stage (pre-app/SEPA);
  coverage/suppression footer stays. Everything else is in the app, not the email.
- **P2.3 One-tap actions**: signed, expiring action links (pursue / dismiss+reason /
  "not relevant") that hit dedicated endpoints without a session — token scoped to
  (account, opportunity, action), single-use, audited. Pursue creates the S2 pursuit
  with default tasks. NO destructive actions via email.
- **P2.4 Outreach prep (deterministic)**: memo gains an evidence-only talking-track
  bullet list (GC name, what they filed, when, package hint) — copy/paste for the
  owner's own call/text. Model-written prose stays key-gated; we ship the bullet form.
- Exit: Solis digest renders ≤7 items with caps enforced; one-tap round-trip proven in
  E2E (token→pursuit created→second use rejected); Mailpit visual check.

## P3 — Timing intelligence: time-to-bid + pre-app radar

- **P3.1 Stage-lag statistics** (deterministic): median/p25/p75 applied→issued and
  issued→(construction|final) per permit type × county from our own event history;
  stored as a versioned stats table refreshed nightly; surfaced on memos/digest items
  as "*typically issues in ~N weeks*" — always labeled an inference from historical
  lags, never a promise. For Solis the headline stat is **issued→interior-window**.
- **P3.2 Pre-application radar**: dedicated surface (app page + digest radar section)
  for pre-app/SEPA/entitlement records (Pierce pre-app screenings ×226/quarter, Tacoma
  Pre-Application, wa_sepa) filtered to account relevance — the 6-month-ahead pipeline.
- Exit: stats table reproducible; radar shows Solis-relevant early items; lead-time
  metric on /app/roi starts reflecting radar→permit conversions over time.

## P4 — Mobile-responsive pass

- Digest-first design already carries mobile; this phase makes the three follow-through
  screens phone-usable: opportunity detail (memo-first, collapsible evidence), pursuits
  Kanban (vertical stack on small viewports), map (already Leaflet; touch works — fix
  layout chrome). Plain CSS/responsive layout — no framework adoption.
- Exit: Playwright mobile-viewport smoke (390×844) on those three screens.

## P5 — Next source: public procurement/bid postings

The only *public* path to `bidding_confirmed` and the highest-intent Solis signal after
the inbox: school district / city / county bid pages (official, public). Standard M1
checklist; candidates verified live before any build (WEBS likely authenticated →
excluded unless policy-compatible). Scheduled after P1–P3 unless a customer-named
agency makes it urgent.

## P6 — Complete the WA L&I contractor load (blocks matching quality broadly)

The registry holds **26,934 of 75,364 WA contractors (35.7%)**. The 48,290 missing are
the CC:01 generals dropped by `--launch-pools-only` (infra gate OTN-14). By trade the
gap is lopsided: **3,074 `general_contractor` entities against ~51,000 — about 6%**.

This is not merely "fewer matches". It disables safeguards that depend on the registry
being able to vouch for a business, and it does so hardest on general contractors — the
population P1 and the primary-contractor binding work both target.

Measured cost, 2026-07-24 (`person-shape-report`):

- 3,777 unbound orgs; 2,376 are person-shaped by name.
- 33 of those person-shaped orgs nonetheless match a registry entity — i.e. they are
  businesses the name heuristic gets wrong: `JOHNSON CONTROLS`, `CINTAS FIRE
  PROTECTION`, `JH KELLY`, `RESCUE ROOTER`, `WASHINGTON GENERATORS`.
- Only **256 unbound orgs match any registry entity at all**, so a name-shape filter
  would destroy **12.9%** of every available match.
- Extrapolating to full coverage implies **~92** such businesses exist; 59 are simply
  invisible today because their L&I record was never loaded.

**Consequence, already applied**: the person-shaped refusal in the identity plan is
descoped to report-only. It cannot be made safe until this load completes, because the
evidence that would overrule the heuristic — a registry entity to match against — does
not exist for 64% of contractors.

Owner-gated: needs the reload run and the OTN-14 infra decision. Everything else in the
matching roadmap gets better for free when it lands.

## Standing gates & calibration (unchanged, tracked in STATUS)

- **Solis §22 calibration session** (customer): capacity snapshot (S0), priority
  threshold (482 priority today), service radius for the easy-win cut, disposition
  review after two digest cycles.
- **Solis bid-inbox authorization** (customer) → S3 goes live → P2.2 deadlines section
  fills.
- **Model keys** → extraction/verifier → prose memos + live delivery cycles.
- **At Home Pierce/Tacoma volume** stays a recorded §22 item for the **Lacey Glass At
  Home** account — a *separate, unaffiliated company* from Solis, so it is NOT part of
  the Solis calibration session; nothing in P1–P4 depends on it.

## Sequencing

P1 → P2 → P3 → P4 → P5, each with tests/docs in-pass per house rules. **P6 is
off-sequence**: it is owner/infra-gated rather than build-gated, and it raises the
ceiling on P1 and on all binding work, so it should land whenever the reload is
authorised rather than waiting its turn. P1 and P3.1 are
pure derived-data work (no new sources, no migrations beyond `registry_ref`); P2.3 is
the only new security surface (signed tokens) and gets a security review before merge.
