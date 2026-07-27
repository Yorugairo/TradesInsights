# Implementation Report: Cockpit UI — Phase 0 (foundation)

Executed 2026-07-27. **Phase 0 complete.** Phases 1–3 remain, so the plan is NOT
archived.

## Summary

Tailwind v4 installed and verified genuinely emitting; the OTN token palette ported
verbatim into a two-register theme layer; an Insights-specific taste doc written. Plus
one item pulled forward at the owner's request mid-implementation: the coverage
feature — API route and page — built, and the Queue cockpit made reachable.

| Metric | Predicted | Actual |
|---|---|---|
| Complexity | Phase 0 = 3 small tasks | 3 tasks + 1 owner addition |
| Files | ~4 | 6 created, 4 updated |
| e2e | "20/20 green" | **Plan was wrong** — baseline was 20/1. Now **21/21** |

## Tasks

| # | Task | Status | Notes |
|---|---|---|---|
| 0.1 | Install Tailwind v4 | Complete | `tailwindcss@4.3.3` + `@tailwindcss/postcss@4.3.3` |
| 0.2 | Token layer ported from OTN | Complete | Two registers, contrast documented |
| 0.3 | Insights taste doc | Complete | `docs/TASTE-insights.md` |
| + | Coverage API + page, cockpit in nav | Complete | Owner request mid-turn; closed the standing red |

## Validation

| Level | Status | Notes |
|---|---|---|
| Typecheck | Pass | 11 packages, zero errors |
| Lint | Pass | 0 errors |
| Build | Pass | `@otn/web` compiled |
| e2e | **21/21 pass** | Spec files unedited |
| Utility generation | Verified | See below |

## The validation that mattered

The plan's stated gotcha is that the wrong PostCSS plugin fails **silently**. A build
that succeeds proves nothing, so the check was made positive: temporarily add
`className="bg-canvas text-ink border-line rounded-md"`, rebuild, and grep the emitted
CSS.

```css
.bg-canvas{background-color:var(--canvas)}
.text-ink{color:var(--ink)}
.border-line{border-color:var(--line)}
.rounded-md{border-radius:var(--radius-md)}
```

Two things confirmed at once: Tailwind is generating utilities **from the ported
tokens**, and each emits `var(--canvas)` rather than a baked hex — which is what makes
`[data-theme]` switch registers at runtime with no rebuild. The probe classes were then
reverted.

Also verified in the output: both registers (`[data-theme=light]` with the full
`--lt-*` set), `[data-density=compact]`, Tailwind's `@property --tw-*` declarations,
and preflight.

**A self-inflicted false alarm worth recording:** the first utility grep found nothing
and read as exactly the silent failure being tested for. The cause was
`find … | head -1` picking a stale CSS file from an earlier build. The diagnosis was
wrong, not the build. When a check disproves something that should work, verify the
check before the code.

## Deviations from plan

**1. `body { margin }` preserved rather than zeroed.** The plan implied the new token
layer would own spacing. It cannot yet: all 24 pages render a bare `<main>` and rely on
the old inline CSS's `body { margin: 1rem }` / `2rem` for their gutter. Zeroing it now
pushes the entire app edge-to-edge, and **no e2e test would catch it** — they assert
testids, not layout. The rule is preserved verbatim with a comment saying Phase 2's
`AppNav` removes it in the same change that replaces it.

**2. Radius tokens use plain `@theme`, not `@theme inline`.** `--radius-sm:
var(--radius-sm)` inside `@theme inline` is a self-reference that resolves to nothing.
Radius does not vary by register, so literal values in a plain `@theme` are correct.

**3. Coverage + cockpit built during Phase 0.** Planned for Phase 2; owner asked
mid-implementation. Building it (rather than deleting the references) closed the
standing e2e red, which is what makes "no new failures" a usable gate for Phases 1–3.

## Issues encountered

**The plan's e2e baseline was wrong.** It asserted 20/20 green. Measured by stashing
every change and re-running: **20 pass, 1 fail** — `app.spec.ts:352` requesting
`/api/admin/coverage`, a route that did not exist. A false baseline would have made
every later phase misread its own regressions, so this was corrected in the plan before
continuing.

The coverage feature was referenced in **three** places and implemented in **none**:
the nav link (`layout.tsx:43` → 404), the API call (the failing assertion), and
`geometry-coverage-table` (unreachable). `lib/queries.ts` already had both
`listCoverage` and `geometryCoverage`, so the query layer had been written and only the
route and page were missing.

**One flake identified, not a regression.** `app.spec.ts:46` (login) failed once in a
3.1m run — `toHaveURL` with a 5s timeout on a loaded dev server — and passed in a 1.5m
re-run alongside all 21. Recorded in the plan so a future run does not misread it.

## Files changed

| File | Action |
|---|---|
| `apps/web/app/globals.css` | CREATED — token layer, two registers |
| `apps/web/postcss.config.mjs` | CREATED |
| `docs/TASTE-insights.md` | CREATED |
| `apps/web/app/api/admin/coverage/route.ts` | CREATED |
| `apps/web/app/app/admin/coverage/page.tsx` | CREATED |
| `apps/web/app/layout.tsx` | UPDATED — import globals.css, drop inline CSS, set registers |
| `apps/web/app/app/layout.tsx` | UPDATED — cockpit added to nav |
| `apps/web/package.json` / `pnpm-lock.yaml` | UPDATED — Tailwind v4 |
| `.claude/PRPs/plans/…plan.md` | UPDATED — baseline corrected |

## Design decisions worth carrying forward

- **The palette is ported, not authored.** Every hex is OTN's. That is what keeps
  Insights and OTN reading as one company, and it means a palette change is a
  cross-product decision rather than a local one.
- **Contrast ratios are computed and commented inline**, following OTN's own
  discipline — its token file records a value that measured 4.43:1 and *failed* before
  correction. All pairs here are ≥ 5.0:1; dark ink-on-canvas is 18.9:1.
- **Dark is the default.** Insights is login-gated, so there is no public-page reason
  to start light.
- The new coverage page keeps `geocodable backlog` (not yet attempted) and
  `attempted, no location` (tried and failed) as **separate columns**. Summing them
  would turn "unknown" into "failed" — the exact mistake the fleet work hit twice.

## Next

- [ ] Phase 1 — proof primitives (`StatTile`, `SourceChip`, `RangeBar`,
      `ConfidenceMeter`, `GateBadge`) + layout primitives
- [ ] Phase 2 — `AppNav` (grouped rail, active state), command palette, density toggle;
      **removes `body { margin }`** in the same change
- [ ] Phase 3 — page retrofit, one page per task, e2e green after each
