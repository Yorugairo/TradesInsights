# Architecture

> Maintained as a deliverable: update this file whenever the workspace structure, data flow, or a package's responsibility changes. Last updated: M0 (2026-07-15).

## System flow (spec §4)

```
official source
  → scheduled source run (pg-boss job or CLI)
  → immutable raw artifact (MinIO/S3, content-addressed by SHA-256) + raw_artifacts row
  → format parser (adapter.parse)
  → NormalizedSourceRecord (Zod-validated at the runner boundary)
  → source_records upsert + evidence_items          [built: M0]
  → address/parcel/organization normalization        [M2]
  → project resolution → project event timeline      [M2]
  → account route + deterministic score              [M3]
  → evidence verifier → review queue                 [M3]
  → digest/alert → customer feedback                 [M3]
```

## Workspace

pnpm workspace; every package exports TypeScript source directly (`main: src/index.ts`) — consumers (tsx, Vitest, Next with `transpilePackages`) compile on the fly, so there is no build orchestration. Per-package `tsc --noEmit` provides typechecking.

| Package | Responsibility | Status |
|---|---|---|
| `apps/web` | Next.js App Router UI + authenticated APIs | M3.5: §16 pages (opportunities/detail, project, digests, account, feedback, admin sources/runs/review/coverage) + §17 APIs; HMAC-cookie pilot auth, account-scoped queries, admin role gate; #3 — `/app/map` (Leaflet, account-scoped markers by band, geocoded points labeled as inferences) + geometry-coverage panel on admin coverage |
| `apps/worker` | pg-boss worker, source-run/backfill CLIs | M0: operational; #4 — config-reconciled cron schedules (per-source cadence with deterministic stagger, nightly maintenance chain, Monday digest drafts — `src/schedules.ts`) |
| `packages/db` | Drizzle schema (spec §7, 20 tables), migrations, seed | M0: operational |
| `packages/domain` | Stage/event/county taxonomy, `NormalizedSourceRecord` | M0: operational |
| `packages/config` | Zod-validated loaders for `config/*.yaml` | M0: operational |
| `packages/source-sdk` | Adapter contract, fetch policy, object store, run orchestrator, health | M0: operational |
| `packages/adapters` | Source adapters + registry | M1: 13 P0 adapters (Lacey ×2, Lewis ×3, King ×2, Seattle ×3, WA SEPA, Thurston, Tumwater ArcGIS) + M4.5 P1 (Lacey census, Lewis inspections) + `pierce_permits_arcgis` (Batch2 #1 — first Pierce permit/entitlement coverage via the county's open-data FeatureServer) + `tacoma_permits_arcgis` (Batch3 #3 — City of Tacoma Accela extract; Pierce PALS is unincorporated-only) + `fake_source` |
| `packages/documents` | PDF/Word/Excel/HTML extraction | M1: HTML (cheerio), PDF positioned text (pdfjs-dist, rotation-aware), XLSX (exceljs, normalized cells); Word deferred until a live source needs it (King reports turned out to be Excel-only) |
| `packages/resolution` | Address/org/project matching | M2: resolver passes 1–5 (official ID → explicit ref → parcel → address+name → proximity+org), review/undo workflow (+ Batch3 #1 triage: `triageReviewQueue` clusters pending reviews by rule/reason/candidate; `decideReviewCluster` bulk-decides through the per-row path), development grouping, cluster velocity, campus velocity (#3 — parcel-block clustering of non-development-grouped projects; #1/#5 — per-county calibrated block prefixes and a derived `projects.campus_block` membership column stamped/cleared each run, read by scoring/UI/digest; #3 — `geocode.ts`: geometry materialization from resolved records + US Census geocoding of address-only projects (unique-match + county cross-check guard, full provenance) |
| `packages/intelligence` | Routing, scoring, model extraction, verification | M3: account rules (versioned), §12 deterministic router/scorer, §13 model extraction (Anthropic SDK key-activated + mock, per-job/monthly budgets, `model_runs` ledger); §15 independent verifier + publication gate (deterministic checks + stored verdicts; `blocked_on_verifier` without keys) |
| `packages/delivery` | Digest/email rendering | M3.6: §18 weekly digest (gate-passing items only, suppression disclosed), deterministic HTML render, idempotent delivery + SMTP send; #2 lead-time backtest (`leadtime.ts`: per-account evidence lead time to the permit-issued milestone + per-source detection lag, all from stored events) |

## Key mechanisms (M0)

- **Immutable artifact store** (`source-sdk/object-store.ts`): objects are content-addressed (`raw/<sourceKey>/<sha256>`), so identical content is stored once and existing content can never be overwritten with different bytes. `raw_artifacts` has a unique index on (source, canonical URL, sha256).
- **Run orchestrator** (`source-sdk/runner.ts`): discover → fetch → store-before-parse → Zod-validate → upsert by (source, external_id) with a normalized fingerprint for change detection. Metrics per run: discovered / fetched / unchanged / parsed / rejected / duplicate / errors. Per-item failures become dead-letter entries in `source_runs.metrics_json` with enough context to reproduce.
- **Idempotency**: rerunning against unchanged content yields `unchanged` counts, bumps `last_seen_at`, and creates no new rows or objects (proven by `apps/worker/test/m0-exit-gate.test.ts`).
- **Durable jobs** (`apps/worker/src/jobs.ts`): pg-boss queues on the same Postgres; `source-run` retries with exponential backoff, exhausted jobs land in `source-run-dead-letter` with payload intact.
- **Health** (`source-sdk/health.ts`): green/amber/red per spec §14, persisted to `coverage_entries.freshness_state`.
- **Parser replay** (`source-sdk/replay.ts`, D5): `replaySource` re-parses a source's stored immutable artifacts through the current adapter and rewrites only the derived `source_records.normalized_json` where the new parse differs — so a parser fix heals history without re-fetching (the immutable store becomes a correctness asset, not just an audit log). Raw artifacts are read-only; evidence is append-only (backfilled only when absent); idempotent under an unchanged parser. `raw_artifacts.discovery_meta_json` persists the discovery-time context so the re-parse is faithful. `pnpm source:replay <key>`.
- **Parser self-reconciliation invariants** (`source-sdk/invariants.ts`, D1 — decision of record): positional PDF/table parsers assign values by geometry, so a layout shift can silently mis-assign a column without changing any field name, dropping volume, or emitting zero records — the schema-fingerprint, volume, and zero-record health checks all stay green through it. To close that hole an adapter may implement the optional `checkInvariants(raw, parsed, ctx)` hook; the runner calls it per artifact after persistence, records violations in `source_runs.metrics_json`, and `evaluateSourceHealth` turns the source red on any. The strongest invariants reconcile the parse against the document's *own printed totals* by an independent text search (Lacey census: printed permit count, dwelling-unit total, valuation grand total), so a geometry drift is caught by divergence from a number the parser reads a different way. Records are not dropped on violation — red + the §15 gate's red-source suppression withhold delivery until a human confirms.
- **Model gating** (`apps/worker/src/env.ts`): boots without model keys; model-dependent jobs report a visible blocked state (also blocked when `LLM_MONTHLY_BUDGET_USD` is unset).
- **Structured logs**: pino JSON with `traceId`, `sourceRunId`, `jobId` bindings; sensitive headers/params redacted (`source-sdk/logging.ts`).

## Decisions of record

- **No Redis** — pg-boss on Postgres (spec §2).
- **Content-addressed storage keys** rather than mutable paths: immutability is structural, not procedural.
- **Adapters never create opportunities** — they stop at `source_records` + `evidence_items` (spec §5).
- **Sources ship disabled** — `config/sources.yaml` requires terms/robots review dates before `enabled: true` (validated by the config loader).
- **Geometry columns** exist from M0 (PostGIS `geometry(Geometry,4326)`), but read/write handling arrives with M2 resolution work.
- **Verified decision brief** (`packages/intelligence/src/brief.ts`, decision of record) — the only place model PROSE reaches the customer. It is a rendering of already-verified rows, never a source of truth: the model composes from a fixed menu built entirely from the deterministic decision memo (verified facts, labeled inferences, deterministic context), and `validateBrief` rejects the whole draft on an unknown ref or an unsubstantiated number/date (the §13 "reject unknown evidence IDs" rule applied to prose). Segment kind is DERIVED from cited refs, so an inference can never be surfaced as a fact. Persisted as an account-scoped `model_runs.job_type='brief_draft'`; a rejected/blocked draft falls back to the deterministic memo. Scores, stages, and `bidding_confirmed` still come only from stored data — prose never sets them.
- **First-look coverage metric** (`packages/delivery/src/leadtime.ts` `firstLookByCoverage`, decision of record) — the "we see it first" number, a THIRD lead-time framing alongside evidence-lead and detection-lag: per source×county, how often our earliest sighting predates the `permit_issued` (publicly biddable) milestone and the median lead when early. `permit_issued` is the public-visibility proxy (a permit surfaces on aggregator bid boards). Same no-fabrication conventions: stated-date anchored, floored at 0, sample floor, test sources excluded, groups below floor dropped.
- **Pipeline summary** (`packages/delivery/src/pipeline.ts`) is a COMPOSITION over existing S5 machinery (pursuit state machine, `opportunity_outcomes`, evidence lead, first-look), not a new store — the customer-facing sourced→bid→won funnel + dollar attribution, reproduced from stored rows only.
- **De-routing archives, it does not invent a state** (`packages/intelligence/src/score-run.ts`, decision of record, 2026-07-26) — `scoreAll` used to write only the pairs `routeProject` RETURNED, so an opportunity whose (project, account) pair stopped routing (territory edit, exclusion rule, keyword reclassification) kept its row untouched at its last score and algorithm version forever. Found live: opportunity `93054ce2` (solis_interiors, `weekly_digest`, 72.5) still carried `algorithmVersion` 1.9.0 three releases after 1.12.0. The run now sweeps at the end and moves de-routed rows to **`archive`**, recording the reason under `rationale_json.deroute` (`reason`, `archivedAt`, `previousState`, `atAlgorithmVersion`). `archive` was chosen over a new "stale" flag because it is already this system's word for "scored, not deliverable" and every delivery path honours it. Three constraints hold the sweep honest: it only considers pairs whose project the run actually re-scored (a scoped or aborted run can never archive what it did not read); it skips accounts with no router in `ROUTERS`, since "nothing routed" there is a config gap, not a verdict; and it never touches `dismissed`/`promoted`, re-asserting that guard at write time so an owner acting mid-run wins. The marker is merged into the rationale, never over it, and is cleared automatically if the pair routes again.
- **Delivery refuses a score it cannot name** (`scoredByCurrentAlgorithm`, decision of record, 2026-07-26) — the weekly digest and the WS-C phase-change alert both withhold an opportunity whose `rationale_json.algorithmVersion` is not the running `SCORING_ALGORITHM_VERSION`. The score is what ORDERS a digest, so a score from a retired model cannot be ranked against current ones. An ABSENT version fails too: `scoreAll` stamps every row it writes, so unknown provenance is not current provenance. This is a second, independent line to the sweep above — it also catches a rescore that dies partway and leaves mixed versions live (2026-07-26: a pooler drop after 31 of ~1,260 Solis rows). Withheld items are counted and disclosed in digest section 5 (`suppressed.staleScore`) and in `AlertsRunSummary.evaluated.staleScoreSkipped`, never silently dropped.
