# Operations

> Maintained as a deliverable: update this file whenever infra, jobs, environment variables, or runbooks change. Last updated: M0 (2026-07-15).

## Local bring-up

```bash
cp .env.example .env      # defaults match docker-compose
pnpm install
pnpm infra:up             # Postgres/PostGIS :5432, MinIO :9000 (console :9001), Mailpit :1025 (UI :8025)
pnpm db:migrate
pnpm db:seed              # idempotent — upserts sources + account profiles from config/
pnpm dev                  # web on :3000
pnpm worker               # pg-boss worker
```

The app boots **without** model keys; the worker logs `modelJobs: "blocked"` until `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` **and** `LLM_MONTHLY_BUDGET_USD` are set.

## Running sources

```bash
pnpm source:run <source-key>              # one run; prints metrics + health
pnpm source:run <source-key> --shadow     # run a disabled source (shadow mode)
pnpm source:backfill <source-key> --from YYYY-MM-DD --to YYYY-MM-DD [--shadow]
```

Runs are recorded in `source_runs`; per-item failures are dead-lettered inside `metrics_json` with stage + error, reproducible by re-running the source.

## Tests

```bash
pnpm test        # Vitest — requires infra up + migrated DB (integration tests hit Postgres/MinIO)
pnpm test:e2e    # Playwright against next dev on :3100
pnpm lint
pnpm typecheck
```

Cloud/CI note: in environments with a preinstalled Playwright chromium at a different revision (e.g. Claude Code remote), run
`PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium pnpm test:e2e` instead of downloading browsers.

## Job system

pg-boss (schema `pgboss` in the same Postgres). Queues:

| Queue | Purpose | Retry | Dead letter |
|---|---|---|---|
| `source-run` | one source ingestion run | 3× exponential backoff | `source-run-dead-letter` (payload intact) |

Inspect jobs: `SELECT name, state, count(*) FROM pgboss.job GROUP BY 1,2;`

## Health & monitoring (spec §14)

`evaluateSourceHealth` runs after every CLI run and writes `coverage_entries.freshness_state`:

- **red** — two consecutive failed runs; stale > 2× cadence; unexpected zero usable records. Red sources suppress deliveries they solely support.
- **amber** — latest run failed; no history; usable volume dropped >50% vs previous run.
- **green** — otherwise.

Logs are structured JSON (pino) with `traceId`, `sourceRunId`, `jobId`. Auth tokens and sensitive query params are redacted at the logger and URL level.

## Storage

MinIO bucket `otn-artifacts` (auto-created on first run). Keys: `raw/<source_key>/<sha256>` — content-addressed, never overwritten. Console: http://localhost:9001 (credentials in `.env`).

## Runbooks

- **Source went red** — check latest `source_runs.metrics_json` dead letters; re-run with `pnpm source:run <key>`; if the landing page or schema changed, capture new fixtures, bump `parserVersion`, and update the activation ledger in `docs/source-policy.md`.
- **Migration** — add schema change to `packages/db/src/schema.ts`, `pnpm --filter @otn/db generate`, review SQL in `packages/db/migrations/`, `pnpm db:migrate`, update `docs/data-dictionary.md`.
- **Disk pressure (local)** — `docker system prune`; artifact bucket and Postgres volumes (`pgdata`, `miniodata`) are the only durable state.
