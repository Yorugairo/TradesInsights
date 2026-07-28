# Plan: CRM upgrade — takeoff scaffolding + field communication

> **Working doc + source of truth.** Every claim in the pattern sections was read out of the
> repo on 2026-07-27, not inferred. If a claim here disagrees with the code, the code wins and
> this file gets fixed.

## Summary

Upgrade the Insights cockpit's CRM surface (pursuits) with the two systems appendix slide A5
of the Solis deck already promised as concepts: a **takeoff/estimate scaffold** derived from
permit evidence, and **field communication** (daily logs + field-approved change orders +
tokenized crew share links). A6's framing — *"estimate, then measure yourself against it"* —
is the connective tissue: takeoff quantities become the baseline that field daily logs measure
against.

## User Story

As **a drywall/paint subcontractor owner running pursuits in the cockpit**, I want an estimate
scaffold pre-filled from what the permit already tells us, and a way for my field crew to log
daily production and capture change orders on their phones without cockpit logins, so that
bids start from evidence instead of a blank sheet and the 10–15% currently lost to verbal
agreements gets written down and approved.

## Problem → Solution

**Current:** a pursuit tracks state, tasks, notes, and three hand-typed money fields
(`estimated/submitted/outcome value`). Estimating starts from zero outside the product; field
reality (production, extras) never enters the system, so ROI attribution rests on hand-typed
numbers and change orders live in text messages.
**Desired:** "Start takeoff" on a pursuit yields an editable assembly worksheet seeded from
permit evidence (sqft/units/valuation, provenance shown, `~` labelled); its total can stamp
`estimatedContractValue`. A field link (no login) lets the crew submit daily logs and change
orders; COs queue for owner approval in the cockpit; approved extras and logged quantities sit
beside the takeoff baseline.

## Metadata

- **Complexity**: XL — split into two independently shippable phases (A: takeoff, B: field).
  Implement A → ship checkpoint → B. Nothing in B depends on A except the variance rollup
  (B6), which degrades gracefully when no sheet exists.
- **Source PRD**: N/A (mandate is deck appendix A5/A6, `docs/meetings/2026-07-26-solis/presentation.html:1420-1465`)
- **Repo**: `TradesInsights` — **pnpm** (the sibling registry repo is npm; do not copy commands)
- **Estimated files**: ~24 (1 migration, 3 new services + tests, 6 routes, 4 pages/components, e2e spec, docs)

---

## GROUND TRUTH (read 2026-07-27)

### The mandate already exists, shown to the customer

`presentation.html:1420-1451` (slide sA5): field communication is billed **"fast to build"**
— daily logs (board counts, linear feet taped, crew hours), photo punch lists, change orders
(photo, description, signature, approved in the field), offline-first — and named "the lever
from A4 that actually recovers money — the 10–15% currently lost to verbal agreements."
AI takeoff is billed **"genuinely hard"** — 80–90% automation with human review is the stated
ceiling, "estimator keeps the pen." The foot: *"Concepts only — neither exists today."*
Slide sA6: the two belong together — estimate first, then measure the field against it.

**Consequence for scope:** v1 takeoff is the A6 parametric scaffold, NOT blueprint reading.
The pipeline holds permits, not plan sets — there are no drawings to read. v1 field comms is
logs + COs + share links, NOT offline-first and NOT photo pins on drawings.

### What already exists (more than expected)

| Capability | Where | State |
|---|---|---|
| Pursuit CRM: states, transitions, tasks, notes | `packages/intelligence/src/pursuit.ts`, `apps/web/app/app/pursuits/[id]/page.tsx` | LIVE. Notes even carry `visibility` (default `'account'`) — a field lane was anticipated |
| Money fields on pursuits | `schema.ts:601-603` `estimatedContractValue / submittedValue / outcomeValue` | LIVE, hand-typed today; takeoff feeds the first |
| Tokenized no-login actions | `action_tokens` (`schema.ts:262-278`), `apps/web/app/api/action/route.ts` | LIVE + security-hardened; THE pattern for field links |
| Outbound email | `packages/delivery/src/deliver.ts:156-162` nodemailer, `SMTP_HOST`/`SMTP_PORT`/`EMAIL_FROM`, dev default `localhost:1025` | LIVE, env-gated |
| Inbound email + parsing | `inbound_messages`/`bid_invitations` (`schema.ts:665-706`), `@otn/documents parseInvitationEmail` | LIVE |
| Document text extraction | `@otn/documents` `pdfToMarkdown`, `readXlsx` | LIVE |
| Evidence text per project | `score-run.ts:83` `COALESCE(rec.text, lower(p.canonical_name)) AS text` | LIVE — same substrate takeoff derivation reads |

### The four constraints that shape the design

1. **No per-user auth.** Login is passphrase + accountKey + role (`e2e/app.spec.ts:20-23`,
   `lib/auth.js`). Field crew therefore get **tokenized links**, not accounts. Do not build
   user management.
2. **`RE` in scoring.ts is NOT exported** (`scoring.ts:156` `const RE = {`) and touching
   `scoring.ts` risks the byte-identical eval gates. Takeoff defines its own extraction
   patterns and accepts the drift risk deliberately (documented at the definition site).
3. **apps/web pool max is 2.** Page loaders read **sequentially** — a `Promise.all` of two
   page reads has previously starved the app and broke 3 unrelated e2e tests.
4. **`raw_artifacts` is source-scoped** (`source-sdk/runner.ts:202`; rows belong to a
   `source_id`) — it is NOT a home for field photos. Photo storage is a real infra decision
   → isolated into optional Task B7.

### Migration state

Highest applied: `packages/db/migrations/0037_corporate_family_summary.sql` → **next is 0038**.
Drizzle applies by journal timestamp: **never edit an applied migration** (silent no-op).
`action_tokens.action` has a DB CHECK (migration 0019) listing `pursue|dismiss` — one reason
field links get their own table instead of extending it (the other: field links are
multi-use; action tokens are single-use by design).

---

## UX Design

### Before
```
Pursuit detail: [state · owner · money fields] [transitions] [tasks] [history] [notes]
Estimating happens in a spreadsheet outside the product.
Field crew get forwarded texts; change orders are verbal.
```

### After
```
Pursuit detail additionally shows:
┌─ Takeoff ────────────────────────────┐  ┌─ Field ────────────────────────────────┐
│ 12 lines · subtotal ~$48,200         │  │ links: Javier ✓  Daniel ✓  [+ link]    │
│ derived 9 · manual 3 · waste 10%     │  │ Mon: 84 boards · 310 LF · 27 crew-hrs  │
│ [Open sheet] [Use as estimated value]│  │ CO #2 "water damage N wall" ~$1,850    │
└──────────────────────────────────────┘  │   [Approve] [Reject]                   │
Sheet page: editable qty/unit-cost table  └────────────────────────────────────────┘
with per-line provenance + CSV export.    Crew phone (tokenized, no login):
                                          job brief · daily log form · CO form
```

### Interaction Changes

| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Pursuit detail | tasks/notes/history | + Takeoff card, + Field section | testids on both |
| `estimatedContractValue` | hand-typed | one-click stamp from sheet total | PATCH pursuit, explicit button — never automatic |
| Crew phone | nothing | `/field/{token}` brief + forms | GET-safe render, POST mutates; mirrors `/api/action` hardening |
| Change orders | verbal | submitted → owner approves/rejects in cockpit | approval writes a pursuit note (audit trail in an existing surface) |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `packages/intelligence/src/pursuit.ts` | 1–130, 225–300 | Service shape, `PursuitError` codes, task/note inserts, `getPursuitDetail` |
| P0 | `apps/web/app/api/action/route.ts` | all | Token surface hardening: GET-safe/POST-consume, esc(), rate limiter, no-store |
| P0 | `apps/web/lib/api.ts` | all | `withAccount`/`withAdmin`/`jsonError` — every new route uses these |
| P0 | `packages/db/src/schema.ts` | 262–278, 589–706 | actionTokens, pursuits*, inbound/bid tables — the tables being extended beside |
| P1 | `apps/web/app/app/pursuits/[id]/page.tsx` | all | Page pattern: session→account→sequential reads→testids, `lib/ui.js` helpers |
| P1 | `packages/delivery/src/deliver.ts` | 40–170 | deliveries idempotency, draft→sent, nodemailer env gate, action-link injection |
| P1 | `apps/web/app/api/app/pursuits/[id]/notes/route.ts` | all | Smallest complete route to clone |
| P1 | `apps/web/e2e/app.spec.ts` | 1–60 | login helper, dotenv path, testid conventions |
| P2 | `packages/intelligence/src/scoring.ts` | 150–200, 425–460 | RE patterns to adapt (NOT import), `appliedFreshness` doc style |
| P2 | `apps/web/app/api/app/invitations/upload/route.ts` | all | Upload route shape (Task B7 only) |

## External Documentation

None needed — every mechanism (drizzle, nodemailer, tokens, Playwright) is already in the
repo. The one genuinely external topic (Supabase Storage for photos) is quarantined in B7
with its decision still open.

---

## Patterns to Mirror

### ROUTE_HANDLER (auth + error envelope)
```ts
// SOURCE: apps/web/app/api/app/pursuits/[id]/notes/route.ts:6-17
export const POST = withAccount<{ id: string }>(async ({ db, account, session, params, req }) => {
  const detail = await getPursuitDetail(db, params.id);
  if (!detail || detail.accountProfileId !== account.id) return jsonError(404, "pursuit not found");
  const body = (await req.json().catch(() => ({}))) as { body?: string };
  if (!body.body?.trim()) return jsonError(400, "body required");
  ...
  return NextResponse.json({ id }, { status: 201 });
});
```
Ownership check FIRST, parse-with-catch, `jsonError`, 201 on create. `withAccount` guarantees
account scoping by construction (spec §17) — no route may query unscoped.

### SERVICE_FUNCTION (packages/intelligence)
```ts
// SOURCE: packages/intelligence/src/pursuit.ts:240-247
export async function addPursuitNote(
  db: Db, pursuitId: string,
  input: { authorUserId: string; body: string; visibility?: string },
): Promise<{ id: string }> {
  const res = await db.execute(sql`INSERT INTO pursuit_notes (...) VALUES (...) RETURNING id`);
```
`(db, id, input)` signature, raw `sql` template, `RETURNING id`, typed error class with a
string `code` union (`pursuit.ts:52-62`) — new `TakeoffError`/`FieldError` copy this shape.

### CONSTANT_VOCABULARY (validated in service, listed as const)
```ts
// SOURCE: packages/intelligence/src/pursuit.ts:45-50
export const PURSUIT_TASK_TYPES = [
  "verify_gc", "verify_bid_status", ...,
] as const;
export type PursuitTaskType = (typeof PURSUIT_TASK_TYPES)[number];
```

### TOKEN_SURFACE (unauthenticated, hardened)
```ts
// SOURCE: apps/web/app/api/action/route.ts:9-15, 24-26, 53-67
// - GET is SAFE and replayable ... mail gateways prefetch every emailed link
// - POST ... atomically consumes
// - no-store + no-referrer; per-IP limiter; HTML escaped by construction
function esc(s: string): string { return s.replace(/&/g, "&amp;")... }
```
Field links reuse ALL of this verbatim except single-use consumption (crew revisit all week):
validity = not expired, not revoked, hash matches. Raw token never stored — SHA-256 only
(`schema.ts:266-267`).

### PAGE_LOADER (server component, pool-safe)
```tsx
// SOURCE: apps/web/app/app/pursuits/[id]/page.tsx:12-19
const session = await currentSession();
if (!session?.accountKey) redirect("/login");
const account = await accountByKey(db(), session.accountKey);
...
const p = await getPursuitDetail(db(), id);   // sequential awaits — pool max 2
```
Plus `export const dynamic = "force-dynamic"` and `data-testid` on assertion targets.

### TABLE_DEFINITION (drizzle)
```ts
// SOURCE: packages/db/src/schema.ts:646-657
export const pursuitNotes = pgTable("pursuit_notes", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  pursuitId: uuid("pursuit_id").notNull().references(() => pursuits.id),
  ...
  createdAt: now(),
}, (t) => [index("pursuit_notes_pursuit_ix").on(t.pursuitId, t.createdAt)]);
```

### TEST_STRUCTURE (e2e)
```ts
// SOURCE: apps/web/e2e/app.spec.ts:15-24
async function login(request, accountKey, role = "customer") {
  const res = await request.post("/api/auth/login", { data: { password: PASSWORD, accountKey, role } });
```
New coverage goes in a NEW spec file. The four existing specs are the redesign safety net —
**never edit an existing spec**.

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `packages/db/migrations/0038_takeoff_field.sql` | CREATE | All four tables + indexes, additive only |
| `packages/db/src/schema.ts` | UPDATE | drizzle defs for the four tables |
| `packages/intelligence/src/takeoff.ts` (+`.test.ts` in `apps/worker/test/`) | CREATE | catalog, extraction, derive/upsert/total services |
| `packages/intelligence/src/field.ts` (+ test) | CREATE | links (mint/verify/revoke), entries, CO approve/reject |
| `packages/intelligence/src/index.ts` | UPDATE | export new modules |
| `apps/web/app/api/app/pursuits/[id]/takeoff/route.ts` | CREATE | GET (get-or-create), POST rederive, PATCH sheet meta |
| `apps/web/app/api/app/pursuits/[id]/takeoff/lines/route.ts` | CREATE | POST add manual line; PATCH/DELETE by lineId in body |
| `apps/web/app/api/app/pursuits/[id]/field-links/route.ts` | CREATE | GET list, POST mint (returns raw token once), DELETE revoke |
| `apps/web/app/api/app/pursuits/[id]/field-entries/[entryId]/decision/route.ts` | CREATE | POST approve/reject CO |
| `apps/web/app/field/[token]/page.tsx` | CREATE | crew brief + forms (server-rendered, mobile-first, no auth) |
| `apps/web/app/api/field/[token]/entries/route.ts` | CREATE | POST daily_log / change_order (token-gated, rate-limited) |
| `apps/web/app/app/pursuits/[id]/page.tsx` | UPDATE | Takeoff card + Field section (sequential reads) |
| `apps/web/app/app/pursuits/[id]/takeoff/page.tsx` (+ `sheet-editor.tsx` client) | CREATE | editable worksheet |
| `apps/web/e2e/field-takeoff.spec.ts` | CREATE | new spec file only |
| `docs/STATUS.md`, this plan's history | UPDATE | close-out |

## NOT Building

- **AI blueprint takeoff.** No plan sets exist in the pipeline; A5 itself calls it genuinely
  hard. Revisit only once invitation attachments start carrying drawings.
- **Offline-first / PWA / service worker.** A5 aspiration, not v1. Server-rendered field page
  works on a phone with signal; basements come later.
- **SMS.** New vendor + A2P 10DLC registration + spend = owner decision. All notification in
  v1 rides the existing env-gated SMTP path.
- **Photo pins on drawings; chat/messaging** (WhatsApp exists and wins).
- **Per-user accounts/roles.** Tokenized links deliberately avoid an auth rebuild.
- **Pricing databases** (RSMeans etc.). Unit costs are the customer's own numbers, editable
  per sheet; "save as my defaults" is a backlog follow-up.
- **Digest/alert changes.** Nothing new enters any delivery without the publication gate —
  v1 touches the cockpit and the field surface only.
- **CO → invoice/billing.** Approval records the fact; money stays in the customer's tools.

---

## Step-by-Step Tasks

### Phase A — takeoff scaffold

### Task A1: migration 0038 + schema defs
- **ACTION**: Create `0038_takeoff_field.sql` and matching drizzle defs.
- **IMPLEMENT**:
  - `takeoff_sheets`: id, pursuit_id FK (UNIQUE — one live sheet per pursuit), account_profile_id FK,
    status `draft|final`, waste_pct double default 10, overhead_pct double default 0,
    margin_pct double default 0, derived_from_json jsonb (evidence snapshot + extraction hits),
    created_at, updated_at.
  - `takeoff_lines`: id, sheet_id FK, assembly_key text, description text, qty double,
    unit text, unit_cost double, source `derived|manual`, provenance text NULL (the matched
    evidence snippet — what makes a derived qty auditable), sort integer, created_at.
    Index (sheet_id, sort).
  - `field_links`: id, pursuit_id FK, account_profile_id FK, token_hash text UNIQUE,
    label text (who it was handed to), expires_at, revoked_at NULL, last_used_at NULL, created_at.
  - `field_entries`: id, pursuit_id FK, link_id FK NULL (NULL = cockpit-authored),
    entry_type `daily_log|change_order|note`, body text, quantities_json jsonb NULL
    ({boards, tapedLf, crewHours}), amount double NULL (CO only), submitted_name text NULL
    (typed signature), status `submitted|approved|rejected` default 'submitted',
    decided_at NULL, decided_by NULL, created_at. Index (pursuit_id, created_at).
- **MIRROR**: TABLE_DEFINITION; CHECK constraints inline like migration 0019 does for
  `action_tokens.action`.
- **GOTCHA**: additive only; never touch an applied migration (journal-timestamp no-op trap).
  Hosted apply is a separate close-out step — local first.
- **VALIDATE**: `pnpm db:migrate` clean on local; `pnpm typecheck` clean on `@otn/db`.

### Task A2: assembly catalog + extraction (`takeoff.ts`, part 1)
- **ACTION**: Deterministic evidence→lines derivation. No AI, no network.
- **IMPLEMENT**:
  - `TAKEOFF_ASSEMBLIES` const (CONSTANT_VOCABULARY pattern): ~10 entries
    `{ key, description, unit: 'sqft'|'lf'|'each'|'allowance', defaultUnitCost }` —
    hang+finish sqft, Level 5 skim sqft, metal stud framing LF, ACT grid sqft, insulation
    sqft, FR assembly sqft, paint walls/ceilings sqft, doors/frames each, scope allowance $.
    Default unit costs are placeholder-obvious (`0` is wrong — use round owner-editable
    figures and a comment: *estimates, customer's numbers win; never present as measured*).
  - Extraction over the SAME text scoring reads (`COALESCE(rec.text, lower(canonical_name))`,
    see `score-run.ts:83` — reproduce the join, do not refactor score-run):
    `/(\d[\d,]{2,})\s*(?:sq\.?\s?ft|sf|square feet)/`, unit counts, `\d+\s*(?:lf|linear feet)`,
    plus assembly triggers ADAPTED from `scoring.ts` RE (level5/fire-rated/STC/shaftwall/ACT).
  - Derivation rules: sqft found → hang/finish + paint lines at extracted qty ×(1+waste);
    assembly trigger → its line qty from sqft or `0` qty flagged "quantity unknown — set from
    walk"; nothing but valuation → single `allowance` line = valuation × trade-share
    (commercial TI 0.18, else 0.10 — the constants carry a `~` comment and surface in UI as
    estimates). Every derived line gets `provenance` = the matched snippet.
- **MIRROR**: SERVICE_FUNCTION; doc-comment style of `appliedFreshness` (`scoring.ts:425-446`)
  for the trade-share constants — state they are owner judgement, not measurement.
- **GOTCHA**: do NOT import from `scoring.ts` and do NOT edit it — `RE` is unexported and the
  eval gates are byte-frozen. Duplicate the 4 trigger regexes with a comment naming the
  source lines and accepting drift.
- **VALIDATE**: unit tests (A5 below) green.

### Task A3: sheet services (`takeoff.ts`, part 2)
- **ACTION**: `getOrCreateTakeoffSheet`, `rederiveSheet`, `upsertLine`, `deleteLine`,
  `sheetTotals`, `stampEstimate`.
- **IMPLEMENT**: get-or-create derives on first call. **Re-derive replaces `source='derived'`
  lines only — never touches `manual`** (the customer's edits are the product; a refresh that
  eats them is data loss). `sheetTotals` = Σ(qty×unit_cost) → +waste (qty-unit lines only) →
  +overhead → +margin → bid price. `stampEstimate` writes `pursuits.estimated_contract_value`
  and appends a pursuit note (`addPursuitNote`, visibility 'account') recording old→new —
  audit rides an existing surface.
- **MIRROR**: SERVICE_FUNCTION; `TakeoffError` with code union like `PursuitError`
  (`pursuit.ts:52-62`).
- **GOTCHA**: money as `double precision` matches `pursuits` money columns — do NOT introduce
  a decimal type mid-codebase.
- **VALIDATE**: `pnpm vitest run apps/worker/test/takeoff.test.ts`.

### Task A4: takeoff routes
- **ACTION**: The two route files under `pursuits/[id]/takeoff`.
- **IMPLEMENT**: GET → get-or-create + lines + totals; POST `{action:'rederive'}`;
  PATCH sheet meta (waste/overhead/margin/status) and `{action:'stamp-estimate'}`;
  lines route: POST manual line, PATCH `{lineId, qty?, unitCost?, description?}`,
  DELETE `{lineId}`. Every handler: ownership check first (ROUTE_HANDLER).
- **MIRROR**: ROUTE_HANDLER exactly; map `TakeoffError` codes → 400/404/409 the way
  transition route maps `PursuitError`.
- **VALIDATE**: `pnpm typecheck`; exercised by e2e in A7.

### Task A5: derivation + service unit tests
- **ACTION**: `apps/worker/test/takeoff.test.ts` (AAA, descriptive names).
- **IMPLEMENT**: sqft extraction (with commas, `sf`, absent); valuation-only → allowance with
  trade-share; assembly trigger without sqft → qty 0 + flag; waste/margin math to the cent;
  **re-derive preserves manual lines and replaces derived ones**; stampEstimate writes pursuit
  + note; unknown assembly key rejected.
- **MIRROR**: existing worker test files (vitest, local Docker DB — NOT hosted).
- **VALIDATE**: suite green.

### Task A6: worksheet UI
- **ACTION**: Takeoff card on pursuit detail + `/app/pursuits/[id]/takeoff` editor.
- **IMPLEMENT**: card: line count, derived/manual split, `~`-prefixed subtotal, Open + Stamp
  buttons (`data-testid="takeoff-card"`). Editor page: server loader (PAGE_LOADER, sequential
  awaits) + `sheet-editor.tsx` client component (mirror `PursuitActions` colocated-client
  pattern): editable qty/unit-cost cells, provenance tooltip/inline on derived lines, add-line
  with assembly select, totals footer, Re-derive with "manual lines are kept" copy, CSV
  download (client-side blob — no new route). Estimates carry `~` and the word "estimate" —
  deck discipline, non-negotiable.
- **MIRROR**: `lib/ui.js` helpers (`Badge, cell, fmtDate, fmtMoney, table`) — no new design
  system; inline-style tables like the existing pages.
- **GOTCHA**: pool max 2 — the editor page loads session → account → sheet strictly
  sequentially.
- **VALIDATE**: e2e A7; manual pass at `pnpm dev`.

### Task A7: e2e (new spec only) — **Phase A ship checkpoint**
- **ACTION**: `apps/web/e2e/field-takeoff.spec.ts` (takeoff describe-block).
- **IMPLEMENT**: login (existing helper pattern) → create pursuit via API on a seeded
  opportunity → GET takeoff (auto-derive) → PATCH a line qty → stamp estimate → assert
  pursuit shows the value; account-isolation: second account's session gets 404 on the same
  sheet (spec §17 discipline).
- **GOTCHA**: e2e DB is the seeded local corpus (`db:setup:e2e`); never edit the 4 existing
  specs.
- **VALIDATE**: `pnpm test:e2e` — existing baseline still green + new spec green. Then:
  full `pnpm test`, `pnpm typecheck`, `pnpm eval:run` byte-identical (no scoring files
  touched — prove it), commit.

### Phase B — field communication

### Task B1: link + entry services (`field.ts`)
- **ACTION**: `mintFieldLink` (returns raw token ONCE; stores SHA-256), `verifyFieldToken`
  (hash lookup; expired/revoked → typed reasons; bumps `last_used_at`), `revokeFieldLink`,
  `listFieldLinks`, `addFieldEntry` (validates entry_type vocabulary + quantities_json shape),
  `decideChangeOrder` (submitted→approved|rejected, stamps decided_by/at, appends pursuit
  note; approving is idempotent-guarded — deciding twice is a 409).
- **MIRROR**: token semantics of `@otn/delivery` peek/consume (`api/action/route.ts:9-15`)
  minus single-use; SERVICE_FUNCTION; `FieldError` code union.
- **GOTCHA**: default expiry 30 days; `verifyFieldToken` must be constant-shape on all
  failures (no oracle distinguishing "never existed" from "revoked" to the caller page —
  one "link unavailable" rendering, mirroring FAIL_PAGES tone).
- **VALIDATE**: `apps/worker/test/field.test.ts` (B5).

### Task B2: crew surface `/field/[token]`
- **ACTION**: Server page + entries POST route. **No `withAccount`** — token IS the auth;
  scope comes from the link row.
- **IMPLEMENT**: page (GET, SAFE): verify token → job brief (project name, address, state,
  bid due if invitation matched, owner phone from account) + last 5 entries + two forms
  (daily log: boards/tapedLf/crewHours/note; change order: description/amount/typed-name
  signature). Plain HTML forms POSTing to `/api/field/[token]/entries` — works on any phone,
  no client JS required. POST route: rate limiter (clone `api/action/route.ts:53-67`),
  verify → `addFieldEntry` → redirect back with `?ok=1`. `no-store, private` +
  `referrer-policy: no-referrer` headers; `robots` noindex meta; all output through `esc()`.
- **MIRROR**: TOKEN_SURFACE hardening checklist, item for item.
- **GOTCHA**: mail-gateway prefetch rule — GET renders only, never writes (not even
  `last_used_at`? It may: a timestamp bump is not a state mutation the prefetch can abuse;
  keep the bump in POST only anyway to stay strictly safe).
- **VALIDATE**: e2e B6; manual phone-width pass.

### Task B3: cockpit field management
- **ACTION**: Field section on pursuit detail + `field-links` / `decision` routes.
- **IMPLEMENT**: links list (label, created, expiry, revoked badge, Revoke button); mint form
  (label input) — the ONE response that ever contains the raw URL, rendered with copy
  affordance and "shown once" copy; entries timeline (logs with quantities, COs with amount +
  Approve/Reject when `submitted`); weekly rollup line (Σ boards/LF/hours this week).
  `data-testid="field-section"`, `field-link-mint`, `co-decision-{approve|reject}`.
- **MIRROR**: ROUTE_HANDLER; `PursuitActions` client-component pattern for the buttons.
- **VALIDATE**: e2e B6.

### Task B4: owner notification on CO submission
- **ACTION**: When a `change_order` entry lands, email the account owner.
- **IMPLEMENT**: in the entries POST route after `addFieldEntry`: fire-and-forget send via a
  small `sendFieldNotification` in `packages/delivery` reusing the deliver.ts transport block
  (`deliver.ts:156-162` env vars; recipient default `${accountKey}@pilot.otn.local` like
  `deliver.ts:54`). Subject `[OTN] Change order on {project}` + cockpit deep link. Record a
  `deliveries` row (`delivery_type: 'field_notify'`, idempotency key `co-{entryId}`) so
  re-submits don't double-send — the deliver.ts draft/sent shape, minus digest rendering.
- **GOTCHA**: SMTP is env-gated (dev default localhost:1025) — the send failing must NOT fail
  the crew's POST: catch, log via the route's `console.error` guard convention, entry stands.
- **VALIDATE**: unit-test idempotency key path; manual with mailpit if configured.

### Task B5: field unit tests
- **ACTION**: `apps/worker/test/field.test.ts`.
- **IMPLEMENT**: mint→verify roundtrip (raw token verifies; stored hash ≠ raw); expiry;
  revocation; wrong-account isolation on entry add; CO decide idempotency (second decide →
  409); quantities_json validation (negative boards rejected); daily rollup sums.
- **VALIDATE**: suite green.

### Task B6: variance rollup (the A6 loop) + close-out
- **ACTION**: On the takeoff sheet page, when field daily logs exist: "logged to date" beside
  estimated qty for the hang/finish line (boards×32 sqft ≈ logged sqft, constant commented as
  `~`, 4×8 board assumption) and crew-hours total. Graceful when either side is absent.
- **THEN**: full `pnpm test`, `pnpm test:e2e`, `pnpm typecheck`, `pnpm eval:run`
  (byte-identical), migration applied to hosted (existing hosted-apply step from prior
  phases), `docs/STATUS.md` row, plan history entry, archive plan, commit + push.

### Task B7 (OPTIONAL — may ship without): photo attachment on field entries
- **ACTION**: photo on CO/log entries. Quarantined because storage is the one new infra
  decision: Supabase Storage bucket (private, size-capped, images only, signed URLs) vs
  DB bytea (pooler-hostile at MB sizes — rejected). If built: bucket `field-photos`,
  upload via the entries POST as multipart, `photo_path` column already NULL-able by design.
- **GOTCHA**: strip EXIF GPS on ingest or accept location capture explicitly — decide with
  the owner before building. This is the only task with a genuinely open decision; do not
  let it block B1–B6.

---

## Testing Strategy

### Unit Tests (vitest, local Docker DB)

| Test | Input | Expected | Edge |
|---|---|---|---|
| sqft extraction | "…4,200 sq ft TI…" | hang/finish qty 4200×1.1 | commas, `sf`, absent |
| valuation-only fallback | valuation 500k commercial TI | allowance line ~90k, `~` provenance | share constants labelled |
| re-derive preserves manual | 1 manual + 2 derived, rederive | manual untouched, derived replaced | ✔ core semantic |
| stamp estimate | sheet total 48,200 | pursuit value + audit note | old→new in note |
| token roundtrip | mint→verify | ok; DB holds hash only | expired/revoked reasons |
| CO decide | approve then approve | 409 second time | idempotency |
| isolation | account B reads A's sheet/entry | not found | spec §17 |

### Edge Cases Checklist
- [x] Empty evidence text (allowance-only sheet, no crash)
- [x] Concurrent get-or-create (UNIQUE(pursuit_id) — second insert falls back to select, deliver.ts:112-118 race pattern)
- [x] Revoked link mid-shift (POST fails closed, one neutral message)
- [x] Negative/absurd quantities rejected at service boundary
- [x] SMTP down (crew POST still succeeds)

## Validation Commands

```bash
pnpm typecheck
```
EXPECT: zero errors, all packages.
```bash
pnpm test
```
EXPECT: full suite green (baseline 1101+ before this work; grows).
```bash
pnpm test:e2e
```
EXPECT: existing specs untouched and green; `field-takeoff.spec.ts` green.
```bash
pnpm eval:run
```
EXPECT: **byte-identical gates** (precision 1.0, recall 0.9609, Solis 22/22) — this plan
touches no scoring path; a moved gate means a mistake, stop and find it.
```bash
pnpm db:migrate
```
EXPECT: 0038 applies clean locally; hosted apply only at B6 close-out.

### Manual
- [ ] Phone-width pass of `/field/{token}`: brief readable, both forms submit, `?ok=1` lands
- [ ] Mint → copy URL → open in private window (no session) → submit log → entry visible in cockpit
- [ ] Revoke → same URL now "link unavailable"
- [ ] Takeoff: derive on real Solis pursuit, edit qty, stamp, CSV opens in Excel

## Acceptance Criteria
- [ ] Phase A shippable alone (A7 checkpoint passes with zero Phase B code)
- [ ] All validation commands pass; eval byte-identical
- [ ] Derived lines carry provenance; every estimate rendered with `~`
- [ ] Raw tokens appear exactly once (mint response) and never in the DB
- [ ] Existing e2e specs unmodified

## Completion Checklist
- [ ] New code indistinguishable from `pursuit.ts` / notes-route style
- [ ] No `Promise.all` in any page loader
- [ ] No scoring.ts / eval-path edits
- [ ] `docs/STATUS.md` + plan history updated; plan archived to `completed/`

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Derived quantities read as authoritative and misprice a bid | Medium | **High — customer money** | `~` labels, provenance on every derived line, allowance-only fallback never fabricates quantities, "estimate" in UI copy |
| Field link leaks (forwarded text) | Medium | Medium | expiry + revoke + last-used visibility; read surface exposes no contact PII beyond the brief; noindex; rate limiter |
| Re-derive eats customer edits | Low (tested) | High | source=manual invariant + dedicated test |
| SMTP gate makes B4 look broken | High (env) | Low | send failure swallowed + logged; deliveries row records intent; STATUS notes env dependency |
| Trade-share constants wrong | Certain (they're guesses) | Medium | labelled owner-judgement in code + UI, calibration follow-up listed for next Solis session |
| Scope creep toward A5's full vision (offline, pins, SMS) | Medium | Medium | NOT-building list is explicit; each has a named re-entry condition |

## Notes

- Mandate source: deck A5/A6 (shown to Solis 2026-07-26 as "concepts only — tell us whether
  either is worth more to you than more leads"). This plan is the buildable v1 of each; the
  session's answer to that question should gate *when* B ships, not whether the code is ready.
- `pursuit_notes.visibility` already defaults `'account'` — field-authored notes use
  `'field'`, no schema change needed there.
- Next Solis calibration should add: unit-cost confirmation for the assembly catalog and the
  trade-share constants (they are owner guesses in the `owner_assumed` tradition — keep them
  out of `account-profiles.yaml` until confirmed).

## Plan history

**2026-07-27 — v1.** Written after reading the pursuit CRM, action-token, delivery, documents,
and e2e surfaces end to end. Two prior assumptions died during exploration: (1) "notes/tasks
will need building" — both exist with routes; (2) "photos can ride raw_artifacts" — that table
is source-scoped by construction, so photo storage became the quarantined optional task
instead of a load-bearing dependency.
