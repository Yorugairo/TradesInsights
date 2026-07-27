# Implementation Report: Cockpit UI — Phase 2 (shell)

Executed 2026-07-27. **Phase 2 complete.** Phase 3 remains, so the plan is NOT
archived.

## Summary

The flat fourteen-link nav is gone. In its place: a grouped rail with active
state, a Cmd-K palette, a density toggle that persists, and the removal of
`body { margin }` in the same change that replaced it. Two adjacent problems got
fixed because they were blocking or embarrassing: the e2e harness was rebuilt
into something a per-page gate can actually rest on, and the shared `Badge`
stopped rendering as a near-white pill on a dark page.

| Metric | Predicted | Actual |
|---|---|---|
| Complexity | 2 tasks | 2 tasks + harness + shared-UI colour fix |
| Files | 5 | 4 created, 7 updated |
| e2e | 21 green | **28 green** (7 new shell tests, no spec edited) |

## Tasks

| # | Task | Status | Notes |
|---|---|---|---|
| 2.1 | `AppNav` grouped rail | Complete | Both nav bugs already closed in Phase 0; verified by test |
| 2.2 | Command palette + density toggle | Complete | Native `<dialog>`; no-flash script |
| + | e2e harness hardening | Complete | Was logged as a Phase 3 blocker — done now, see below |
| + | `lib/ui.tsx` colour tokens | Complete | Fixed a live contrast failure |

## Validation

| Level | Status | Notes |
|---|---|---|
| Typecheck | Pass | 11 packages |
| Lint | Pass | zero errors |
| Unit | 27/27 | unchanged from Phase 1 |
| Build | Pass | |
| **e2e** | **28/28** | 21 original + 7 new; **no spec file edited** |
| Visual QA | Done | 8 captures across the three TASTE viewports, both registers |

## The harness fix, and why it came first

Phase 1 logged this as "fix before Phase 3". It got fixed before Phase 2's own
validation instead, because Phase 2 is the change that touches the layout every
page renders inside — validating *that* against an unreliable gate is exactly
the situation the finding described.

**Change 1 — build, don't dev.** `playwright.config.ts` ran `pnpm dev`, so the
suite was a just-in-time compile racing a 60s per-test budget. Switched to
`pnpm build && pnpm start`. Effect on the original 21 tests:

| Run | Result | Wall clock |
|---|---|---|
| `next dev`, cold | **9 failed / 21** | 4.7m |
| `next dev`, warm | 21 passed | 1.5m |
| `next build` + `next start` | 21 passed | **42s** |

Per-test times fell from seconds to milliseconds. It also tests what ships:
`next build` is the only mode that enforces the server/client boundary, so a
`"use client"` leak fails the gate instead of hiding until deploy.

**Change 2 — one worker.** Two workers still produced scattered failures,
including a login POST that did not return inside a 5s assertion. The database
pool max is 2; two browser workers plus the app's own queries contend for those
two connections. Serial execution costs ~40s and removes contention we control.
Commented as a compensating control to be removed once e2e runs against a
seeded local database — **which is still outstanding**, and is the remaining
half of the original finding.

## Deviations from plan

**1. `data-density` is NOT rendered on `<html>` server-side.** The plan implied
the server sets a default and the script overrides it. That does not work, and
the e2e caught it: React reconciles attributes it owns during hydration, so the
server's `comfortable` was restored over the script's `compact`. The preference
survived first paint and then died a second later. Fix: omit the attribute
entirely and let the token layer treat absent as comfortable (only
`[data-density="compact"]` overrides anything). React has no opinion, the
script's value stands.

This one is worth remembering: the no-flash inline-script pattern is
incomplete on its own. The server must render *nothing* for the attribute the
script writes.

**2. Four admin lanes are palette-only, not in the rail.** The plan's Admin
group lists Cockpit / Sources / Review / Coverage. There are four more admin
pages — registry-review, corporate-families, google-place-review,
google-place-contested. Listing them flat would present eight equal tabs and
throw away the Queue cockpit's owner-ordered lane priority, which the cockpit
page's own comment block argues for at length. They are one keystroke from
anywhere via the palette. "Reachable only from inside" was the bug; "curated
rail, exhaustive palette" is not the same thing.

**3. `Account` sits in the rail footer, not in a group.** The plan's five groups
have no home for it, and dropping the link would be a regression. It is about
you, not about the work, so it lives next to the session line.

**4. `lib/ui.tsx` colour values updated now, not in Phase 3.** The plan lists
this file as UPDATE without a phase. It is shared UI, not a page, and the first
screenshot of the new shell showed why it could not wait: `Badge` used pastel
fills authored for a white page (`#e6f4ea`, `#fff4d6`, `#fde7e9`) and rendered
as near-white pills with unreadable text against the dark register. `cell` drew
a `#ddd` grid. Both are one-line value swaps to tokens — the API, the call
sites, and all 24 pages are untouched. A side benefit: `cell` now uses
`var(--row-pad-*)`, so the density toggle reaches every legacy table for free.

**5. `/` and `/login` gained a `.page-gutter` class.** They sit outside the app
shell and would have lost their margin with nothing to replace it. Tokens only,
as the plan permits for the login page.

## Design decisions worth carrying forward

- **The palette is built on native `<dialog>`.** `showModal()` gives an inert
  background, Escape-to-close, and a real focus trap from the platform. All
  three are easy to write badly and a keyboard-only operator notices
  immediately when they are wrong.
- **`nav-items.ts` is data, consumed by both surfaces.** A new page cannot be
  added to the rail and forgotten by the palette. The palette also re-applies
  the same two authorization conditions as the rail — a palette that offered an
  admin route to a customer would be an authorization bug with a nice UI.
- **`minmax(0,1fr)` on the content column.** A bare `1fr` has an automatic
  minimum of min-content, so one wide table would push the grid past the
  viewport. `app.spec.ts:303` asserts zero horizontal overflow at 390x844.
- **Active state is a gold left edge plus `aria-current="page"`.** Colour alone
  fails for anyone who cannot distinguish it, and `aria-current` is what the
  new test asserts — a machine-checkable claim rather than a visual one.
- **`data-state` on the density toggle is the hydration signal.** It renders
  `unknown` on the server and cannot render anything else there. Keyboard tests
  wait on it instead of guessing how long hydration takes under load. Waiting on
  visibility would pass against server markup with no handlers bound.

## New e2e coverage

`e2e/shell.spec.ts` — a **new file**, not an edit. The standing rule is that a
failing test means the markup is wrong; adding coverage the old suite never had
is the one safe direction.

| Test | Guards |
|---|---|
| every primary nav link resolves | the original bug: a link to a route that did not exist |
| active link marked `aria-current`, incl. nested | detail pages keep their section lit |
| customer session offered no admin route | the rail's authorization condition |
| Cmd-K opens the palette, Enter navigates | keyboard completeness |
| Cmd-K not stolen from a filter input | the plan's explicit gotcha |
| Escape closes the palette | platform dismissal wired to state |
| density persists across a reload | caught the hydration bug above |

**Baseline for Phase 3 is now 28**, not 21.

## Files changed

| File | Action |
|---|---|
| `apps/web/components/shell/nav-items.ts` | CREATED — route data for rail + palette |
| `apps/web/components/shell/AppNav.tsx` | CREATED — grouped rail + content column |
| `apps/web/components/shell/CommandPalette.tsx` | CREATED — native `<dialog>` |
| `apps/web/components/shell/DensityToggle.tsx` | CREATED |
| `apps/web/e2e/shell.spec.ts` | CREATED — 7 tests |
| `apps/web/app/app/layout.tsx` | UPDATED — auth stays server-side, shell is a prop boundary |
| `apps/web/app/layout.tsx` | UPDATED — no-flash script; `data-density` removed |
| `apps/web/app/globals.css` | UPDATED — `body { margin: 0 }`, `.page-gutter` |
| `apps/web/lib/ui.tsx` | UPDATED — `Badge` and `cell` onto tokens |
| `apps/web/app/page.tsx` / `login/page.tsx` | UPDATED — gutter + tokens |
| `apps/web/playwright.config.ts` | UPDATED — built server, one worker |

## Next

- [ ] Phase 3 — page retrofit, one page per commit, e2e green (28) after each.
      Start with `opportunities` (flagship), then `opportunities/[id]`.
- [ ] **Still outstanding from the Phase 1 finding:** e2e runs against the
      hosted production database. `workers: 1` is a compensating control, not a
      fix. A seeded local corpus removes it.
- [ ] The cockpit and several admin pages set their own `<main>` padding on top
      of the shell's. Cosmetic double-gutter; Phase 3 removes it per page.
