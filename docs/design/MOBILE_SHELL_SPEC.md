# Mobile shell + design spec — Trades Insights (drywall skin)

**Audience:** an engineer or coding agent picking up the mobile shell with no
prior context on this repo.
**Companion PRD:** `.claude/prds/trades-insights-mobile.prd.md` (problem, users,
metrics). This document is the *how*: what exists, what to build, what not to.
**Status:** design spec, approved decisions. Not yet an implementation plan.

---

## 1. Read this first: ~60% of the domain already exists

The mobile app is mostly a **client over server logic that already ships**, plus
**two new entities**. Do not re-implement any of the following — they live in
`packages/` and are framework-agnostic.

| Capability | Module | What it already does |
|---|---|---|
| Takeoff estimator | `packages/intelligence/src/takeoff.ts` | 10 drywall assemblies, derive lines from permit evidence, manual lines, `sheetTotals`, `stampEstimate`; tables `takeoff_sheets` / `takeoff_lines` |
| Field comms | `packages/intelligence/src/field.ts` | `mintFieldLink` / `verifyFieldToken` / `revokeFieldLink`, `addFieldEntry`, `decideChangeOrder`, `getFieldBrief`, `fieldRollup`; tables `field_links` / `field_entries` |
| Field notifications | `packages/delivery/src/field-notify.ts` | Notifies on field events |
| Relationships | `packages/intelligence/src/relationships.ts` | 8 states, `setRelationship`, `addContact`, `addInteraction`, `isAlertSuppressed` |
| Outreach / warm intros | `outreach.ts`, `warm-network.ts`, `brief.ts`, `memo.ts` | GC briefs and approach material |
| Pursuit pipeline | `packages/intelligence/src/pursuit.ts` | 12 states, `discovered` → `won`/`lost`/`no_bid`/`archived` |
| Digest | `packages/delivery/src/digest.ts`, `render.ts` | Weekly digest build + HTML render |
| Capacity | `packages/intelligence/src/capacity.ts` | Crew capacity snapshots + `assessCapacity` |
| Bid timing | `packages/intelligence/src/bid-window.ts` | Bid-clock signal, trade-scoped |

**Green-field (nothing exists):** the mobile shell itself, offline storage/sync,
the **job** entity, the **schedule**, the **field estimator** input path, and the
**editable cost book**.

### The drywall skin is not a theme

`TAKEOFF_ASSEMBLIES` is already the drywall product:

```
hang_finish (sqft) · level5_skim (sqft) · metal_stud_framing (lf) · act_grid (sqft)
insulation (sqft) · fire_rated_assembly (sqft) · paint_walls (sqft)
paint_ceilings (sqft) · doors_frames (each) · scope_allowance (allowance)
```

A "skin" in this product means **assemblies + vocabulary + which surfaces are
primary**. It does not mean colours. Any future trade is a new assembly set and a
new calibration, not a config flag.

---

## 2. Approved decisions (do not relitigate)

1. **Offline is a requirement, not a feature.** Crews work in cores, basements
   and pre-glazing shells. An app needing connectivity fails at the only moment
   it matters. Decide and *prove* the sync architecture before building UI.
2. **A distinct `job` entity**, created from a won pursuit **or entered
   manually.** Manual creation is first-class — most drywall work will not arrive
   through the permit pipeline, so a job must never require a pursuit.
3. **One estimate model, two input modes.** Desk (permit-evidence-derived) and
   field (measured on site) share assemblies and cost book, distinguished by a
   `source` discriminator. Two models would eventually quote two prices for one
   job.
4. **Unit costs are uncalibrated placeholders and must be editable in-app.** The
   shipped `defaultUnitCost` values ($2.50/sqft hang & finish, $14/lf metal stud,
   …) were never checked against actuals. The app needs a **cost book** the owner
   can edit, with revisions, and field output framed as rough order of magnitude
   until calibrated.
5. **Two user classes, two shells.** The owner-estimator and the field lead want
   opposite things. Do not build one undifferentiated app.

---

## 3. Two shells, one codebase

| | Owner shell | Field shell |
|---|---|---|
| User | Owner-estimator | Field lead / crew |
| Auth | Account session (`apps/web/lib/auth.ts`) | **Token link, no account** (`field_links`) |
| Entry | Installed app, digest home | A link someone texted them |
| Primary surfaces | Digest, jobs, schedule, estimates, relationships, pursuits | Today's job, daily log, quantities, photos, change orders |
| Money visible | Yes | **Quantity-only by default** — see open question |
| Offline | Read-heavy, cached | **Write-heavy, must work fully offline** |

**Three auth models already exist. Do not invent a fourth.**

- Account session — `encodeSession` / `currentSession` / `requireSession` /
  `requireAdmin` in `apps/web/lib/auth.ts`.
- Cross-app SSO — `apps/web/lib/sso.ts` + `/api/auth/sso`; HMAC-signed, **60s
  TTL, single use**, spent via the `sso_consumed` table. Minted registry-side at
  `/api/insights/handoff`. Never email an SSO link: mail gateways prefetch and
  spend it.
- Field token — `field_links`, **multi-use, 30-day TTL**, revocable. This is
  deliberately *not* `action_tokens` (single-use); never merge the two concepts.

---

## 4. Offline architecture requirements

This is milestone 0 and gates everything else.

**Must be true**
- Every field write (daily log, quantity, photo, change order, note) succeeds
  with no network and is durable across app restart and OS eviction.
- On reconnect, queued writes reach the server exactly once. **No silent loss and
  no silent duplication** — the reconciliation must be auditable, not assumed.
- The user can always tell whether what they see is local-only or synced.
- Photos queue too. They are the largest payload and the most likely to fail.

**Must be decided and written down**
- Storage substrate and its eviction behaviour under iOS storage pressure.
- Conflict policy. Field entries are append-mostly, which makes last-write-wins
  *probably* acceptable — but `decideChangeOrder` is a **decision**, and two
  people deciding the same change order offline is a real conflict. Specify it.
- Whether "offline" means an outbox queue or a local replica. Depends on the
  blocking question in the PRD about no-signal duration.
- Retention: how long local data survives after sync.

**Verification bar for milestone 0:** capture → airplane mode → force-quit →
reopen → reconnect → verify server state, performed on a real phone in a real
building. A simulator does not count; neither does throttled DevTools.

> Guidance from this codebase's history: a check that cannot distinguish "empty"
> from "broken" will confidently report the wrong state. Any sync-status
> indicator must distinguish *nothing to sync* from *sync failing silently*.

---

## 5. Design system to inherit

The cockpit is dark, login-gated, and already has a palette. **Reuse it.**

```
--canvas #061109   --surface #0a1f12   --surface-raised #0e2717
--ink #f8f9fa      --ink-muted #a8b8b0 --ink-subtle #7f918a
--accent #d4af37 (gold)                --evergreen #009b3a
--ok #2fbf6b       --warn #e5b769      --bad #f2777a
--line rgba(212,175,55,0.1)            --line-strong rgba(212,175,55,0.22)
```

Existing shell components: `apps/web/components/shell/` — `AppNav.tsx`,
`CommandPalette.tsx`, `DensityToggle.tsx`, `nav-items.ts`. Proof primitives live
in `apps/web/components/proof/` (e.g. `SourceChip`).

**Styling gotcha, stated because it fails silently:** this app uses **Tailwind
v4**, wired through **`@tailwindcss/postcss`**. In v4 the `tailwindcss` package no
longer exports a PostCSS plugin — naming it in the PostCSS config produces no
error and no styles.

**Field-shell design constraints** (these are functional, not aesthetic):
- Gloves, dust, bright sun. Large targets, high contrast, no hover-dependent UI.
- One-handed reachability — primary actions in the bottom third.
- The dark palette is good for battery and low light but **must be validated in
  direct sunlight**; if it fails, the field shell gets a light variant while the
  owner shell keeps the cockpit look.
- Never block on a spinner. Every write is local-first and instant.

---

## 6. New data model (the two entities)

Specify precisely; these are the only schema additions in the MVP path.

**`jobs`** — execution, distinct from `pursuits` (which is acquisition and ends
at `won`).
- Created from a won pursuit **or manually**, with no pursuit required.
- Anchors: schedule entries, takeoff sheets, field links, field entries.
- Needs its own lifecycle (e.g. `planned` → `active` → `complete`), deliberately
  *not* reusing `PURSUIT_STATES`.
- Open question in the PRD: whether one job may span multiple sites/phases.

**Schedule** — crew and dates against jobs.
- Relationship to `capacity_snapshots` must be decided: capacity is an
  *assessment*, schedule is a *commitment*. They should reconcile, not duplicate.

**Cost book** — editable unit costs with revisions.
- Seeded from `TAKEOFF_ASSEMBLIES.defaultUnitCost`.
- Estimates must record **which revision** produced them, or historical estimates
  silently change when costs are edited.

---

## 7. MVP screen inventory (milestones 1–2)

**Owner shell**
1. Digest home — the week, as the landing surface. Not a second inbox.
2. Job list → job detail (read-only in MVP).
3. Install / auth / account.

**Field shell**
4. Today — the job, the scope, yesterday's numbers.
5. Daily log capture — quantities by assembly, notes, photos.
6. Change order raise — with explicit "this changes the price" framing.
7. Sync status — honest about local-only vs. synced vs. failing.

Everything else (schedule, field estimator, relationships, pursuits) is milestone
3+ and out of MVP.

---

## 8. Acceptance criteria (MVP)

- [ ] Given no network, when a field lead records a daily log with photos, then it
      persists locally and is visible immediately.
- [ ] Given queued offline entries, when the device reconnects, then every entry
      appears server-side exactly once and the client reports success.
- [ ] Given a force-quit between capture and sync, when the app reopens, then no
      entry is lost.
- [ ] Given a field token, when it is opened, then the crew reaches their job
      **without an account**, and the token remains usable for its 30-day life.
- [ ] Given a revoked token, when it is opened, then access is refused.
- [ ] Given the owner opens the app, when the digest has no new activity, then it
      says so plainly rather than rendering an empty frame.
- [ ] Given the owner edits a unit cost, when an existing estimate is reopened,
      then that estimate still shows the cost revision it was made with.
- [ ] No lead, customer, or corporate-family data appears on any unauthenticated
      surface (see `docs/data/TRADES_PUBLIC_DATA_POLICY.md` in the registry repo).

---

## 9. Explicitly not building

- Native app-store builds (revisit only if background sync or camera limits block
  the MVP).
- Any trade other than drywall/interiors.
- GC-facing or homeowner-facing surfaces.
- Invoicing, payroll, accounting integration.
- **Any surfacing of the corporate-family graph** ("this person also runs N
  companies"). It is proprietary — part of what the subscription and outreach
  sell — and separately governed.

---

## 10. Known context that will bite you

- **The ingestion pipeline is idle.** The scheduled source fleet dies on a missing
  `DATABASE_URL` GitHub Actions secret, so opportunity- and digest-driven
  surfaces have little to show. Field capture and the estimator are unaffected —
  they run on customer-entered data. Plan demos accordingly.
- **There are 0 claimed trades tenants and 0 trades leads** as of 2026-07-31.
- **Insights and the registry are separate repos sharing one database**
  (`arbmeioglflvzoffgtii`), joined by contract views: `registry_public.trades_*`
  (registry → Insights) and `insights_public.cockpit_*` (Insights → registry).
  Additive columns only; breaking changes ship as `_v2`.
- **Two test databases exist per harness** and are destructive. Read the e2e setup
  before pointing anything at them.
