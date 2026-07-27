# Plan: Cockpit UI — from data dump to first-class product

## Summary

`apps/web` has no design system. Global CSS is a 5-line inline `<style>` string in
`layout.tsx`, `lib/ui.tsx` is two `CSSProperties` objects plus a `Badge`, and there
are **281 inline `style={{` sites** across 24 pages / 5,728 lines of TSX. The product
underneath is strong — decision memos, confirmed-facts-vs-inferences, corroboration,
publication gates, evidence chains — and none of it is expressed visually. This plan
installs a Tailwind v4 foundation, ports OneTradeNetwork's proof-primitive contract,
and retrofits the pages onto it.

## User Story

As a trade contractor (and as the operator running the queues), I want the cockpit to
show me what to do next and why I should believe it, so that I act on the evidence
instead of reading a table and reconstructing the judgement myself.

## Problem → Solution

24 raw HTML pages where every number looks equally important and the strongest asset
— the evidence trail — renders as `<h2>` + `<p>` → a dense, premium, dark operator
cockpit where proof is the visual material and the next action is unmissable.

## Metadata

- **Complexity**: **XL** (foundation is Large; the retrofit is per-page and shippable
  incrementally). Phases 0–2 are the foundation; Phase 3+ converts pages.
- **Source PRD**: N/A — from the 2026-07-27 cockpit UI/UX review
- **Estimated Files**: ~14 new (tokens, primitives, shell, taste doc) + ~24 retrofitted

---

## Owner decisions (2026-07-27) — recorded, do not relitigate

| Question | Decision |
|---|---|
| Which surface | **TradesInsights `apps/web/app/app/*`** — the whole authenticated surface, customer pages *and* admin queues |
| Depth | **Foundation, then retrofit.** Tokens + primitives + shell first, then convert pages onto them |
| TASTE.md role | **Reference for method, not doctrine.** Mine the dials / core moves / anti-patterns / QA checklist; author an Insights-specific taste doc |
| Styling | **Tailwind v4** |
| Design reference | **OneTradeNetwork** — Insights is the SaaS product connected to it |
| Register | **More premium than OTN.** OTN avoided Tailwind because it is public; Insights is behind login, so it can afford more interaction and more design |

---

## The single most important fact for de-risking this

**The e2e suite selects by `data-testid` and ARIA role — never by class, style, or DOM
shape.** 20 tests, **27 distinct testids**, plus `getByRole("heading", { name: ... })`
assertions on exact heading text.

```ts
// SOURCE: apps/web/e2e/app.spec.ts:52-71
await expect(page.getByTestId("session-info")).toContainText("solis_interiors");
const rows = page.getByTestId("opportunities-table").locator("tbody tr");
await expect(page.getByTestId("decision-memo")).toBeVisible();
await expect(page.getByRole("heading", { name: "Confirmed facts vs. inferences" })).toBeVisible();
await expect(page.getByRole("heading", { name: "Publication gate" })).toBeVisible();
```

**Consequence: a total visual rebuild is safe as long as every `data-testid` and every
asserted heading string survives.** That converts this from a risky rewrite into a
mechanical one with a live regression net. It is also the acceptance gate — no NEW
failures after each page conversion, with zero edits to the spec files.

### BASELINE — now **21/21 green** (was 20 pass / 1 fail; fixed in Phase 0)

The pre-existing failure described below was closed during Phase 0 by building the
missing coverage feature. **The gate for every later task is 21/21.**

> Flake note: `app.spec.ts:46` (login) asserts `toHaveURL` with a 5s timeout and can
> flake on a cold/loaded dev server — it failed once in a 3.1m run and passed in the
> 1.5m re-run. If it fails alone, re-run before treating it as a regression.

<details><summary>The original finding, kept for provenance</summary>

**20 pass, 1 pre-existing failure**

An earlier draft of this plan asserted "20/20 green". That was wrong, and a false
baseline would have made every later phase misread its own regressions. Measured by
stashing all changes and re-running:

```
e2e/app.spec.ts:341 › admin surface › admin sees sources with health and the review queue
  → app.spec.ts:352  await request.get("/api/admin/coverage")  — route does not exist
1 failed, 20 passed
```

**The "coverage" feature is referenced in three places and implemented in none:**

| Reference | State |
|---|---|
| `layout.tsx:43` nav link → `/app/admin/coverage` | page route does not exist — 404 |
| `app.spec.ts:352` → `GET /api/admin/coverage` | API route does not exist — **this failure** |
| `app.spec.ts:357` asserts `geometry-coverage-table` | unreachable, never evaluated |

So the Phase 2 nav-bug task was larger than "fix a link": the feature was never built.

**RESOLVED in Phase 0 (owner asked for it mid-implementation).** Built rather than
deleted — `lib/queries.ts` already had `listCoverage` and `geometryCoverage`, so only
the route and the page were missing. Cockpit was added to the nav in the same change.

</details>

**Rule: never change a testid or an asserted heading string to suit a layout.** If a
redesign wants different wording, the copy stays and the visual treatment changes.
Editing the spec to match new markup destroys the only safety net this plan has.

The full testid contract to preserve:

```
session-info · opportunities-table · opportunity-filters · opportunity-count
opportunity-title · opportunity-map · map-summary · next-action
decision-memo · memo-recommended-action · memo-capacity · decision-brief
brief-narrative · talking-points · bid-clock · bid-window-<trade> · campus-panel
corroboration-panel · corroboration-contradictions · roi-table · unsupported-facts
leadtime-table · detection-lag-table · league-table · targets-table
radar-summary · radar-table · sources-table · review-table
geometry-coverage-table · triage-table
login-account · login-password · login-submit
```

---

## Two real bugs found while exploring — fix them in Phase 2

1. **`/app/admin/coverage` is a dead nav link.** `apps/web/app/app/layout.tsx:43`
   links to it; `apps/web/app/app/admin/` contains no `coverage/` directory. It 404s.
   (An e2e test asserts `geometry-coverage-table`, so the *content* lives somewhere —
   locate it before deleting the link, and wire the link to the real route.)
2. **`/app/admin/cockpit` is orphaned.** The Queue cockpit is the declared "front door
   to every identity/enrichment review lane" and is **not in the nav at all**. It is
   reachable only by "← cockpit" back-links *from the pages it is supposed to be the
   front door for* (`corporate-families:86`, `google-place-contested:165`,
   `google-place-review:120`, `registry-review:97`, `review:119`). You can only find
   the map once you are already lost.

---

## UX Design

### Before

```
┌───────────────────────────────────────────────────────────┐
│ OTN Insights  Pipeline Pursuits Opportunities Map Radar    │  ← 14 flat links,
│ Digests Invitations Organizations ROI Feedback Account     │    no grouping,
│ Sources "Review queue" Coverage(404)   solis · admin       │    no active state
├───────────────────────────────────────────────────────────┤
│ Opportunities — Solis Interiors                            │
│ Band: all priority_review weekly_digest promoted dismissed │  ← raw enum strings
│ [search][county▾][stage▾][ ]campus [Apply]                 │
│ ┌─────┬────────┬───────┬───────┬────────┬──────┐           │
│ │Score│Project │County │Stage  │Updated │Action│           │  ← 100 rows,
│ │ 72.5│Bldg A  │Pierce │permit │07-24   │view  │           │    every cell
│ │ 71.0│Bldg B  │King   │permit │07-24   │view  │           │    equal weight
│ └─────┴────────┴───────┴───────┴────────┴──────┘           │
└───────────────────────────────────────────────────────────┘
   No hierarchy. No "what do I do next". Evidence invisible.
```

### After

```
┌──────────┬────────────────────────────────────────────────┐
│ ◆ OTN    │  Opportunities                      ⌘K  ◐  ▾   │  ← grouped rail,
│ INSIGHTS │  Solis Interiors · 2,583 in digest             │    active state,
│          ├────────────────────────────────────────────────┤    command palette
│ WORK     │ ┌────────┐┌────────┐┌────────┐┌────────┐       │
│ ▸Pipeline│ │  1,660 ││   48   ││  12    ││  6.9d  │       │  ← StatTile row:
│ ▸Pursuit │ │Priority││Closing ││ New    ││ Median │       │    the answer to
│ ▸Opps  ●│ │ review ││ ≤7 days││ today  ││ lead   │       │    "what changed"
│          │ └────────┘└────────┘└────────┘└────────┘       │
│ FIND     ├────────────────────────────────────────────────┤
│ ▸Map     │ ▣ Priority  ▢ Digest  ▢ Promoted  ▢ Dismissed  │  ← labelled bands
│ ▸Radar   ├────────────────────────────────────────────────┤
│          │ ┌────────────────────────────────────────────┐ │
│ REACH    │ │ 72.5 ▰▰▰▰▱  Building A · Pierce            │ │  ← score as a
│ ▸Digests │ │ permit_issued · applied 07-24              │ │    RangeBar, not
│ ▸Invites │ │ ⬤ 3 sources  ⬤ parcel  ⚑ bid closes 6d     │ │    a bare number
│          │ │ → Call the GC: pre-bid on 08-04            │ │  ← next action is
│ MEASURE  │ └────────────────────────────────────────────┘ │    the loudest line
│ ▸ROI     │ ┌────────────────────────────────────────────┐ │
│          │ │ 71.0 ▰▰▰▰▱  Building B · King              │ │
│ ADMIN    │ └────────────────────────────────────────────┘ │
│ ▸Cockpit │                                                │
└──────────┴────────────────────────────────────────────────┘
   Dark evergreen + gold. Proof is the material. One next action per row.
```

### Interaction Changes

| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Navigation | 14 flat links, no active state, one 404 | Grouped rail (Work / Find / Reach / Measure / Admin), active state, cockpit reachable | Fixes both nav bugs |
| Finding a page | Read all 14 labels | `⌘K` command palette | Behind login — client JS is free |
| Band filter | Raw enums `priority_review` | Labelled segmented control | Mirror OTN's `bandLabel` map |
| A score | Bare number `72.5` | Number + `RangeBar` in the account's distribution | Score means nothing without spread |
| Evidence | `<h2>Evidence (7)</h2>` + list | `SourceChip` row, expandable | The trust wedge, made visible |
| Confirmed vs inferred | Two prose paragraphs | Two visually distinct panels | Never let an inference read as a fact |
| Next action | `<p>` under an `<h2>` | Loudest element in the card | The product's whole job |
| Density | Fixed | Comfortable / Compact toggle, persisted | Operators want 100 rows; buyers want 20 |
| Theme | Light-ish default | Dark authority default, light available | Premium cockpit register |

---

## Design dials for this surface

TASTE.md's dial vocabulary (`TASTE.md:94-121`), applied to Insights. Recorded because
the owner explicitly asked for **more premium than OTN**:

| Surface | DESIGN_VARIANCE | MOTION_INTENSITY | VISUAL_DENSITY |
|---|---:|---:|---:|
| OTN public directory (reference) | 4 | 2 | 7 |
| GoBJJ product/admin (reference) | 3 | 2 | 8 |
| **Insights cockpit (this plan)** | **6** | **4** | **7** |
| Insights admin queues | 4 | 2 | 8 |

Higher variance and motion than either reference **because the surface is behind a
login**: no crawlability requirement, no SEO constraint, no public-LCP anxiety. Density
stays high because it remains an operator's working tool, not a marketing page.

Motion at 4 means motion **explains state** — a row settling when its band changes, a
gate opening, a bid clock ticking down. It does not mean decorative animation. Every
transition must respect `prefers-reduced-motion`.

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `apps/web/e2e/app.spec.ts` | all 371 | **The contract.** Every testid and heading string that must survive |
| P0 | `apps/web/app/app/layout.tsx` | 1-53 | The shell being replaced; also both nav bugs |
| P0 | `apps/web/lib/ui.tsx` | 1-50 | The entire current design system — `table`, `cell`, `Badge`, `fmtDate`, `fmtMoney`, `healthTone` |
| P0 | `~/Downloads/OneTradeNetwork/apps/registry/src/app/globals.css` | 1-90 | **The token palette to port.** Dark `--bg-*`/`--accent-*`, light `--lt-*` with documented AA ratios, semantic `--surface-*` aliases |
| P0 | `~/Downloads/OneTradeNetwork/apps/registry/src/components/{StatTile,SourceChip,RangeBar}.tsx` | all | The proof-primitive contract to port |
| P1 | `apps/web/app/app/opportunities/[id]/page.tsx` | 86-410 | The richest proof vocabulary in the product; the flagship retrofit |
| P1 | `apps/web/app/app/opportunities/page.tsx` | 1-120 | List + filter + pagination pattern, repeated across pages |
| P1 | `~/Downloads/OneTradeNetwork/apps/registry/src/app/dashboard/insights/ui.tsx` | 1-45 | `formatScore`/`formatValuation`/`bandLabel`/`StatCard` — **already renders Insights' own domain objects** |
| P1 | `apps/web/app/app/admin/cockpit/page.tsx` | 1-60 | Best-written page in the app; its *content* model is the target for all others |
| P1 | `~/.claude/skills/frontend-patterns/SKILL.md` | 1-120 | Composition, compound components, server/client boundaries |
| P2 | `WA JiuJitsu Registry.../TASTE.md` | 94-121, 122-175, 598-661 | Dials, Core Moves, Anti-Patterns, QA checklist |
| P2 | `apps/web/next.config.ts` | all | `transpilePackages` + the `.js`→`.ts` `extensionAlias` — Tailwind must not break it |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| Tailwind v4 setup | tailwindcss.com/docs/installation/framework-guides/nextjs | v4 is CSS-first: `@import "tailwindcss"` + `@theme {}`, no `tailwind.config.js` required |
| Tailwind v4 `@theme` | tailwindcss.com/docs/theme | `@theme` emits real CSS custom properties — OTN's `--bg-primary` etc. port **verbatim** and become utilities |
| Next 15 + Tailwind v4 | `@tailwindcss/postcss` plugin | v4 uses a PostCSS plugin, not the v3 `tailwindcss` plugin. Wrong one = silent no-op |

```
KEY_INSIGHT: Tailwind v4's @theme block IS custom properties, so OTN's palette
             transfers without translation and both apps stay in visual sync.
APPLIES_TO:  Task 1
GOTCHA:      v4 needs @tailwindcss/postcss. Installing v3's `tailwindcss` PostCSS
             plugin produces no error and no styles.
```

---

## Patterns to Mirror

### TOKEN_PALETTE — port verbatim, do not invent a new palette
```css
/* SOURCE: OneTradeNetwork/apps/registry/src/app/globals.css:1-32 */
:root {
  --bg-primary: #061109;        /* Deep WA Evergreen / Black */
  --bg-secondary: #0a1f12;
  --text-primary: #f8f9fa;
  --text-secondary: #a8b8b0;
  --accent-primary: #D4AF37;    /* WA/Brazil Gold */
  --accent-tertiary: #009B3A;   /* Evergreen */
  --border-color: rgba(212, 175, 55, 0.1);
  --radius-sm: 8px; --radius-md: 12px; --radius-lg: 16px;
}
```
The light register carries **documented contrast ratios** — copy the discipline:
```css
/* SOURCE: globals.css:57 */
--lt-text-subtle: #636a75; /* AA: 5.0:1 on canvas, 4.7:1 on footer #edeef1
                              (was #6b7280 = 4.43, failed 4.5) */
```

### PROOF_PRIMITIVE — the contract to port
```tsx
// SOURCE: OneTradeNetwork/apps/registry/src/components/StatTile.tsx:1-3
// Proof primitive (platform design system, register A "authority"): a metric tile
// for real, sourced numbers — verified counts, indices, coverage stats. Never feed
// this fabricated values; taste.md rule 1 ("proof is the material") is the point.
```
```tsx
// SOURCE: SourceChip.tsx:1-3
// a small pill naming a data source or provenance fact
// The visible-source discipline is the trust wedge vs. opaque competitor numbers.
```
`RangeBar` computes `markerPercent` with a divide-by-zero guard (`span > 0 ? ... : 50`)
and builds an `ariaLabel` from the formatted values. Keep both.

### DOMAIN_FORMATTERS — already solved in OTN, do not re-derive
```ts
// SOURCE: OneTradeNetwork/.../dashboard/insights/ui.tsx:15-33
export function formatValuation(value: number | null): string {
  if (value === null) return "—";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${Math.round(value / 1_000)}k`;
  return `$${Math.round(value)}`;
}
const BAND_LABELS: Record<string, string> = {
  priority_review: "Priority", promoted: "Promoted",
  new: "New", dismissed: "Dismissed",
};
```

### CURRENT_UI_HELPERS — extend, keep the API
```tsx
// SOURCE: apps/web/lib/ui.tsx:11-45
export function fmtDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  ...
}
export function Badge({ children, tone }: { children: ReactNode; tone?: "green" | "amber" | "red" | "gray" })
export function healthTone(state: string): "green" | "amber" | "red" | "gray"
```
`—` for absent values is the established convention across both codebases. Never
render `0`, `null`, or an empty cell where the value is unknown.

### PAGE_PATTERN — server component, session guard, then query
```tsx
// SOURCE: apps/web/app/app/opportunities/page.tsx:29-49
export const dynamic = "force-dynamic";
export default async function OpportunitiesPage({ searchParams }: { searchParams: Promise<Params> }) {
  const session = await currentSession();
  if (!session?.accountKey) redirect("/login");
  const account = await accountByKey(db(), session.accountKey);
  if (!account) redirect("/login");
  const params = await searchParams;
  ...
}
```
Filters are a plain `<form method="get">` with URL state — **keep that.** It is
shareable, back-button-correct and needs no client JS. Do not convert to client state.

### TEST_STRUCTURE
```ts
// SOURCE: apps/web/e2e/app.spec.ts:248-250
await expect(page.getByTestId("opportunity-filters")).toBeVisible();
await expect(page.getByTestId("opportunity-count")).toContainText("matching");
const rows = page.getByTestId("opportunities-table").locator("tbody tr");
```
Note `locator("tbody tr")` — **the opportunities list must remain a real `<table>`
with a `<tbody>`.** A card-grid rewrite breaks this test. Either keep the table
semantics and style it as cards (`display: grid` on `tr`), or accept that this is the
one place the spec constrains DOM shape.

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `apps/web/app/globals.css` | CREATE | Tailwind v4 entry + `@theme` tokens ported from OTN |
| `apps/web/postcss.config.mjs` | CREATE | `@tailwindcss/postcss` |
| `apps/web/package.json` | UPDATE | `tailwindcss@4`, `@tailwindcss/postcss` |
| `apps/web/app/layout.tsx` | UPDATE | Import globals.css; delete the 5-line inline `GLOBAL_CSS` |
| `apps/web/lib/ui.tsx` | UPDATE | Keep formatters + `Badge` API; move styling to classes |
| `apps/web/components/proof/StatTile.tsx` | CREATE | Ported primitive |
| `apps/web/components/proof/SourceChip.tsx` | CREATE | Ported primitive |
| `apps/web/components/proof/RangeBar.tsx` | CREATE | Ported primitive |
| `apps/web/components/proof/ConfidenceMeter.tsx` | CREATE | Insights-specific: corroboration strength |
| `apps/web/components/proof/GateBadge.tsx` | CREATE | Insights-specific: publication-gate state |
| `apps/web/components/shell/AppNav.tsx` | CREATE | Grouped rail, active state, both nav bugs fixed |
| `apps/web/components/shell/CommandPalette.tsx` | CREATE | `⌘K` — client component |
| `apps/web/components/shell/DensityToggle.tsx` | CREATE | Comfortable/Compact, persisted |
| `apps/web/components/ui/{Card,Panel,PageHeader,EmptyState,Table}.tsx` | CREATE | Layout primitives |
| `apps/web/app/app/layout.tsx` | UPDATE | Use `AppNav`; fix dead link + orphaned cockpit |
| `docs/TASTE-insights.md` | CREATE | Insights-specific taste doc + dials + QA checklist |
| `apps/web/app/app/**/page.tsx` | UPDATE | Retrofit, one page per task, e2e green after each |

## NOT Building

- **No change to any `data-testid` or asserted heading string.** The contract is fixed.
- **No e2e spec edits.** If a test fails, the markup is wrong, not the test.
- **No conversion of GET-form filters to client state.** URL state is correct.
- **No new data, metrics, or scores.** This is presentation. If a number is not already
  computed and evidence-backed, it does not appear. (TASTE anti-pattern: "fake counts,
  fake coordinates, placeholder business facts"; repo rule: never fabricated.)
- **No charting library in the foundation phases.** `RangeBar` is CSS. Revisit only if
  a page genuinely needs a time series.
- **No public/marketing pages.** Login page gets tokens only.
- **No OTN changes.** OTN is the reference, not a target. Do not "sync" it to Tailwind.
- **No auth, routing, or query changes.** `lib/{auth,db,queries}.ts` untouched.

---

## Step-by-Step Tasks

## PHASE 0 — Foundation (gates everything) · **COMPLETE 2026-07-27**
> Report: `.claude/PRPs/reports/cockpit-ui-first-class-product-phase0-report.md`

### Task 0.1: Install Tailwind v4
- **ACTION**: Add `tailwindcss@^4` + `@tailwindcss/postcss` to `apps/web`; create
  `postcss.config.mjs` with `{ plugins: { "@tailwindcss/postcss": {} } }`.
- **GOTCHA**: v4 uses `@tailwindcss/postcss`. The v3 `tailwindcss` PostCSS plugin
  fails **silently** — no error, no styles.
- **GOTCHA**: `next.config.ts` sets `webpack.resolve.extensionAlias` for `.js`→`.ts`
  and a separate `turbopack.resolveExtensions`. Adding PostCSS must not disturb
  either. Verify `pnpm --filter @otn/web build` **and** `dev`.
- **VALIDATE**: A throwaway `<div className="bg-red-500">` renders red in `dev`.

### Task 0.2: Token layer ported from OTN
- **ACTION**: Create `apps/web/app/globals.css` — `@import "tailwindcss";` then a
  `@theme` block carrying OTN's palette.
- **MIRROR**: `TOKEN_PALETTE`. Port values **verbatim** so the two products stay in
  visual sync; do not invent a palette.
- **IMPLEMENT**: Dark register as the **default** (`--color-bg-primary: #061109`,
  gold accent), light register available. Semantic aliases (`--color-surface`,
  `--color-ink`, `--color-muted`) so components never reference a raw hex.
- **GOTCHA**: Every colour pair must pass **AA 4.5:1**. OTN documents its ratios
  inline (`globals.css:57` records a value that *failed* at 4.43 and was fixed) —
  copy that discipline: comment the measured ratio next to any non-obvious pair.
- **VALIDATE**: `layout.tsx` imports globals.css, the inline `GLOBAL_CSS` string is
  deleted, and every page still renders. Contrast-check the four most common pairs.

### Task 0.3: Insights taste doc
- **ACTION**: Write `docs/TASTE-insights.md`: intent, the dials table above,
  Core Moves adapted (**Proof Is The Material** is rule 1), the anti-pattern list, the
  Clarify/Distill/Proof-load/Bolder/Quieter/Typeset/Harden vocabulary, and a QA
  checklist with viewports `1440x900 / 768x1024 / 390x844`.
- **MIRROR**: `TASTE.md:94-121`, `:598-661`.
- **GOTCHA**: Do **not** copy the public-directory sections (crawlable links, pSEO,
  conversion CTAs). Insights is behind a login; those rules do not apply and importing
  them will produce marketing-shaped operator pages.
- **VALIDATE**: The doc states what Insights optimizes for in one paragraph, and every
  later task can cite a rule from it.

## PHASE 1 — Primitives · **COMPLETE 2026-07-27**
> Report: `.claude/PRPs/reports/cockpit-ui-first-class-product-phase1-report.md`
> 27 unit tests; `StatTile.value` widened to `string | number | null`; no scratch
> route (it would have been an orphaned page — the bug this plan opens by naming).

### Task 1.1: Port the three proof primitives
- **ACTION**: `components/proof/{StatTile,SourceChip,RangeBar}.tsx`, CSS Modules →
  Tailwind classes, same props, same comments (they explain *why* the primitive exists).
- **MIRROR**: `PROOF_PRIMITIVE`.
- **GOTCHA**: Keep `RangeBar`'s `span > 0 ? ... : 50` divide-by-zero guard and its
  generated `ariaLabel`. A range where low === high is real (single-sample markets).
- **GOTCHA**: Keep the "never feed this fabricated values" comment. It is the link
  between the design system and the repo's governing rule.
- **VALIDATE**: Render all three in a scratch route at both registers; `RangeBar` with
  `low === high` does not produce `NaN%`.

### Task 1.2: Insights-specific primitives
- **ACTION**: `ConfidenceMeter` (distinct-source count + contradiction flag, from the
  existing `corroboration-panel` data) and `GateBadge` (publication-gate state).
- **IMPLEMENT**: Both must render an **explicit unknown** state — the pipeline
  distinguishes "no evidence" from "evidence says zero", and the UI must too.
- **GOTCHA**: This is the same trap the fleet work hit twice — an orphaned run's zero
  is an *unwritten value*, not a measurement. A meter that renders unknown as empty
  tells the user something false.
- **VALIDATE**: Unit test: `null` input renders the unknown state, not a zero bar.

### Task 1.3: Layout primitives
- **ACTION**: `components/ui/{Card,Panel,PageHeader,EmptyState,Table}.tsx`.
- **MIRROR**: `frontend-patterns` composition + compound components (`Card` /
  `CardHeader` / `CardBody`).
- **GOTCHA**: `Table` must render a real `<table><tbody>` — `app.spec.ts:250` does
  `.locator("tbody tr")`. Style rows as cards via CSS if desired; do not replace the
  element.
- **GOTCHA**: Server components by default. Only `CommandPalette` and `DensityToggle`
  get `"use client"`. Do not let a `"use client"` leak up into a page.
- **VALIDATE**: `pnpm typecheck`; no `"use client"` in any `components/ui/*`.

## PHASE 2 — Shell (fixes both nav bugs) · **COMPLETE 2026-07-27**
> Report: `.claude/PRPs/reports/cockpit-ui-first-class-product-phase2-report.md`
> **e2e baseline is now 28** (21 original + 7 in the new `e2e/shell.spec.ts`).
> The harness was hardened first — built server, one worker — so Phase 3's
> per-page gate means something. The production-DB half is still open.
> Deviations: `data-density` is NOT server-rendered (React reconciles it away at
> hydration); four admin lanes are palette-only, by design.

### Task 2.1: `AppNav`
- **ACTION**: Replace the flat 14-link nav with a grouped rail: **Work** (Pipeline,
  Pursuits, Opportunities) · **Find** (Map, Radar) · **Reach** (Digests, Invitations,
  Organizations) · **Measure** (ROI, Feedback) · **Admin** (Cockpit, Sources, Review,
  Coverage). Active state from `usePathname`.
- **ACTION**: **Add Queue cockpit to the admin group** — it is the declared front door
  and is currently unreachable except from inside.
- **ACTION**: **Resolve `/app/admin/coverage`.** The route does not exist. Find where
  `geometry-coverage-table` actually renders and point the link there; if it has no
  route, remove the link. Do not ship a nav item that 404s.
- **GOTCHA**: Keep `data-testid="session-info"` with the same
  `{accountKey} · {role}` text — `app.spec.ts:52` asserts it.
- **GOTCHA**: The admin group renders only for `session.role === "admin"`, and the
  account group only when `session.accountKey` is set. Preserve both conditions
  exactly (`layout.tsx:24,39`).
- **VALIDATE**: `pnpm test:e2e` green. Every nav link resolves — click each.

### Task 2.2: Command palette + density toggle
- **ACTION**: `⌘K` / `Ctrl+K` palette over routes and account switching;
  Comfortable/Compact toggle persisted to `localStorage`, applied as a root data
  attribute the token layer reads.
- **GOTCHA**: Client components. Keep them leaf-level so pages stay server components.
- **GOTCHA**: Palette must be keyboard-complete and focus-trapped, and must not
  hijack `⌘K` when focus is in a text input.
- **VALIDATE**: Keyboard-only navigation to any route; density persists across reload;
  `prefers-reduced-motion` disables the open/close transition.

## PHASE 3 — Retrofit, one page per task

Order by value. **Each task ends with `pnpm test:e2e` green and is independently
shippable.** Convert page → run e2e → commit. Never batch conversions.

### Task 3.1: Opportunities list — the flagship
- **ACTION**: StatTile summary row; labelled band control; score as number + `RangeBar`;
  `SourceChip` row per opportunity; next action as the loudest line.
- **MIRROR**: `DOMAIN_FORMATTERS` for `bandLabel` / `formatValuation`.
- **GOTCHA**: Keep the `<form method="get">` filters and URL state (`PAGE_PATTERN`).
- **GOTCHA**: `opportunities-table` must stay a `<table>` with `<tbody>` rows.
- **VALIDATE**: e2e green; `opportunity-count` still contains "matching".

### Task 3.2: Opportunity detail — the proof showcase
- **ACTION**: Restructure into evidence panels: bid clock, decision brief, decision
  memo, corroboration, **confirmed facts vs. inferences** (two visually distinct
  treatments), evidence chain via `SourceChip`, publication gate via `GateBadge`.
- **GOTCHA**: The headings `"Confirmed facts vs. inferences"` and `"Publication gate"`
  are asserted **by exact text** (`app.spec.ts:70-71`). Do not reword them.
- **GOTCHA**: 12 testids live on this page — `opportunity-title`, `next-action`,
  `decision-memo`, `memo-recommended-action`, `memo-capacity`, `decision-brief`,
  `brief-narrative`, `talking-points`, `bid-clock`, `bid-window-<trade>`,
  `campus-panel`, `corroboration-panel`, `corroboration-contradictions`. Enumerate
  them before editing and diff after.
- **GOTCHA**: An inference must never be able to read as a fact. This is the strongest
  rule on the page — the brief validator already rejects unsubstantiated claims
  server-side; the UI must not undo that visually.
- **VALIDATE**: e2e green; inference panel is visually distinct at a glance.

### Task 3.3: Pipeline · 3.4: Pursuits · 3.5: Radar · 3.6: Map · 3.7: ROI
- **ACTION**: Convert onto shell + primitives.
- **GOTCHA (Map)**: Leaflet needs its own CSS and a client boundary; `map-summary` and
  `opportunity-map` testids must survive, and `app.spec.ts:262` asserts an SVG `path`
  renders inside the map.
- **GOTCHA (ROI)**: `unsupported-facts` is asserted — the "what we could not verify"
  surface. Make it more prominent, never less.
- **VALIDATE**: e2e green after each.

### Task 3.8: Admin queues + Queue cockpit
- **ACTION**: Convert the six admin pages. The cockpit's *content* model — mission,
  owner-ordered lanes, "seam offline" instead of a fake zero — is already right; give
  it the visual treatment it deserves and propagate the model to the lanes.
- **GOTCHA**: `cockpit/page.tsx:44-49` shows "Registry seam offline" rather than zeros
  when `REGISTRY_DATABASE_URL` is unset. Preserve that distinction — it is the same
  never-fabricate rule.
- **GOTCHA**: Only aggregate integers render on the cockpit; no principal or person
  names (privacy contract, `cockpit/page.tsx:25`). Do not add detail in redesign.
- **VALIDATE**: e2e green (`sources-table`, `review-table`, `triage-table`).

### Task 3.9: Sweep for stragglers
- **ACTION**: `grep -rn "style={{" apps/web/app --include="*.tsx" | wc -l` → drive
  toward zero. Baseline is **281**.
- **GOTCHA**: A few may be legitimately dynamic (computed widths, map positioning).
  Leave those and comment why. The goal is no *static* inline styling.
- **VALIDATE**: Count reported; every survivor has a comment justifying it.

---

## Testing Strategy

| Test | Input | Expected | Edge? |
|---|---|---|---|
| e2e after each page | existing 20 tests | green, spec unedited | — |
| testid inventory | before/after per page | identical set | — |
| `RangeBar` degenerate | `low === high` | marker at 50%, no `NaN` | ✓ |
| `ConfidenceMeter` unknown | `null` | unknown state, not a zero bar | ✓ |
| `StatTile` absent value | `null` | `—`, never `0` | ✓ |
| Density persistence | toggle, reload | persists | — |
| Reduced motion | `prefers-reduced-motion` | no transitions | ✓ |
| Contrast | 4 most common pairs | ≥ 4.5:1 | ✓ |
| Nav completeness | click every link | no 404 | ✓ |

### Edge cases
- [ ] Account with **zero** opportunities — `EmptyState`, not an empty table
- [ ] Score `null` (unscored) — must not render as `0`
- [ ] Registry seam offline — "seam offline", never a fake zero
- [ ] 100-row page at Compact density on 390x844
- [ ] Long project names / long jurisdiction strings — wrap, no overflow
- [ ] Admin-role user with no `accountKey` — account nav group hidden
- [ ] Keyboard-only: reach every action, visible focus throughout

---

## Validation Commands

```bash
pnpm typecheck
```
EXPECT: zero errors, 11 packages

```bash
pnpm lint
```
EXPECT: 0 errors (baseline clean as of 2026-07-27)

```bash
pnpm --filter @otn/web build
```
EXPECT: build succeeds — catches Tailwind/PostCSS + `extensionAlias` interaction

```bash
pnpm --filter @otn/web test:e2e
```
EXPECT: 20/20, **with zero edits to any spec file**

```bash
grep -rn "style={{" apps/web/app --include="*.tsx" | wc -l
```
EXPECT: 281 → ~0 by Task 3.9

### Manual
- [ ] Screenshot `1440x900`, `768x1024`, `390x844` — no overlap, overflow, or awkward wrap
- [ ] First viewport says what the page is and what to do next
- [ ] Every card has a job: entity, proof, action, status, or framed tool
- [ ] Buttons have distinct purposes and visible focus
- [ ] No fabricated value anywhere to make the UI look fuller

---

## Acceptance Criteria
- [ ] Tailwind v4 installed; `layout.tsx`'s inline `GLOBAL_CSS` deleted
- [ ] Tokens ported verbatim from OTN — Insights and OTN visibly one family
- [ ] `StatTile` / `SourceChip` / `RangeBar` ported with their "never fabricated" comments
- [ ] `docs/TASTE-insights.md` exists with dials **6 / 4 / 7**
- [ ] Nav grouped with active state; **cockpit reachable**; **no 404 link**
- [ ] `⌘K` palette and density toggle work keyboard-only
- [ ] All 27 testids and both asserted headings intact; **spec files unedited**
- [ ] 20/20 e2e green
- [ ] Every score renders with distribution context, never a bare number
- [ ] Confirmed facts and inferences are visually unmistakable
- [ ] Unknown never renders as zero, anywhere
- [ ] Static inline styles ≈ 0; survivors commented
- [ ] AA 4.5:1 on all text pairs; reduced motion respected

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Card-grid rewrite breaks `locator("tbody tr")` | **High** | Medium | Keep `<table><tbody>`; style rows as cards |
| A testid is dropped mid-retrofit | **High** | **High** | Inventory before/after each page; e2e after every page, never batched |
| Tailwind v4 vs `extensionAlias` in `next.config.ts` | Medium | High | Task 0.1 validates `build` **and** `dev` before any page work |
| v3 PostCSS plugin installed — silent no-op | Medium | Medium | Explicit red-div check in Task 0.1 |
| Premium dial drifts into decoration | Medium | Medium | Dials recorded (6/4/7); anti-pattern list in the taste doc; motion must explain state |
| Half-migrated UI if abandoned mid-phase | Medium | Medium | Foundation-first; each page task independently shippable |
| Redesign invents numbers to fill space | Low | **High** | "No new data" in NOT Building; primitives carry the never-fabricate comment |
| **The e2e gate is load-fragile** (MEASURED 2026-07-27) | **High** | **High** | See below — fix before Phase 3 |

### The e2e gate must be hardened before Phase 3 (added 2026-07-27, Phase 1)

Phase 3's entire safety argument is "e2e green after each page". During Phase 1
validation the suite failed **9 of 21** on one run and passed **21/21** on an
identical re-run minutes later with no code change — and the change set under test
contained nothing any page imports, so a real regression was impossible.

The structural cause is in the harness, not the tests: `playwright.config.ts` runs
`pnpm dev`, and the repo `.env` points `DATABASE_URL` at the **hosted production
database** (pool max 2). The suite is therefore a dev-mode on-demand compile racing
a two-connection remote pool under a 60s per-test budget.

A gate that can report nine failures for environmental reasons cannot distinguish a
dropped testid from a bad afternoon, which is exactly the failure this plan is built
to prevent. **Fix first:** point e2e at a seeded local database, or run against a
pre-built server (`next build && next start`) instead of `next dev`. Until then,
treat any e2e failure as unproven until a clean re-run confirms it — and never treat
a *pass* obtained by re-running as evidence that a genuine failure was a flake.

## Notes

- **The proof already exists; the UI doesn't express it.** Decision memos,
  confirmed-facts-vs-inferences, corroboration with contradictions, publication gates,
  evidence chains, bid clocks — all computed, all rendered as `<h2>` + `<p>`. This is a
  presentation problem, not a data problem, which is why "no new data" is a hard boundary.
- **OTN already renders Insights' own domain objects.** `dashboard/insights/ui.tsx` has
  `CockpitOpportunity`, `formatScore`, and a `BAND_LABELS` map over the *same*
  `priority_review` / `promoted` / `dismissed` vocabulary. The design reference is
  literal, not analogical — port the formatters rather than rewriting them.
- **Why Insights may exceed OTN's restraint (owner, 2026-07-27):** OTN is public, so it
  pays for crawlability and bundle size. Insights is behind a login and pays neither.
  That is the entire justification for the higher dials — not taste drift.
- **The best-written page is `admin/cockpit`.** Its comment block explains the mission,
  the owner's lane ordering, and why "seam offline" beats a fake zero. Its *content*
  model is the standard every other page should be held to; it just looks like 1997.
- The 5-line `GLOBAL_CSS` string does carry one real idea worth keeping — tables
  scroll inside themselves on phones rather than forcing page overflow
  (`layout.tsx:16-17`). Re-implement it in the token layer; do not lose it.
