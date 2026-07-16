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
| `apps/web` | Next.js App Router UI + authenticated APIs | M3.5: §16 pages (opportunities/detail, project, digests, account, feedback, admin sources/runs/review/coverage) + §17 APIs; HMAC-cookie pilot auth, account-scoped queries, admin role gate |
| `apps/worker` | pg-boss worker, source-run/backfill CLIs | M0: operational |
| `packages/db` | Drizzle schema (spec §7, 20 tables), migrations, seed | M0: operational |
| `packages/domain` | Stage/event/county taxonomy, `NormalizedSourceRecord` | M0: operational |
| `packages/config` | Zod-validated loaders for `config/*.yaml` | M0: operational |
| `packages/source-sdk` | Adapter contract, fetch policy, object store, run orchestrator, health | M0: operational |
| `packages/adapters` | Source adapters + registry | M1: 13 P0 adapters registered (Lacey ×2, Lewis ×3, King ×2, Seattle ×3, WA SEPA, Thurston, Tumwater ArcGIS) + `fake_source` |
| `packages/documents` | PDF/Word/Excel/HTML extraction | M1: HTML (cheerio), PDF positioned text (pdfjs-dist, rotation-aware), XLSX (exceljs, normalized cells); Word deferred until a live source needs it (King reports turned out to be Excel-only) |
| `packages/resolution` | Address/org/project matching | M2: resolver passes 1–5 (official ID → explicit ref → parcel → address+name → proximity+org), review/undo workflow, development grouping, cluster velocity |
| `packages/intelligence` | Routing, scoring, model extraction, verification | M3: account rules (versioned), §12 deterministic router/scorer, §13 model extraction (Anthropic SDK key-activated + mock, per-job/monthly budgets, `model_runs` ledger); §15 independent verifier + publication gate (deterministic checks + stored verdicts; `blocked_on_verifier` without keys) |
| `packages/delivery` | Digest/email rendering | M3.6: §18 weekly digest (gate-passing items only, suppression disclosed), deterministic HTML render, idempotent delivery + SMTP send |

## Key mechanisms (M0)

- **Immutable artifact store** (`source-sdk/object-store.ts`): objects are content-addressed (`raw/<sourceKey>/<sha256>`), so identical content is stored once and existing content can never be overwritten with different bytes. `raw_artifacts` has a unique index on (source, canonical URL, sha256).
- **Run orchestrator** (`source-sdk/runner.ts`): discover → fetch → store-before-parse → Zod-validate → upsert by (source, external_id) with a normalized fingerprint for change detection. Metrics per run: discovered / fetched / unchanged / parsed / rejected / duplicate / errors. Per-item failures become dead-letter entries in `source_runs.metrics_json` with enough context to reproduce.
- **Idempotency**: rerunning against unchanged content yields `unchanged` counts, bumps `last_seen_at`, and creates no new rows or objects (proven by `apps/worker/test/m0-exit-gate.test.ts`).
- **Durable jobs** (`apps/worker/src/jobs.ts`): pg-boss queues on the same Postgres; `source-run` retries with exponential backoff, exhausted jobs land in `source-run-dead-letter` with payload intact.
- **Health** (`source-sdk/health.ts`): green/amber/red per spec §14, persisted to `coverage_entries.freshness_state`.
- **Model gating** (`apps/worker/src/env.ts`): boots without model keys; model-dependent jobs report a visible blocked state (also blocked when `LLM_MONTHLY_BUDGET_USD` is unset).
- **Structured logs**: pino JSON with `traceId`, `sourceRunId`, `jobId` bindings; sensitive headers/params redacted (`source-sdk/logging.ts`).

## Decisions of record

- **No Redis** — pg-boss on Postgres (spec §2).
- **Content-addressed storage keys** rather than mutable paths: immutability is structural, not procedural.
- **Adapters never create opportunities** — they stop at `source_records` + `evidence_items` (spec §5).
- **Sources ship disabled** — `config/sources.yaml` requires terms/robots review dates before `enabled: true` (validated by the config loader).
- **Geometry columns** exist from M0 (PostGIS `geometry(Geometry,4326)`), but read/write handling arrives with M2 resolution work.
