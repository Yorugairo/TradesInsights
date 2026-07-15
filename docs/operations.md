# Operations

> Maintained as a deliverable: update this file whenever infra, jobs, environment variables, or runbooks change. Last updated: ast-grep tooling (2026-07-15).

## AI tooling: sigmap, sqz, and ast-grep

All three are required (see CLAUDE.md "AI tooling (mandatory)").

**sigmap** — code signature index for grounding AI answers in real files/symbols. Installed as a repo devDependency (`sigmap` in root `package.json`); config in `gen-context.config.json` and `.contextignore`.

```bash
pnpm map                              # regenerate .github/copilot-instructions.md, AGENTS.md, .github/gemini-context.md
pnpm map:ask "<question>"             # ground a code question in the live index (use before ad-hoc grep/explore)
pnpm map:verify <answer.md>           # flag fabricated files/symbols/imports in an AI-authored doc
pnpm map:evidence "<task>"            # build a machine-readable context pack for a task
```

`gen-context.config.json`'s `outputs` list intentionally excludes `"claude"` — CLAUDE.md is hand-curated and must not be overwritten by a regenerate pass. Generated files (`.github/copilot-instructions.md`, `.github/gemini-context.md`, `AGENTS.md`, `.context/`, `.sigmap-cache.json`) are gitignored; regenerate on demand rather than trusting a committed snapshot.

**sqz** — command-output compression to cut token cost. Installed from source via `cargo install sqz-cli sqz-mcp` (no prebuilt Linux binary was reachable in this environment; crates.io build took ~3 minutes). Initialized with `sqz init --global`, which:
- adds a shell hook to `~/.bashrc`,
- installs a Claude Code hook in `~/.claude/settings.json` (`PreToolUse` on Bash/PowerShell, `PreCompact`, `SessionStart` on compact) that transparently compresses tool output,
- registers an MCP server (`sqz-mcp`) and Codex config at the user level.

Global scope was a deliberate choice (confirmed with the user) — the hook applies to every session in this environment, not just this repo. Config-generation for AI tools not used on this project (Cursor, Windsurf, Cline, Gemini CLI, Kiro, OpenCode) was declined and those files removed after init; only the Claude Code and Codex/AGENTS.md integrations were kept.

```bash
sqz status       # current token budget/usage for the session
sqz gain         # accumulated token savings
sqz compress <text|-> # compress ad hoc content
```

**ast-grep** — structural (AST-pattern) code search and cheap file/directory outlining. CLI installed globally via `npm install -g @ast-grep/cli` (`ast-grep`/`sg`, v0.44.1). Skills installed via `npx skills add ast-grep/agent-skill` into `.agents/skills/{ast-grep,ast-grep-outline}` (canonical content, committed) with symlinks at `.claude/skills/{ast-grep,ast-grep-outline}` for Claude Code; `skills-lock.json` at repo root records provenance/hashes for reproducible reinstall (`npx skills experimental_install`). Both skill files were read in full before being mandated — pure instructional prompt content, no embedded commands, MIT-licensed upstream.

```bash
ast-grep outline <file|dir>              # cheap structural map (imports/exports/members + line numbers) before a full read
ast-grep run --pattern '<pat>' --lang <lang> <path>   # simple single-node structural search
ast-grep scan --rule <rule.yml> <path>   # complex structural search (relational/composite rules)
```

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
