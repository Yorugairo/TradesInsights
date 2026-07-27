# Plan: WEBS + OMWBE Solicitation Ingestion

## Summary

Add two pre-award solicitation sources to the fleet: OMWBE's bid-opportunities listing
(the public window into otherwise-private GC sub-bid boards) and the WEBS public bid
calendar (statewide agency solicitations). Both mirror the already-shipped
`tacoma_solicitations` adapter. The domain model already supports solicitations —
`bidding_confirmed` is a project stage and `solicitation_published` / `bid_addendum` /
`bid_deadline_changed` / `award_published` are event types — so this is adapter work, not
architecture, with **two schema blockers that must be resolved first**.

## User Story

As a trades contractor, I want to see public solicitations and GC sub-bid requests
alongside permit signals, so that I catch work at the bid stage rather than inferring it
from a permit and arriving after the bid list has closed.

## Problem → Solution

Permits tell you someone is *about to build*; you infer bidding. Solicitations say a bid
is **open now, closing on a date**. OMWBE additionally carries "SUB-BIDS REQUESTED for
GC/CM Project" posts from primes like Skanska and Lease Crutcher Lewis — sub-bid demand
that is otherwise locked inside BuildingConnected invitation lists.

## Metadata

- **Complexity**: Medium (OMWBE) + Large (WEBS) — recommend splitting; see Scope
- **Source PRD**: N/A — from the 2026-07-27 competitive brief on WA bid channels
- **Estimated Files**: ~8 (2 adapters + 2 tests + config + taxonomy + index + docs)

---

## Recommended sequencing — this inverts the brief

The competitive brief ranked WEBS first. **Investigation reverses that.** Build OMWBE
first:

| | OMWBE | WEBS |
|---|---|---|
| Transport | Drupal listing, `/bid-opportunities/<slug>` detail pages | **ASP.NET `__doPostBack` + ViewState grid** |
| Paging | standard listing pagination | `javascript:__doPostBack(...)` — no GET params |
| Effort | comparable to `tacoma_solicitations` | materially higher — session/ViewState handling |
| Uniqueness | **GC sub-bid requests — not indexed by BXWA/PlanHub** | also aggregated by every competitor |
| Data quality | free text, "submitted by third parties … as a courtesy" | structured grid columns |

OMWBE is cheaper *and* carries the differentiated signal. WEBS is the better-structured
data but is the commodity everyone already has, and is the harder scrape.

---

## BLOCKERS — resolve in Task 0 before writing either adapter

### B1. `county` is required and enum-constrained

`NormalizedSourceRecordSchema` (`packages/domain/src/normalized-record.ts:34`) declares
`county: CountySchema` — **not nullable**. `tacoma_solicitations` gets away with a
hardcoded `county: "Pierce"` because it is one city. WEBS is statewide and OMWBE posts
span the state, including counties likely absent from `CountySchema`.

Options, in preference order:

1. **Derive from the procuring agency / project location** where the listing states one,
   and **skip records where it cannot be determined**. Preserves the invariant, loses
   coverage, and the loss is measurable (log the skip count).
2. Widen `NormalizedSourceRecord.county` to `CountySchema.nullable()`. Touches the shared
   record type consumed by all 36 sources — every downstream consumer that assumes a
   non-null county must be audited first.

Do **not** invent a county. The record type's own comments repeat "never fabricated" /
"never guessed" as a governing rule.

**Task 0 must first read `CountySchema` and enumerate which WA counties it accepts.**

### B2. There is no first-class bid-due-date field

This is the field a solicitation exists for, and the schema has nowhere to put it.
`tacoma_solicitations` stashes it three ways
(`packages/adapters/src/tacoma-solicitations.ts:91-129`):

```ts
description: `${type} due ${dueDate} ${timeDue} Pacific. Category: ...`,
statusRaw: `open (due ${dueDate})`,
rawFields: { specNumber, type, dueDate, timeDue, titleCell, dateIssued, category },
```

Consequences: the deadline cannot be filtered, sorted, or indexed; and although
`bid_deadline_changed` exists in `EVENT_TYPES` (`packages/domain/src/taxonomy.ts:36`),
**there is no typed field to diff, so that event can never fire.**

**Recommendation**: add `bidDueDate: IsoDateString.nullable()` as an *optional additive*
field. Additive-nullable means no existing adapter breaks — the same widening pattern the
record type already used for `phone` / `ubi` / `contractorLicense` / `address`. Deferring
this means shipping two sources whose primary value is trapped in `rawFields`.

If the owner prefers consistency with the shipped convention, note it explicitly as debt
and keep `bid_deadline_changed` unimplemented rather than faking it.

---

## Mandatory Reading

| Priority | File | Why |
|---|---|---|
| P0 | `packages/adapters/src/tacoma-solicitations.ts` (all) | **The pattern to mirror.** Already-shipped solicitation adapter |
| P0 | `packages/domain/src/normalized-record.ts:26-75` | Record contract; B1 and B2 live here |
| P0 | `packages/domain/src/taxonomy.ts:1-50` | `bidding_confirmed`, `solicitation_published`, `bid_addendum` already exist |
| P0 | `config/sources.yaml:445-466` | The `tacoma_solicitations` entry — copy its shape and its `notes` discipline |
| P1 | `packages/config/src/sources-config.ts:1-70` | `SourceConfigSchema`, `access_class`, `terms_reviewed_at`, `required_fields` |
| P1 | `packages/adapters/src/king-public-notices.ts:110-150` | Second non-permit example (`recordType: "public_notice"`, `normalizedStage: "unknown"`) |
| P1 | `packages/source-sdk/src/types.ts:30-82` | `SourceAdapter`, `ParsedSourceRecord`, `RunContext`, checkpointing |
| P2 | `packages/adapters/src/tacoma-solicitations.test.ts` | Test shape for a solicitation adapter |
| P2 | `packages/source-sdk/src/invariants.ts` | The drift-detection contract used below |

## External findings (2026-07-27)

| Target | Finding |
|---|---|
| WEBS bid calendar | `https://pr-webs-vendor.des.wa.gov/BidCalendar.aspx` — **public, no login**. Columns: Close Date, Title (linked), Reference Number, Contact, Amendment Date, Pre-Bid Conference, Inclusion Plan Y/N, Additional Data. ASP.NET ViewState; paging via `__doPostBack` |
| WEBS awarded contracts | **Login required** — out of scope |
| OMWBE index | `https://omwbe.wa.gov/about-omwbe/omwbe-bid-opportunities` and `/small-business-assistance/bids-contracting-opportunities`; details at `/bid-opportunities/<slug>` |
| OMWBE content | Includes "SUB-BIDS REQUESTED for GC/CM Project: …" and prime-contractor outreach posts. Self-described as third-party submissions "listed as a courtesy" — expect inconsistent formatting |
| Bonfire (Phase 3 note) | DES public works uses `deswa.bonfirehub.com`; MRSC Rosters also runs a Bonfire portal. **A shared substrate across WA public works** — one adapter pattern may cover several agencies. Not in this plan's scope |

---

## The precedent is live, not theoretical

`tacoma_solicitations` is not just committed — it is **enabled and producing in
production**: 2 runs, 2 succeeded, 0 errors, 15 records parsed, first run 2026-07-21.
This plan clones a working source, not a design.

Its low run count (2 in 6 days) is the fleet-wide scheduling gap documented in
`source-fleet-flow-verification.plan.md`, not a defect in the adapter.

**Sequencing dependency**: until that plan lands a scheduler, WEBS and OMWBE will be
manual-run sources like every other. Build them whenever, but expect no cadence until
the scheduler exists.

---

## Source entries to add — `config/sources.yaml`

Append both. **Ship `enabled: false`** per the verify-before-enable invariant
(`packages/config/src/sources-config.ts:37-39`); Task 2 fills the two review dates and
Task 7 flips the flag.

```yaml
  - key: omwbe_bid_opportunities
    name: OMWBE Bid Opportunities (agency solicitations + prime sub-bid requests)
    authority: WA Office of Minority and Women's Business Enterprises
    priority: P1
    landing_url: https://omwbe.wa.gov/about-omwbe/omwbe-bid-opportunities
    access_url: https://omwbe.wa.gov/about-omwbe/omwbe-bid-opportunities
    format: html
    access_class: html
    cadence: daily
    # Statewide — county is resolved per listing, not fixed. See blocker B1.
    county: null
    # Procuring agency (or prime contractor) varies per listing; set on the record.
    permitting_jurisdiction: null
    enabled: false
    terms_reviewed_at: null
    robots_reviewed_at: null
    required_fields: []
    notes: >-
      NOT YET VERIFIED — robots.txt and terms review pending (Task 2). Drupal listing
      with detail pages at /bid-opportunities/<slug>. Carries two distinct classes:
      agency solicitations, and "SUB-BIDS REQUESTED" posts from prime contractors
      (Skanska, Lease Crutcher Lewis) driven by MWBE/apprenticeship outreach
      obligations on WA public works. The sub-bid class is the differentiated signal:
      it is the only public window into GC bid boards that otherwise live behind
      BuildingConnected invitation lists, and no competing aggregator indexes it.
      OMWBE states these are third-party submissions listed as a courtesy, so expect
      inconsistent formatting and parse defensively.

  - key: webs_bid_calendar
    name: WEBS Public Bid Calendar (statewide agency solicitations)
    authority: WA Department of Enterprise Services
    priority: P1
    landing_url: https://des.wa.gov/sell/bid-opportunities
    access_url: https://pr-webs-vendor.des.wa.gov/BidCalendar.aspx
    format: html
    access_class: html
    cadence: daily
    county: null
    permitting_jurisdiction: null
    enabled: false
    terms_reviewed_at: null
    robots_reviewed_at: null
    required_fields: []
    notes: >-
      NOT YET VERIFIED — robots.txt and terms review pending (Task 2). Public, no
      login required; awarded contracts DO require login and are out of scope.
      ASP.NET grid: paging via __doPostBack with ViewState, not GET params, so the
      adapter must round-trip __VIEWSTATE / __VIEWSTATEGENERATOR / __EVENTVALIDATION.
      Columns: Close Date, Title (linked), Reference Number, Contact, Amendment Date,
      Pre-Bid Conference, Inclusion Plan Y/N, Additional Data. A stale ViewState
      yields an error page that parses as ZERO ROWS — a minimum-row-count invariant
      is mandatory, not optional.
```

`county: null` and `permitting_jurisdiction: null` are legal at config level
(`SourceConfigSchema` declares both `.nullable().default(null)`) but the **record** type
requires a non-null county — that asymmetry is blocker B1 and must be resolved in Task 0
before either adapter is written.

---

## Patterns to Mirror

### SOLICITATION_RECORD_MAPPING
```ts
// SOURCE: packages/adapters/src/tacoma-solicitations.ts:91-107
recordType: "solicitation",
description: `${type} due ${dueDate} ${timeDue} Pacific. Category: ...`,
permittingJurisdiction: "City of Tacoma",
county: "Pierce",
documentType: "solicitation",
statusRaw: `open (due ${dueDate})`,
normalizedStage: "bidding_confirmed",
applicationDate: usDate(dateIssued),
issueDate: null,
```
`permittingJurisdiction` is repurposed as **procuring agency** for solicitations. Keep
that reading consistent. `issueDate` stays null — a solicitation is not an issued permit.

### DRIFT_INVARIANT — required, not optional
```ts
// SOURCE: packages/adapters/src/tacoma-solicitations.ts:141-153
// If the columns reorder, the due-date column stops holding a date;
// a clean parse never trips this.
const rf = p.rawFields as { dueDate?: string };
if (rf.dueDate && !/\d{2}\/\d{2}\/\d{4}/.test(rf.dueDate)) {
  // → InvariantViolation: "column drift"
}
```
Every HTML-table adapter must assert that a column still holds the shape it claims.
Silent column reordering is the failure mode this fleet has already been bitten by.

### CONFIG_ENTRY
```yaml
# SOURCE: config/sources.yaml:445-458
- key: tacoma_solicitations
  access_class: html
  cadence: daily
  enabled: true
  terms_reviewed_at: "2026-07-17"
  robots_reviewed_at: "2026-07-17"
  notes: >-
    Verified 2026-07-17: tacoma.gov robots.txt allows all; ...
```
**A source ships `enabled: false`** and is enabled only after the §5 activation checklist
passes (stated invariant at `packages/config/src/sources-config.ts:37-39`). The `notes`
block records the robots/terms verification in prose — match that discipline.

---

## Files to Change

| File | Action | Why |
|---|---|---|
| `packages/domain/src/normalized-record.ts` | UPDATE | B2: optional `bidDueDate` (pending owner call) |
| `packages/adapters/src/omwbe-bid-opportunities.ts` | CREATE | Adapter 1 |
| `packages/adapters/src/omwbe-bid-opportunities.test.ts` | CREATE | Fixture-driven parse test |
| `packages/adapters/src/webs-bid-calendar.ts` | CREATE | Adapter 2 (phase 2) |
| `packages/adapters/src/webs-bid-calendar.test.ts` | CREATE | Fixture-driven parse test |
| `packages/adapters/src/index.ts` | UPDATE | Register both |
| `config/sources.yaml` | UPDATE | Two entries, `enabled: false` |
| `docs/STATUS.md`, `docs/architecture.md` | UPDATE | Record the new record class + any schema divergence |

## NOT Building

- **No BXWA or Plan Center NW ingestion.** Private subscription plan rooms; scraping
  breaches ToS and free-rides a competitor whose members are our prospects.
- **No WEBS authenticated area.** Awarded contracts need login — out of scope.
- **No Bonfire adapter** (`deswa.bonfirehub.com`, MRSC Rosters portal). Noted as the
  likely next-highest-leverage source; deliberately deferred.
- **No changes to the v1.12.0 timing model.** Owner-directed and deliberate
  (`docs/domain-bid-timing.md`). Solicitations run on a different clock and must sit
  *alongside* it, not inside it.
- **No MRSC Rosters ingestion.** That is a registration action for the business, not a feed.
- **No scoring changes.** Getting records in is this plan; how they score is a separate one.

---

## Step-by-Step Tasks

### Task 0: Resolve the two blockers (do this first — it gates everything)
- **ACTION**: Read `CountySchema` and enumerate accepted counties. Decide B1 (derive-and-skip
  vs. nullable) and B2 (`bidDueDate` vs. documented debt).
- **VALIDATE**: Both decisions written into this plan's Notes before Task 1 starts. If B1
  option 2 is chosen, first grep every consumer of `.county` and list them here.

### Task 1: Capture fixtures
- **ACTION**: Save one real OMWBE listing page + 2–3 detail pages, and one WEBS
  `BidCalendar.aspx` response, as test fixtures.
- **GOTCHA**: Fixtures are the only defence against ASP.NET markup churn. Capture the raw
  bytes, not a cleaned copy.
- **VALIDATE**: Fixtures committed; tests parse them offline with no network.

### Task 2: Robots + terms review
- **ACTION**: Fetch and record `robots.txt` for `omwbe.wa.gov` and
  `pr-webs-vendor.des.wa.gov`; read each site's terms of use.
- **MIRROR**: `CONFIG_ENTRY` — write the finding into `notes` verbatim, with the date.
- **GOTCHA**: Both are `wa.gov` state sites, which is favourable but **not** an assumption
  to ship on. `tacoma_solicitations` recorded an explicit robots check; do the same.
- **VALIDATE**: `terms_reviewed_at` and `robots_reviewed_at` populated with real dates.
  If robots disallows, **stop and report** — do not proceed.

### Task 3: OMWBE adapter
- **ACTION**: Implement `discover` (paginate the listing) → `fetch` → `parse` (detail pages).
- **IMPLEMENT**: `recordType: "solicitation"`; distinguish GC sub-bid posts from agency
  solicitations via a `documentType` of `"sub_bid_request"` vs `"solicitation"` — the
  sub-bid class is the differentiated signal and must be queryable.
- **MIRROR**: `SOLICITATION_RECORD_MAPPING`.
- **GOTCHA**: Listings are third-party submissions with inconsistent formatting. Parse
  defensively; prefer emitting a record with nulls over guessing. Extract the prime
  contractor into `organizations[]` with `role: "prime"` and real `evidenceText`.
- **VALIDATE**: Test parses fixtures; asserts a known title, agency, and due date.

### Task 4: OMWBE drift invariant
- **ACTION**: Assert the due-date field still parses as a date; assert the listing yielded
  a plausible row count.
- **MIRROR**: `DRIFT_INVARIANT`.
- **VALIDATE**: A deliberately corrupted fixture trips the invariant in a test.

### Task 5: WEBS adapter (phase 2 — separate PR)
- **ACTION**: Implement ViewState-aware paging: GET the form, extract `__VIEWSTATE`,
  `__VIEWSTATEGENERATOR`, `__EVENTVALIDATION`, then POST per page.
- **GOTCHA**: This is the hard part and the reason WEBS is sequenced second. ViewState is
  opaque and server-validated; a stale token yields an error page that **parses as
  zero rows** — indistinguishable from "no solicitations today" unless asserted against.
  Add an invariant on minimum row count per run.
- **GOTCHA**: Respect `packages/source-sdk/src/fetch-policy.ts` for rate limiting; do not
  hand-roll delays.
- **VALIDATE**: Offline fixture test for parse; one live smoke run via
  `pnpm source:run` against the disabled source.

### Task 6: Register, configure, document
- **ACTION**: Export from `packages/adapters/src/index.ts`; add both `config/sources.yaml`
  entries with `enabled: false`; set `required_fields` to only what each source verifiably
  emits; update `docs/STATUS.md` and `docs/architecture.md`.
- **GOTCHA**: `required_fields` drives a health floor check — a wrong entry causes false
  red alerts (`sources-config.ts` comment). Declare only fields observed in real output.
- **VALIDATE**: `pnpm typecheck` clean; `packages/config/src/loader.test.ts` updated and passing.

### Task 7: Activation
- **ACTION**: Run each source disabled, inspect real output, then flip `enabled: true`
  with a ledger entry — the same path `tacoma_solicitations` took on 2026-07-17.
- **VALIDATE**: A real run produces records; health is green; counts are recorded.

---

## Testing Strategy

| Test | Input | Expected |
|---|---|---|
| OMWBE parses a listing page | fixture | N records, known titles |
| OMWBE sub-bid classification | GC/CM fixture | `documentType: "sub_bid_request"`, prime in `organizations[]` |
| OMWBE missing due date | fixture with blank date | record emitted with null date, not skipped, no throw |
| OMWBE column drift | corrupted fixture | `InvariantViolation` raised |
| WEBS parses grid | fixture | rows with reference number + close date |
| WEBS empty/error page | error fixture | invariant trips — **not** silently zero rows |
| County undeterminable | fixture with no location | record skipped and counted, never fabricated |

### Edge cases
- [ ] Solicitation with a county outside `CountySchema`
- [ ] Statewide solicitation with no county at all
- [ ] Amended solicitation (due date changed) seen twice — dedupe on `externalId`
- [ ] Closed/expired listing still on the page
- [ ] OMWBE listing that is a *goods* RFQ, not construction — should it be filtered?

## Validation Commands

```bash
pnpm typecheck
```
EXPECT: zero errors, all 9 packages

```bash
pnpm --filter @otn/adapters test
```
EXPECT: all green, new tests included

```bash
pnpm lint
```
EXPECT: 0 errors (baseline is clean as of 2026-07-27)

```bash
pnpm source:run --source omwbe_bid_opportunities --dry-run
```
EXPECT: records parsed, nothing written while disabled

---

## Acceptance Criteria
- [ ] B1 and B2 decided and recorded before any adapter code
- [ ] Both sources ship `enabled: false` with real `terms_reviewed_at` / `robots_reviewed_at`
- [ ] OMWBE distinguishes sub-bid requests from agency solicitations
- [ ] Every adapter has a drift invariant that a corrupted fixture trips
- [ ] No county is ever fabricated; skips are counted and logged
- [ ] `bid_deadline_changed` is either implementable (B2 accepted) or explicitly logged as debt
- [ ] v1.12.0 timing model untouched

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| WEBS ViewState error page parses as zero rows | **High** | **High** | Minimum-row-count invariant; this is the "orphaned runs read GREEN" failure class again |
| `county` non-null blocks statewide records | **High** | High | Task 0 decides before code |
| OMWBE free-text defeats reliable parsing | Medium | Medium | Parse defensively, emit nulls, measure fill rate before enabling |
| ASP.NET markup churn breaks WEBS silently | Medium | High | Fixtures + invariants + health floor |
| Adding `bidDueDate` ripples through 36 sources | Low | Medium | Additive **nullable** only — mirrors the `phone`/`ubi` precedent |
| Solicitations dilute the permit-stage moat | Medium | Medium | Product question, not technical: keep the record class distinct and measure engagement separately |

## Notes

- **The domain model was built for this.** `bidding_confirmed`, `solicitation_published`,
  `bid_addendum`, `bid_deadline_changed`, `award_published` all pre-exist in
  `taxonomy.ts`, and `tacoma_solicitations` is live. This is the second and third
  instance of an established class, not a new capability.
- `config/sources.yaml:465` records that a published public solicitation is *"the only
  PUBLIC signal permitted to set `bidding_confirmed`"*. Both new sources qualify — read
  that note in full before setting the stage.
- **Strategic caveat worth re-stating**: WEBS data is also aggregated by BXWA, Plan Center
  NW, PlanHub and ConstructConnect. OMWBE sub-bid posts are not. If only one gets built,
  build OMWBE.
