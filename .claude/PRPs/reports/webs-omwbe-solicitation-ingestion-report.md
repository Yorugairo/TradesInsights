# Implementation Report: WEBS + OMWBE Solicitation Ingestion

Executed 2026-07-27. **Phases 0, 1 and 2 complete. Phase 3 deliberately not done —
measured reason below.**

| Phase | Status |
|---|---|
| 0 — second record class, union, table, persist branch | Complete |
| 1 — OMWBE adapter | Complete, `enabled: false` pending activation |
| 2 — WEBS adapter | Complete, `enabled: false` pending activation |
| 3 — port `tacoma_solicitations` | **Deferred on evidence** — would take `bidding_confirmed` to zero |

Validation: `pnpm typecheck` clean (11 packages), `pnpm lint` 0 errors,
**600/600 tests green** (288 packages + 312 worker), including 23 new adapter tests.

---

## Phase 0 — the second record class

Landed as designed, with one deviation and one schema change forced by evidence.

### Deviation: the union sits at the adapter boundary, not inside `ParsedSourceRecord`

The plan said to rewrite `ParsedSourceRecord` into
`{kind:"permit";…} | {kind:"solicitation";…}` and gave the falsification test:
*"If this change requires editing existing adapters, the union is wrong — redo it."*

**It fires.** Existing adapters read permit-specific fields off `p.record` inside
their own `checkInvariants`: `valuationUsd` (centralia), `units` /
`applicationDate` / `issueDate` (king), `organizations` (pierce_pals). Every one
becomes a type error the moment `p.record` can also be a solicitation.

So `ParsedSourceRecord` keeps its meaning (permit), `ParsedSolicitationRecord` is
new, and `ParsedRecord = ParsedSourceRecord | ParsedSolicitationRecord` is used
only in the two `SourceAdapter` method signatures. A `parse()` returning
`ParsedSourceRecord[]` is assignable to one returning `ParsedRecord[]` (covariant
return), and a `checkInvariants` declared with the narrower parameter still
satisfies the interface (TypeScript method parameters are bivariant;
`strictFunctionTypes` exempts method syntax). Existing adapters keep their narrow
types internally.

**Acceptance criterion met: typecheck clean with zero edits to any of the 36 adapters.**

### Schema change on evidence: `procuringAgency` is nullable

The plan assumed WEBS would supply the procuring agency. It does not. The public
calendar publishes close date, title, reference number, contact person,
amendment date, description, pre-bid conference and inclusion plan — and not the
organization. That is on `Search_BidDetails.aspx`, which returns the vendor
**login** page (verified 2026-07-27, HTTP 200 with a password form).

A required field would have forced dropping every WEBS row or inventing an
agency. `procuringAgency` is nullable in the zod schema, the migration and the
Drizzle table, with the evidence recorded at each.

### The dedupe key deliberately inverts 0035

`(source_id, external_id)`, **without** `observed_at`. In `project_events`,
`observed_at` had to be in the key or 136 legitimate re-emits would have been
destroyed as duplicates — an event is append-only, so a second one is new
information. A solicitation is the opposite: a mutable row. An amended bid is the
**same** solicitation with a later deadline, and keying on `observed_at` would
write a new row every run. Amendment history belongs in `project_events`. Both
directions of the reasoning are in the migration so the next reader does not have
to re-derive which case they are in.

### Counters

`parsed` / `duplicate` / `rejected` all move for solicitations, proven by test.
Fill instrumentation is deliberately skipped for the class — every
`MONITORED_FILL_FIELD` is a permit field a solicitation structurally lacks, so
including them would drive each fill rate toward zero and trip the
required-field health check on a healthy source.

---

## Phase 1 — OMWBE

### URL correction

The competitive brief named `/about-omwbe/omwbe-bid-opportunities` as the index.
**It is not.** That page is titled "Contracting with OMWBE" and covers the
agency's own procurement. The board is
`/small-business-assistance/bids-contracting-opportunities`, carrying **160 live
postings** on 2026-07-27.

### Robots + terms (Task 2)

`omwbe.wa.gov/robots.txt` is stock Drupal boilerplate — 36 `Disallow` rules, all
`/admin/`, `/user/`, `/misc/` and friends. Neither `/small-business-assistance/`
nor `/bid-opportunities/` is disallowed. It declares **`Crawl-delay: 10`**.

Rather than a hand-rolled `sleep`, `minIntervalMs` was added to the shared
`FetchPolicy` and enforced at the same choke point as `maxConcurrency`. A
per-adapter delay is invisible to the object that owns concurrency, so the two
can silently disagree; one place now decides how hard a host is hit.

### Shape

The board is a Drupal view: two columns, with the closing date in an RDFa
`content` attribute as a **real ISO datetime** — discovery needs no date parsing
and never reconstructs a two-digit year. Detail pages carry
`field-your-organization` (the agency, or the PRIME on a sub-bid post),
`field-closing-date`, `field-your-email-address` and a free-text body.

Discovery is **checkpointed on `slug → closing date`**, so after the first run
only new or amended postings are fetched — 160 × 10s is 27 minutes otherwise. The
per-run cap logs what it deferred; a cap that hides what it dropped reads as full
coverage.

### The differentiated signal is a column

`documentType: "sub_bid_request"` for prime sub-bid calls, classified from the
title only (an agency ITB routinely mentions subcontracting without being one).
Confirmed live on the board: RAM Construction, Skanska (×3 packages), plus
"Subcontractor Bid Invitation" and "STATEWIDE Subcontracting Opportunities"
posts. The prime also lands in `organizations[]` with `role: "prime"` and real
evidence text.

12 tests, including a corrupted fixture tripping each invariant.

---

## Phase 2 — WEBS

### The finding that would otherwise have shipped a silent bug

The plan anticipated ViewState handling. The actual blocker was different and
worse.

A postback carrying a **perfectly valid** `__VIEWSTATE` / `__VIEWSTATEGENERATOR`
/ `__EVENTVALIDATION` and **no `ASP.NET_SessionId` cookie** returns:

- HTTP **200**
- a full, well-formed grid
- **page one again** — the same 25 detail ids, no error, no redirect

Measured both ways on 2026-07-27: cookie-less, pages 2 and 3 returned page 1's
exact id set; with the cookie jar, both returned sets with **zero overlap**.

A scraper written without cookies would have looked completely healthy and
collected page 1 six times, reporting ~150 records of which 125 were duplicates.
Nothing about row count, HTTP status or schema validation catches it. Hence
`webs_page_repeat`, an explicit invariant, on top of the minimum-row-count
invariant for the expired-ViewState error page that parses as zero rows.

`FetchPolicy` gained POST support and a `setCookie` field on the response — kept
out of the `headers` map that is persisted to `raw_artifacts`, so a session token
never lands in the database.

### Parsing

Cells are addressed by ASP.NET **control-id suffix** (`span[id$='_Label1']`),
not position. The row is a nested five-row table whose cells shift whenever an
optional field (pre-bid conference, Q&A deadline) is absent, so positional
indexing silently mis-assigns fields on exactly the rows that differ. A test
asserts both the with- and without-conference populations parse correctly.

11 tests. 25 rows per page, 6 pages.

---

## Phase 3 — NOT DONE, and why

The plan scoped this "Small (port Tacoma)". It is not, because it has a
dependency Phase 0 explicitly deferred: **nothing yet links
`insights.solicitations` into the project graph.**

Measured in production 2026-07-27:

| | |
|---|---|
| `tacoma_solicitations` source records | 14 |
| …resolved into projects | 14 |
| `project_events` of type `solicitation_published` | 14 |
| **projects at `current_stage = 'bidding_confirmed'`** | **14** |

Every `bidding_confirmed` project in the system comes from this one adapter.
Porting it to the new record class today routes those records to
`insights.solicitations`, where no resolver reads them — taking the entire
`bidding_confirmed` stage to **zero**.

Task 9's own validation step names the missing piece: *"a linked solicitation
still moves its project to `bidding_confirmed`."* That is resolver work
(solicitation → project matching, `solicitation_published` emission, stage
transition), and Phase 0 deliberately put `project_id` outside the parser's reach
because a parser that set it would be guessing.

So the honest sequencing is: **build the solicitation → project linkage first,
then port Tacoma.** Doing the port now trades a working signal for a
half-finished migration. The 15-row backfill the plan worried about is the easy
part and is in fact automatic — the Tacoma pages are re-fetched daily, so
everything still listed re-emits into the new table on the first run after the
port.

Grep confirms the current state is coherent: `tacoma_solicitations` is the only
adapter emitting `recordType: "solicitation"` on a permit-shaped record, and
`config/sources.yaml` still records it as the only public signal permitted to set
`bidding_confirmed`.

---

---

## Live shadow runs (local DB, real network)

Both adapters were run end to end against the live sites with
`source:run --shadow`, writing to the **local** Postgres/MinIO — production's
schema is untouched, so nothing here required a prod migration.

### WEBS — green

```
discovered 6  fetched 6  parsed 131  rejected 0  duplicate 0  errors 0
invariantViolations 0   status succeeded   health green
webs: page walk complete — pages 6, pagerTargets 5, hadCookie true
```

Persisted shape, which is the point of the whole record class:

| rows | with deadline | with county | with agency | amended | distinct ids |
|---:|---:|---:|---:|---:|---:|
| 131 | **131** | **0** | **0** | 48 | 131 |

Every row has a typed `bid_due_at`. Zero have a county, and zero have an agency
— both correct, both impossible to represent in the permit record, and the
second is why `procuring_agency` had to become nullable. 48 rows carry an
amendment date and are stored as `status = 'amended'`.

### A real bug this run caught, and the migrator trap behind it

The first live run failed all six artifacts at the persist stage with a
`NOT NULL` violation on `procuring_agency` — the column the WEBS evidence had
just forced me to relax. The migration file was already correct; **the local
database was not**, because of how the drizzle migrator decides what to apply.

`drizzle-orm/node-postgres/migrator` reads the newest `created_at` in
`drizzle.__drizzle_migrations` and applies only migrations whose journal `when`
is **greater**. It does not compare per-file hashes. So editing a migration that
has already been applied is a **silent no-op** — the file says one thing and the
database keeps doing another, and every `IF NOT EXISTS` in the DDL makes the
re-run look successful. Recovering meant deleting the ledger row and re-running.

Production is unaffected: it sits at 35 migrations and has never seen 0036, so
it will apply the corrected version. But the trap is worth recording — it is the
same shape as the other silent-success failures this codebase keeps finding.

### Idempotency

A second WEBS run returned `unchanged 6, parsed 0` — the artifact hash
short-circuit fired, so the pages were not re-parsed at all. The
`duplicate`/amend paths are covered by
`apps/worker/test/solicitations.test.ts`, which varies the bytes deliberately to
reach them.

## Acceptance criteria

| Criterion | Status |
|---|---|
| `NormalizedSourceRecord` unmodified | Yes — no `bidDueDate`, no nullable county |
| Union lands with zero edits to the 36 existing adapters | Yes, verified by typecheck |
| A solicitation with `county: null` persists | Yes, round-trip test |
| `bidDueAt` typed, so `bid_deadline_changed` is implementable | Yes |
| `parsed_count` / `rejected_count` increment for solicitations | Yes, test |
| Both sources ship `enabled: false` with real review dates | Yes, 2026-07-27 |
| OMWBE distinguishes sub-bid requests | Yes, `document_type` column |
| Every adapter has a drift invariant a corrupted fixture trips | Yes, both |
| `tacoma_solicitations` ported, 15 rows backfilled | **No — deferred, see above** |
| A published solicitation still sets `bidding_confirmed` | Yes — unchanged, which is why the port waits |
| v1.12.0 timing model untouched | Yes |

## Follow-ups

1. **Solicitation → project resolver** (blocks Phase 3). Link a solicitation to a
   known project on real evidence, emit `solicitation_published`, set
   `bidding_confirmed` from the new table. Then port Tacoma.
2. **Activation runs** for both sources: run disabled, inspect output, flip
   `enabled: true` with a ledger entry — the path `tacoma_solicitations` took on
   2026-07-17. Note OMWBE's first run fetches up to 60 detail pages at a 10s
   crawl delay (~10 minutes).
3. **`bid_deadline_changed` / `award_published`** are now implementable and still
   unimplemented. WEBS exposes an amendment date (already mapped to
   `status: "amended"`); neither source publishes awards.
4. **Bonfire** (`deswa.bonfirehub.com`, MRSC Rosters) remains the noted
   next-highest-leverage source, still deliberately out of scope.
