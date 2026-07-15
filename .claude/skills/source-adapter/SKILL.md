---
name: source-adapter
description: Build, test, and activate an OTN Insights source adapter. Use when implementing any adapter in packages/adapters (Lacey, Lewis, Pierce, King, Seattle, Tumwater, Thurston, SEPA, procurement), adding a source to config/sources.yaml, capturing fixtures, or debugging a red/amber source.
---

# Building a source adapter

The full contract is `docs/BUILD_SPEC.md` §5–§6. Adapters write **source records and evidence only** — they must never create customer opportunities directly.

## Contract

```ts
export interface SourceAdapter {
  readonly key: string;
  discover(ctx: RunContext): Promise<DiscoveredArtifact[]>;
  fetch(item: DiscoveredArtifact, ctx: RunContext): Promise<RawArtifact>;
  parse(raw: RawArtifact, ctx: RunContext): Promise<ParsedSourceRecord[]>;
}
```

Every adapter must provide:

- Deterministic idempotency keys.
- Bounded concurrency, explicit user agent (`SOURCE_USER_AGENT`), timeouts, retry classification.
- Conditional requests (ETag/If-Modified-Since) when supported.
- **Immutable raw body/file storage before parsing** — never parse-then-store.
- Canonical URL, parent landing page, HTTP metadata, retrieved time, content type, byte size, SHA-256.
- Stable external record ID where available.
- Separate source-published, source-updated, first-seen, last-seen, retrieved times.
- Parser version and fixture version.
- Paginated/checkpointed backfill with an overlap window.
- Dead-letter state that can reproduce the failure.
- Metrics: discovered, fetched, unchanged, parsed, rejected, duplicate, error counts.

Parsers emit the Zod-validated `NormalizedSourceRecord` (spec §8). Unknown values are `null` — never guessed, never zero. Every record retains `county` and `permittingJurisdiction`.

## Activation checklist (do all 9, in order)

1. Verify official publisher and landing page (live, today — not from training data).
2. Record current access URL/format/cadence in `config/sources.yaml`.
3. Review robots.txt, terms, authentication, and a reasonable rate.
4. Capture representative raw fixtures into `fixtures/<source-key>/`.
5. Define mandatory and optional fields.
6. Implement parser + failure fixtures.
7. Manually compare a sample against the published source; record the comparison in fixture metadata.
8. Run in shadow mode.
9. Enable only after parser and health tests pass.

Discovery preference (use the highest available): documented API/JSON/CSV → downloadable report → static HTML → authorized email → permitted dynamic lookup → headless browser (last resort, approved sources only).

## Hard rules

- Never bypass authentication, CAPTCHA, MFA, paywalls, or access controls; never scrape customer credentials.
- Socrata (Seattle): inspect live columns first; bounded `$limit` + deterministic `$order`; filter on a stable time field; persist a high-water mark with overlap; no unbounded queries.
- Lookup-class sources (PALS, MyBuildingPermit, Laserfiche, property search) enrich known records only — never the sole alert source.
- Do not guess hostnames (e.g., Lewis SmartGov) — discover from the official county page.
- Watch migration canaries (e.g., Thurston's new permitting system announced for Sept 2026; `lewis_source_canary`, `seattle_source_canary`).

## Test gates (spec §19, all required before enabling)

- Landing-page and artifact fixtures; golden normalized output.
- Wrapped/missing/malformed/schema-change fixtures.
- Idempotent rerun and unchanged-hash tests.
- Pagination/checkpoint/backfill tests.
- Retry/rate-limit/dead-letter tests.
- Manual row/count comparison recorded in fixture metadata.

Known golden fixtures: Lewis issued-permits PDF of 2026-06-28 (test wrapped rows and applicant vs. primary-contractor separation); Pierce PALS 1032039 (Fredrickson Townhomes) and 1049051 (Trailside Apartments) HTML. Fixture facts prove parsing only — live status must be rechecked.

## Health

Track last attempt/success/new-record, counts, error classes, required-field null rate, schema fingerprint, parser version, publication delay, landing-page/canary health. Red = two consecutive failures, stale > 2× cadence, required-field drop >20%, or unexpected zero usable records. Red sources suppress deliveries they solely support.
