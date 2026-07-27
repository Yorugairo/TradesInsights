# Implementation Report: Cockpit UI — Phase 1 (primitives)

Executed 2026-07-27. **Phase 1 complete.** Phases 2–3 remain, so the plan is NOT
archived.

## Summary

Eleven components and one test file. The three OTN proof primitives ported to
Tailwind, two Insights-specific ones added, five layout primitives built. Nothing
is wired into a page yet — that is Phase 3 — so the e2e contract is untouched by
construction.

| Metric | Predicted | Actual |
|---|---|---|
| Complexity | 3 tasks | 3 tasks, no scope change |
| Files | 10 created | 11 created, 2 updated |
| Unit tests | "a unit test" for 1.2 | **27 tests**, covering all five proof primitives |

## Tasks

| # | Task | Status | Notes |
|---|---|---|---|
| 1.1 | Port `StatTile` / `SourceChip` / `RangeBar` | Complete | One prop widened — see deviations |
| 1.2 | `ConfidenceMeter` + `GateBadge` | Complete | Both have explicit unknown states, both tested |
| 1.3 | `Card` / `Panel` / `PageHeader` / `EmptyState` / `Table` | Complete | All server components |

## Validation

| Level | Status | Notes |
|---|---|---|
| Typecheck | Pass | 11 packages, zero errors |
| Lint | Pass | zero errors |
| Unit — new | **27/27** | `apps/web/components/proof/primitives.test.tsx` |
| Unit — whole repo | **1214/1214** across 118 files | the vitest config change broke nothing |
| Build | Pass | `@otn/web` compiled |
| Utility generation | Verified positively | see below |
| e2e | **21/21**, spec files unedited | but see the fragility finding |

### The validation that mattered, again

Phase 0 established that Tailwind fails silently when misconfigured. Phase 1 adds
a second silent-failure surface: **utilities for classes that appear only in files
Tailwind does not scan.** These components are not imported by any page yet, so if
v4's automatic source detection missed `apps/web/components/`, every class here
would be a no-op and nobody would find out until Phase 3.

Checked positively — `.next/static/css` deleted first so a stale file could not
answer for a fresh one (the exact false alarm from Phase 0):

```css
.text-stat{font-size:var(--text-stat);line-height:var(--tw-leading,var(--text-stat--line-height))}
.text-2xs{font-size:var(--text-2xs);line-height:var(--tw-leading,var(--text-2xs--line-height))}
.bg-chip{background-color:var(--chip-bg)}
.border-chip-line{border-color:var(--chip-border)}
.bg-track{background-color:var(--surface-track)}
.text-accent-ink{color:var(--accent-ink)}
```

Also confirmed emitted: `background-image:var(--panel-gold-bg)`,
`background-image:var(--range-band)`, and
`--tw-shadow:0 0 10px var(--tw-shadow-color,var(--accent-glow))`. Every one resolves
through a `var()`, so all of it re-themes when `[data-theme]` flips.

## Deviations from plan

**1. `StatTile.value` widened from `string` to `string | number | null`.** The plan
said "same props"; the plan's own testing strategy said `StatTile` with a null value
must render `—`, never `0`. Those two cannot both hold with `value: string`. OTN's
callers always had a formatted string in hand; Insights routinely holds "not
measured", and requiring every call site to remember `?? "—"` is precisely how a
real unknown eventually renders as a zero. The widening is backwards-compatible.
Both directions are tested: `null → —`, and a *measured* `0` still renders `0`.

**2. No scratch route.** Task 1.1's VALIDATE suggested rendering the three
primitives in a scratch route at both registers. A permanent gallery page under
`/app` would either need a nav entry (Phase 2's job) or sit orphaned — and
"reachable only if you already know it exists" is the exact bug this plan opens by
calling out. Register correctness follows from Phase 0's verification that every
utility emits `var()`; component correctness is covered by the 27 render tests.
Skipped deliberately, not forgotten.

**3. Two new type-scale tokens.** `--text-2xs` (0.7rem) and `--text-stat`
(the fluid `clamp()`) went into `@theme` rather than being rounded to the nearest
Tailwind step or inlined as arbitrary values. OTN's primitives use sizes Tailwind's
scale does not carry, and `text-[clamp(1.35rem,1.1rem_+_1vw,1.85rem)]` at every call
site is not a design system.

**4. Three decoration tokens added per register** — `--accent-glow` (verbatim from
OTN), `--panel-gold-bg`, `--range-band`. Gradients tuned for `#061109` go muddy on
`#ffffff`, so each register declares its own. All three are non-text, so no AA
obligation applies; that is stated in the comment so nobody later "fixes" a missing
contrast note.

**5. `vitest.config.ts` touched.** `apps/web` was outside the test `include` globs,
so a test file there would silently never run — with `passWithNoTests: false`
providing no warning, because other files matched. Added `apps/web/**/*.test.{ts,tsx}`
plus `esbuild: { jsx: "automatic" }`, since `apps/web/tsconfig.json` sets
`"jsx": "preserve"` (Next owns that transform) and vitest has no Next pipeline behind
it. Full suite re-run: 1214 tests, no change.

## Design decisions worth carrying forward

**Every primitive forwards `data-testid`.** Not a convenience. The e2e suite selects
exclusively by testid, which is the whole reason a visual rewrite is safe here. A
primitive that swallowed the attribute would force Phase 3 retrofits to wrap it in a
bare `<div>` just to keep the hook — and the first person in a hurry would edit the
spec instead. The API removes the temptation.

**`Table` owns its `<tbody>`.** `app.spec.ts:250` does `.locator("tbody tr")`. Rather
than document "remember the tbody" as a convention, `Table` takes `head` and
`children` and emits `<table><thead>…</thead><tbody>{children}</tbody>` itself.
Forgetting the tbody is not an available mistake. Rows can still be painted as cards
via `display: grid` on the `<tr>`; only the painting changes.

**Unknown has a shape, not an absence.** `ConfidenceMeter` renders unknown as three
*dashed* segments plus the words "Not assessed" and "unknown, not zero";
`GateBadge` renders an un-run gate as a dashed, colourless pill reading "Not
evaluated". Both are tested to *not* contain the filled/coloured classes. This is the
fleet lesson in UI form: an orphaned run's missing counter read as a measured zero
and the whole fleet looked healthy.

**`EmptyState.reason` is required.** "No rows matched your filter" and "we have never
collected data for this" are different facts that an empty table renders identically.
You cannot construct a silent empty state with this component.

**`gateBadgeState("blocked_on_verifier")` is tested to differ from `"fail"`.** The
gate did not say no; it could not ask. Collapsing those two is a fabricated judgement.

## Issues encountered

**The e2e suite is load-fragile, and Phase 3 leans on it.** The first full run after
`next build` (with `.next/static/css` deleted) failed **9 of 21**. An identical
re-run, no code change, passed **21/21** in 1.5m versus the failing run's 4.7m; the
login test passed alone in 12.3s in between.

The failures were scattered rather than clustered at the start, so "cold compile" is
not a complete explanation. The relevant structural fact: `playwright.config.ts`
runs `pnpm dev` and the repo `.env` points `DATABASE_URL` at the **hosted production
database**, whose pool max is 2. So the suite is a dev-mode compile racing a
2-connection remote pool under a 60s per-test budget.

This matters beyond Phase 1. Phase 3's gate is "e2e green after each page", and a
suite that can report 9 failures for environmental reasons cannot carry that weight —
a real regression would be indistinguishable from a bad afternoon. **Recommendation
before Phase 3 starts:** point the e2e run at a seeded local database, or warm the
dev server and assert against a pre-built server rather than `next dev`. Logged as a
risk in the plan; not fixed here, because fixing it is not a Phase 1 task and doing it
silently would hide the finding.

**No regression was possible from this change set** — nothing in it is imported by any
page. That is what makes the 21/21 re-run believable rather than a re-roll.

## Files changed

| File | Action | Lines |
|---|---|---|
| `apps/web/components/proof/StatTile.tsx` | CREATED | 46 |
| `apps/web/components/proof/SourceChip.tsx` | CREATED | 40 |
| `apps/web/components/proof/RangeBar.tsx` | CREATED | 97 |
| `apps/web/components/proof/ConfidenceMeter.tsx` | CREATED | 153 |
| `apps/web/components/proof/GateBadge.tsx` | CREATED | 82 |
| `apps/web/components/proof/primitives.test.tsx` | CREATED | 263 |
| `apps/web/components/ui/Card.tsx` | CREATED | 90 |
| `apps/web/components/ui/Panel.tsx` | CREATED | 56 |
| `apps/web/components/ui/PageHeader.tsx` | CREATED | 40 |
| `apps/web/components/ui/EmptyState.tsx` | CREATED | 35 |
| `apps/web/components/ui/Table.tsx` | CREATED | 109 |
| `apps/web/app/globals.css` | UPDATED | +36 |
| `vitest.config.ts` | UPDATED | +11 |

## Tests written

| File | Tests | Covers |
|---|---|---|
| `apps/web/components/proof/primitives.test.tsx` | 27 | `rangeMarkerPercent` degenerate/clamped, `RangeBar` aria + no-`NaN`, `confidenceState` unknown-vs-measured-zero, `ConfidenceMeter` unknown state, segment fill, contradictions, `gateBadgeState` all four outcomes, `GateBadge` dashed-unknown, `StatTile` null-vs-zero, `SourceChip` link/span, `Table` tbody guarantee, `EmptyState` reason |

## Next

- [ ] **Fix the e2e harness before Phase 3** — seeded local DB or pre-built server.
      Phase 3's per-page gate is only as good as this suite.
- [ ] Phase 2 — `AppNav` grouped rail, command palette, density toggle;
      **removes `body { margin }`** in the same change that replaces it.
- [ ] Phase 3 — page retrofit, one page per commit, e2e green after each.
