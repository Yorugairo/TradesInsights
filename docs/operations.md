# Operations

> Maintained as a deliverable: update this file whenever infra, jobs, environment variables, or runbooks change. Last updated: ECC curated skills/agents (2026-07-15).

## ECC skills and agents (curated, no hooks)

A curated subset of [ECC](https://github.com/affaan-m/ecc) ("Everything Claude Code", MIT) is installed for cross-cutting engineering patterns. See CLAUDE.md "ECC skills and agents" for the catalog and when to use them.

Deliberate scope (confirmed with the user): **skills + read-only/worker agents only. ECC's hooks were NOT installed** — its `hooks.json` ships a global `~/.claude` PreToolUse/PreCompact/SessionStart set including `gateguard-fact-force` (blocks the first Edit/Write per file), `config-protection` (blocks linter/formatter config edits), and `continuous-learning`/`governance-capture` (record tool-use and secret/policy events to disk). Those would block the OTN build and clash with the sqz hooks, so we skipped the plugin/`install.sh` path entirely.

- Skills: canonical files in `.agents/skills/<name>/`, symlinked into `.claude/skills/<name>` (17 skills). Agents: `.claude/agents/<name>.md` (11 agents).
- Provenance/hashes: `skills-lock.json` (root). Restore with `npx skills experimental_install`.
- Add or update a skill: `npx skills add "affaan-m/ecc@<name>" --yes`. `npx skills add "affaan-m/ecc@__list__"` prints the full 279-skill catalog.
- Do **not** run `./install.sh`, `npx ecc-install`, or `/plugin install ecc@ecc` — all three pull the global hooks we intentionally excluded.
- Every installed skill and agent file was read/scanned before use (pure instructional markdown; no embedded shell/network/hook-script content).

## Self-learning loop (project-scoped, custom)

A minimal, self-contained learn/inject loop — **not** ECC's hooks (theirs are inert without the per-call capture we excluded, and their SessionStart injector isn't separable from a monolithic bootstrap that also writes to global `~/.claude`). Project-scoped, no per-tool-call capture, fail-open.

- **Store:** `.claude/learned/LEARNED.md` — curated, human-editable, **tracked in git** (must survive the ephemeral container to persist across sessions). Transient per-session markers live in `.claude/learned/.state/` (gitignored).
- **Inject** (`.claude/hooks/session-start-learn.js`, SessionStart): injects `LEARNED.md` as `additionalContext` at session start; no-op if it has no bullets.
- **Extract** (`.claude/hooks/stop-extract-learn.js`, Stop): once per substantive session (≥8 user messages), asks the model to append one durable lesson to `LEARNED.md` — explicitly allowing a no-op. Loop-safe via `stop_hook_active` + a per-session marker; at most one extra round-trip per session.
- Wired in `.claude/settings.json` (project, committed). Takes effect on the **next** session (hooks load at session start). Both fail open — any error allows the session to proceed. To disable: remove the two entries from `.claude/settings.json`.

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

## Outbound HTTP (adapters)

`FetchPolicy` (packages/source-sdk) honors standard `HTTPS_PROXY`/`NO_PROXY` env vars: when set, requests route through undici's `EnvHttpProxyAgent` with undici's own fetch (Node's global fetch ignores proxy env vars, and mixing npm-undici dispatchers into Node's built-in fetch fails with `UND_ERR_INVALID_ARG`). TLS trust for a re-terminating proxy comes from `NODE_EXTRA_CA_CERTS`. No-op when the vars are unset. Unit tests blank these vars in `vitest.config.ts` so global-fetch stubs keep working. Some hosts (kingcounty.gov) are only reachable via the proxy path in the Claude Code remote environment.

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

## Resolution (M2)

```bash
pnpm resolve:run [--limit N]   # resolve every source record without an active resolution (oldest first)
```

Deterministic passes (spec §10 order): official ID → explicit reference → parcel overlap (M2.2) → normalized address + compatible name → proximity + organization (M2.3, PostGIS). Non-project records (source canaries) are skipped; test-priority sources excluded. Conflicts (cross-jurisdiction parcel matches, multiple candidates, generic names, same-address TIs, fuzzy-without-support) go to `resolution_reviews` instead of auto-merging. Inspect: `SELECT matched_rule, count(*) FROM record_resolutions GROUP BY 1;`

Review workflow (M2.5):

```bash
pnpm review list                                        # pending ambiguous matches
pnpm review decide <review-id> merge|reject [--by <who>] [--note <text>]
pnpm review undo <source-record-id> --reason <text>     # split: undo a merge, keep the record + history
```

Merge decisions create a `record_resolutions` row with `decision=review_approved`; reject re-resolves the record with the rejected candidate excluded; undo flips the resolution to `undone`, deletes only rows *derived from that record* (events, roles), and never touches the source record.

`resolve:run` finishes with development grouping (M2.4): projects sharing a distinctive base name (phase/lot/div tokens stripped; permit-type vocabulary alone never groups) plus org/parcel/proximity support get a `development_id`; a single plat/base project parents its phases. **The development layer is derived and rebuildable**: `UPDATE projects SET development_id=NULL, parent_project_id=NULL; DELETE FROM developments;` then `pnpm resolve:run`.

## Intelligence (M3)

```bash
pnpm score:run                             # route + score every project into opportunities (deterministic, idempotent)
pnpm extract:run [--project <id>] [--limit N]   # model extraction over stored evidence (spec §13)
pnpm verify:run  [--project <id>] [--limit N]   # independent verification of extracted facts (spec §15)
pnpm gate:run    [--opportunity <id>] [--limit N]   # read-only §15 publication-gate evaluation
pnpm digest:run  [--account <key>] [--end YYYY-MM-DD] [--send]   # weekly digest draft/send (spec §18)
pnpm feedback:report [--account <key>]     # per-account calibration rollup (read-only)
pnpm eval:build --out <path>               # regenerate labeled-eval candidates (M4.1; reviewed before commit)
pnpm eval:run [--set <jsonl>] [--split dev|holdout|all]   # deterministic gate check vs labels (exit 1 on gate fail)
pnpm delivery:metrics                      # measured duplicate/expired rates over stored digests (M4 gates)
```

`score:run` re-scores all projects; manual opportunity states (`dismissed`, `promoted`) are sticky and never clobbered. `extract:run` picks the highest-scoring digest-band-or-better projects without a succeeded extraction (or one explicit `--project`), sends each project's stored evidence items to the model, and Zod-validates the §13 payload — unknown evidence IDs reject the run. Every attempt (succeeded / rejected / blocked / error) is persisted to `model_runs` with provider, model, prompt version, tokens, cost, latency, and result hash.

`verify:run` is the independent verifier: a second, separate model call that re-checks each extracted fact against the exact evidence it cites (one verdict per fact; verdicts for facts never extracted, or missing verdicts, reject the run). `gate:run` evaluates the full §15 gate per opportunity — source health (suppress red-only support), identity/geography/stage/event-date, A-grade core event, every fact evidenced (D never publishable, C never alone), inferences labeled, no pending identity review, ≤180-day activity, score ≥ digest threshold, verifier verdict — and reports `pass` / `fail` / `blocked_on_verifier`. Until model keys are set, expect `blocked_on_verifier` for everything that clears the deterministic checks: nothing publishes without the independent verifier having passed.

`digest:run` builds the §18 weekly digest per account (5 sections; only gate-*passing* items appear; withheld items are counted and disclosed in section 5, never silently dropped; top 500 candidates by score per run). **Controlled automation (M4.3/M4.4, policy v1.0.0):** a gate-passing item auto-enters customer sections only when independently verified with every fact ≥0.9 confidence and no missing critical facts, and it is not high-risk (deadline/actionable claim, ≥$5M value, ambiguous routing, contact data, `bidding_confirmed`). Everything else lands in the digest's review queue (stored in delivery metadata with policy reasons, count disclosed in section 5). The only automation override is a recorded human decision: promoting the opportunity includes it; dismissing drops it. Delivery is idempotent per `(account, week)` via the `weekly:<account>:<period-end>` idempotency key — re-running returns the stored delivery, and `--send` (SMTP/Mailpit) never re-sends a sent digest. "New" is a delivery-history fact: an opportunity is new only on its first-ever inclusion; unchanged repeats say "no change since your last digest". Recipient defaults to the pilot placeholder `<account>@pilot.otn.local` until real recipients are configured.

Feedback (M3.7): relevant / new / timely / pursue booleans plus a **controlled disposition vocabulary** (`DISPOSITION_REASONS` in `packages/intelligence/src/feedback.ts` — pursuing, already_known, wrong_trade, out_of_territory, too_small/large, too_late/early, wrong_customer_type, duplicate, insufficient_evidence, other); free text goes in `notes`. `feedback:report` aggregates rates, disposition counts, and per-route relevance as the §22 calibration input. **Feedback never changes rules automatically** — the operator reads the rollup and appends a new rule version (`appendRuleVersion`); every past decision stays explainable under its own version.

**Key activation:** without `ANTHROPIC_API_KEY` + `LLM_MONTHLY_BUDGET_USD` the pipeline stays in a *visible blocked state* — a batch `extract:run` logs `modelJobs: "blocked"` and exits cleanly; a targeted `--project` run records a `status='blocked'` `model_runs` row. Setting the two env vars activates the Anthropic provider (`claude-opus-4-8`, official SDK, proxy-aware) with no code changes. `LLM_JOB_BUDGET_USD` caps the worst-case cost per job (default $0.50); the monthly check sums `model_runs.cost_usd` for the current UTC month and blocks *before* spending.

## Web application (M3.5)

`pnpm dev` serves the authenticated surface on :3000. Pilot auth is a shared passphrase (`AUTH_SECRET` in `.env`) with an HMAC-signed HttpOnly session cookie: customer sessions are bound to one account (`/login` → account picker) and every `/api/app/*` query is scoped to that account; admin sessions (`role=admin`) unlock `/app/admin/*` (sources with run/disable controls, resolution review queue with merge/reject, coverage) and `/api/admin/*`. §16 routes and §17 APIs are implemented 1:1; "run source" enqueues a durable pg-boss `source-run` job (the worker must be running to execute it). E2E: `pnpm --filter @otn/web test:e2e` (needs local Postgres + seeded corpus; set `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium` in this environment).

## Customer bid inbox (M4.6 — blocked until authorized)

`customer_bid_inbox_<account>` sources ingest **customer-provided JSON exports** from a local inbox directory (`CUSTOMER_BID_INBOX_DIR`; fixtures dir in tests) — never scraped, never fetched with customer credentials. All ingested data is private to the owning account (`sources.account_profile_id`), excluded from the shared project graph (per-account graph overlays are activation-time work), surfaced only via `/app/invitations` + `GET /api/app/invitations`, and every read is appended to `artifact_access_log` (spec §20). This is the ONLY source class that may set `bidding_confirmed`, and only for explicit invitation/solicitation statuses — anything else keeps its verbatim status with stage `unknown`. `customer_bid_inbox_solis` ships **disabled** until Solis grants written authorization and names the platform/export path.

## Operational alerts (M4.7)

```bash
pnpm alerts:run [--send]     # evaluate spend/health/stale/delivery conditions
```

Conditions: LLM monthly spend ≥80% (warning) / ≥100% (critical, "model jobs blocked") of `LLM_MONTHLY_BUDGET_USD`; any enabled source RED (critical, re-alerts daily while red); enabled source stale beyond 2× cadence (warning, daily/weekly/monthly mapped to 1/7/31 days); digest drafts still unsent 3+ days past period end (warning). Fired alerts are durable rows in `alerts` with per-period idempotency keys — reruns dedupe; `--send` emails only *newly fired* alerts to `ALERTS_EMAIL` (Mailpit locally). Run on a schedule (e.g. daily cron) in production.

## Running sources

```bash
pnpm source:run <source-key>              # one run; prints metrics + health
pnpm source:run <source-key> --shadow     # run a disabled source (shadow mode)
pnpm source:backfill <source-key> --from YYYY-MM-DD --to YYYY-MM-DD [--shadow]
```

Runs are recorded in `source_runs`; per-item failures are dead-lettered inside `metrics_json` with stage + error, reproducible by re-running the source.

**Source health (`evaluateSourceHealth`, spec §14) turns a source RED on:** two consecutive failed runs; staleness beyond 2× cadence; unexpected zero usable records; **D1 parser invariant violations** on the latest run; or a **D2 required-field fill drop** (a `MONITORED_FILL_FIELDS` value that was ≥50% present dropped >20% relative between this source's two most recent parsed runs — it silently stopped emitting a column). The D2 comparison is self-referential per source, so a field that is structurally null for a source never trips. **AMBER** additionally on **D3 schema-fingerprint drift** — the hash of raw field names changed between the two most recent parsed runs, i.e. the source altered its field names; parsing may still succeed but a human should review the parser (the fingerprint had been recorded since M0 but never compared). A RED source is suppressed by the §15 publication gate (deliveries supported only by it are withheld). The D1 trigger is the only one that catches a *silent positional mis-parse* — a layout shift that moves a column produces no field-name change, no volume drop, and no zero-record, so without invariant reconciliation it would look green while emitting wrong values. An adapter's `checkInvariants` reconciles its parse against the document's own printed totals (e.g. Lacey census: printed permit count, dwelling-unit total, valuation grand total) and value-shape expectations (units ceiling; Lewis permit-id format + no permit/date bleeding into the type/reason columns). A red-from-invariant means "the parse no longer reconciles — inspect the source layout"; violations are listed in `source_runs.metrics_json.invariantViolationDetails`.

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
