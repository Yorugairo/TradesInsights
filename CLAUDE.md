# OTN Insights

Construction-opportunity intelligence for trade contractors. The system monitors official public construction sources (planning, permits, SEPA, procurement, licensing) in Thurston, Pierce, Lewis, and King counties (WA), resolves related records into projects, matches them to each account's real capabilities, and delivers sourced opportunity briefs and stage-change alerts.

**The full build specification is `docs/BUILD_SPEC.md`. It is the source of truth. Read the relevant section before implementing anything; this file is only the operating summary.**

## Governing rule

One trustworthy evidence graph, account-specific interpretation, and **no claim without a source**.

Non-negotiable invariants:

- **Never fabricate** a source field, project stage, scope, company role, contact, bid date, or citation. Unknown values are `null`, never guessed or coerced to zero.
- **Immutable evidence.** Every fetched artifact is stored raw with retrieval metadata and SHA-256 before parsing. Raw artifacts and source records are never deleted or mutated.
- **Facts vs. inferences are separated.** Confirmed facts and inferences occupy separate rows/objects or carry explicit `confirmed` and `confidence` fields.
- **AI is never the system of record.** Deterministic parsing first; models only interpret captured evidence. Final scores are deterministic calculations over stored components.
- **A permit is not a bid.** Only an explicit solicitation, customer invitation, or equivalent evidence may set `bidding_confirmed`.
- **Account isolation.** Private bid/invitation artifacts are account-scoped; one account must never see another's data.
- **Verify before enabling.** Before enabling a live source, verify its official landing page, current format, access rules, and expected fields.

## Out of scope (do not build)

Public market/trade pages; autonomous prospecting or outreach; bid submission, pricing, estimating, or legal commitments; cleaning-company intelligence (first release);

## Stack

TypeScript (strict) · pnpm workspaces · Next.js App Router (`apps/web`) · Node TS worker (`apps/worker`) · PostgreSQL + PostGIS · Drizzle ORM + versioned SQL migrations · pg-boss durable jobs (no Redis) · S3-compatible storage (MinIO locally) · Vitest · Playwright (app E2E + approved dynamic adapters only) · Zod at every external boundary · structured JSON logs with trace/source-run/job IDs · Docker Compose (Postgres/PostGIS, MinIO, Mailpit).

Lock dependencies. The app must boot locally **without** model keys — model-dependent jobs enter a visible blocked/skipped state.

## Repository layout

```
apps/web         Next.js UI and authenticated APIs
apps/worker      collectors, parsers, resolution, scoring, delivery
packages/db      Drizzle schema, migrations, repositories
packages/source-sdk    adapter interfaces, fetch policy, artifact store
packages/adapters      jurisdiction/source adapters
packages/documents     PDF, Word, Excel, HTML extraction
packages/domain        normalized schemas, stage/event taxonomy
packages/resolution    address, organization, project matching
packages/intelligence  routing, scoring, evidence verification
packages/delivery      digest and email rendering
packages/config        typed source/account config loader
config/sources.yaml, config/account-profiles.yaml
fixtures/<source-key>/
docs/            architecture, data-dictionary, source-policy, operations
```

## Commands

```
pnpm install          pnpm infra:up        pnpm db:migrate     pnpm db:seed
pnpm dev              pnpm worker          pnpm test           pnpm test:e2e
pnpm lint             pnpm typecheck
pnpm source:run <source-key>
pnpm source:backfill <source-key> --from YYYY-MM-DD --to YYYY-MM-DD
```

Environment variables are documented in `.env.example` (spec §3).

## Implementation order

Work the numbered backlog in spec §21 strictly in order; **do not begin a later stage until the prior exit gate passes**. Complete tests and acceptance checks with each task — never defer them.

- **M0** scaffold (workspace, compose, schema, artifact store, jobs, manifest/fixture harness) — exit: a fake adapter discovers, stores, hashes, parses, reruns idempotently, reports health.
- **M1** P0 adapters in the order M1.1–M1.10 — exit: ≥90-day backfill, golden fixtures, correct county/jurisdiction, manual audit, green health.
- **M2** project graph (normalization, matching, hierarchy, merge/split review, cluster velocity).
- **M3** pilot intelligence (profiles, routing/scoring, model extraction, verifier, UI, digest, feedback).
- **M4** controlled automation + P1 sources (eval set, precision gates, alerts).

At each milestone report only: outcome; files/migrations changed; tests run and exact results; sources verified and sample counts; remaining blockers/assumptions; next task ID. (Use the `milestone-report` skill.)

## Durable docs are deliverables

The docs below are part of the work, not an afterthought. **Update the pertinent doc in the same pass as the change it describes — a task is not complete until its docs are current.**

| Doc | Update whenever… |
|---|---|
| `docs/STATUS.md` | **every session and every completed task ID** — current task, ledger, blockers, assumptions, pending calibration |
| `docs/architecture.md` | workspace structure, data flow, package responsibilities, or a decision of record changes |
| `docs/data-dictionary.md` | any schema migration (same commit as the migration) |
| `docs/source-policy.md` | a source goes through the activation checklist — append to the activation ledger with verification dates; record blockers |
| `docs/operations.md` | infra, env vars, jobs, commands, or runbooks change |

`docs/BUILD_SPEC.md` is read-only reference — never edit it to match the code; if reality diverges from spec, record the divergence in STATUS.md and architecture.md.

## Key domain reference

- **Stages** (spec §9): concept → preapplication → entitlement → approved → construction_documents → permit_applied → permit_issued → bidding_confirmed → construction → near_final → complete; plus withdrawn, unknown.
- **Normalized record shape** (spec §8): all parsers emit the Zod-validated `NormalizedSourceRecord`; county is one of Thurston | Pierce | Lewis | King; always retain the permitting jurisdiction (King reports are unincorporated King unless stated).
- **Resolution** (spec §10): match by official ID → explicit reference → parcel overlap → address+name → proximity+org/name → documented development/phase. Ambiguity goes to review; record resolver version/features/score; support split/undo. A 40-permit subdivision cluster is **one** opportunity plus a velocity signal, not 40 leads.
- **Evidence** (spec §11): authority grades A–D; every delivered fact needs an evidence row, source URL, retrieved time, page/section span, and `confirmed = true`. C-grade is never sufficient alone; D is never customer-publishable.
- **Publication gate** (spec §15): healthy source, A-grade core event, all facts evidenced, inferences labeled, no identity contradiction, score clears threshold, independent verifier passes. Suppress deliveries supported only by a red source.
- **Source health** (spec §14): green/amber/red; red = two consecutive failures, stale > 2× cadence, required-field drop >20%, or unexpected zero usable records.
- **Delivery bands** (spec §12): 80–100 priority review; 65–79 weekly digest; <65 archive.
- **Accounts** (spec §12): Lacey Glass at Home (residential glass, King excluded until confirmed), Lacey Glass Commercial (Division 08, Seattle/King routes here), Solis Interiors (drywall + painting; UBI 604837560, reg SOLISIL785NT; exclude closed UBI 604701295). All rules versioned and editable in `config/account-profiles.yaml`.
- **AI contract** (spec §13): model output is Zod-validated JSON of facts/inferences/missingCriticalFacts referencing known evidence IDs; store provider, model, prompt version, tokens, cost, latency, result hash; enforce per-job and monthly budgets.

## Security

Encrypt secrets and private evidence; least-privilege roles and signed object URLs; keep credentials out of prompts, logs, fixtures, and Git; redact auth tokens and sensitive query params from logs; audit access to customer invitation artifacts; respect source withdrawal/correction; preserve attribution; never redistribute restricted plan sets or private bid documents; never auto-send prospecting, submit bids, quote prices, or commit a customer.

## Project skills

These four are the domain authority for OTN Insights — prefer them over any general skill when the work is about adapters, resolution, evidence, or milestones.

- `source-adapter` — build and activate a source adapter (contract, checklist, fixtures, test gates).
- `project-resolution` — resolve records into the development/project/event graph.
- `evidence-gate` — evidence rules, AI contract, and the opportunity publication gate.
- `milestone-report` — the required milestone reporting format and exit-gate checklists.

## ECC skills and agents (curated, no hooks)

A curated subset of [ECC](https://github.com/affaan-m/ecc) (MIT) is installed for cross-cutting engineering patterns — **skills only, and read-only/worker agents; ECC's hooks and continuous-learning/governance capture were deliberately NOT installed** (they block edits and clash with the sqz hooks). Do **not** run ECC's `install.sh`/`/plugin install ecc@ecc` — that pulls the global hooks. Skills live in `.agents/skills/` (symlinked into `.claude/skills/`), agents in `.claude/agents/`; provenance is in `skills-lock.json`. Reinstall/extend with `npx skills add "affaan-m/ecc@<name>" --yes`.

These are general engineering references — the four project skills above and the spec still govern OTN-specific decisions. Highest-value overlaps with this codebase:

- `content-hash-cache-pattern` — SHA-256 content-addressed caching; mirrors the immutable artifact store (spec §5). 
- `regex-vs-llm-structured-text` — "start with regex/deterministic parsing, add LLM only for low-confidence edge cases"; the spec §13 parsing rule, made concrete.
- `cost-aware-llm-pipeline` — model routing, budget tracking, prompt caching; supports the §13 per-job/monthly budget contract (M3+).
- `database-migrations` (Drizzle), `postgres-patterns`, `backend-patterns`, `api-design`, `docker-patterns`, `deployment-patterns`, `tdd-workflow`, `e2e-testing` (Playwright), `verification-loop`, `eval-harness` (M4 precision gates), `security-review`, `coding-standards`, `frontend-patterns`, `search-first`.

Pertinent agents for delegation (via the Agent tool): `typescript-reviewer`, `database-reviewer`, `security-reviewer`, `code-reviewer`, `architect`, `planner`, `tdd-guide`, `e2e-runner`, `build-error-resolver`, `doc-updater`, `refactor-cleaner`.

## Self-learning loop

A project-scoped learn/inject loop (custom, not ECC's hooks) keeps durable lessons in `.claude/learned/LEARNED.md` (tracked in git). Accumulated lessons are injected at session start; at the end of a substantive session the Stop hook asks you (once) to append one durable, reusable lesson — **a no-op is expected and correct when nothing lasting was learned**. Record only general, project-useful lessons (a real gotcha, a fix pattern, a convention); never secrets or one-off details. Mechanism and how to disable: `docs/operations.md` "Self-learning loop".

## AI tooling (mandatory)

Three tools are installed (`sigmap` + `ast-grep` as repo devDependencies, `sqz` as a global binary + shell hook) — do not skip them to save a step.

**Never-stale by construction:** `pnpm map:ask` / `map:query` / `map:verify` each **regenerate the signature index first** (`sigmap && sigmap …`, ~1.5s), so every answer is computed against the current tree. **Never call raw `sigmap ask`** — it reads a possibly-stale index. Always go through the `pnpm map:*` scripts.

- **`pnpm map:ask "<question>"` before ad-hoc grep/explore.** "Where is X handled," "what builds Y" — ranks the live signature index instead of guessing paths (verified: finds the right files spot-on here — `registry-link.ts`, `scoring.ts` for the relevant queries). Fall back to grep/Explore once it has narrowed the target, not as the first move.
- **`pnpm map:verify <answer.md>` on any AI-authored deliverable that cites specific files, functions, or symbols** — milestone reports, PR descriptions, docs updates. Flags fabricated references before they ship — the mechanical form of the governing rule's "never fabricate," applied to what *we* write about the code. Run it before finalizing.
- **`ast-grep run`/`ast-grep scan` for structural code search** — every call site of a changed signature, every implementation of a pattern ("every adapter's `parse` method," "every stage transition written without `confirmed`"), codebase-wide consistency checks. Use in place of text grep when the search is about code *structure*, not a literal string; the `ast-grep` skill has the rule syntax. Prefer this over sigmap's `--callers`/`--impact`, which are unreliable here (budget-capped call graph).
- **Pipe large or repeated command output through `sqz`** — test runs, build/migration logs, file dumps. The global PreToolUse hook makes this automatic; don't work around it.

The derived index (`.github/copilot-instructions.md`, `.context/`) is gitignored and NOT auto-loaded — it costs nothing at rest, and the `map:*` regen-first wrappers keep it fresh, so it never goes stale. Plain `pnpm map` just rebuilds it (rarely needed manually).

<!-- sigmap-creation-workflow:start -->
## Creation workflow (SigMap)

When creating or changing code, run the grounded-creation pipeline so each step is verified against the live index:

1. **`sigmap scaffold "<name>"`** — propose a convention-matched file/structure (refuses if conventions are inconsistent).
2. **`sigmap verify-plan <plan.md>`** — check the plan against the live index (files/symbols exist, blast radius, scope).
3. **`sigmap verify-ai-output <answer.md>`** — flag fake files/symbols/imports in the generated output (offline).
4. **`sigmap review-pr`** — audit the diff for scope drift, god-node edits, missing tests, and security files.

Or run all four in one pass with **`sigmap create "<task>"`** (`1/4`…`4/4` numbering, single pass/fail).

<sub>Generated by `sigmap --init` · refresh by re-running it.</sub>
<!-- sigmap-creation-workflow:end -->

<!-- BEGIN sqz-claude-guidance (auto-installed by sqz init; remove this block to disable) -->

## sqz — Context Compression (READ FIRST)

sqz is installed globally (machine-wide, not a repo dependency — built
from source via `cargo install sqz-cli sqz-mcp` since no prebuilt Windows
binary was available through this environment's proxy; requires the
`x86_64-pc-windows-gnu` Rust toolchain + WinLibs/MinGW-w64, not MSVC).
It compresses tool output so large files, long logs, and verbose command
output cost far fewer tokens.

### Active integration: Bash hook

`sqz init --global --only claude` wired a PreToolUse hook into
`~/.claude/settings.json` (verified present, alongside the project's
other hooks — merged, not overwritten). This is the integration that is
actually live; see below.

### Not yet wired: MCP server

`sqz-mcp` (the binary providing `sqz_read_file`/`sqz_grep`/`sqz_list_dir`
as MCP tools) is built and available at the path below, but **is not
registered with any client** — `sqz init` only wires the shell/Claude Code
hook, not an MCP server; registration is a separate, manual step this
project has not taken. Do not claim these tools are available until that
registration is actually done and verified — use the built-in `Read`/
`Grep`/`Glob` tools instead.

### Bash commands (hooked automatically)

When you run a shell command through the `Bash` tool, a PreToolUse hook
rewrites it to pipe output through `sqz compress`. This is transparent:
you don't need to remember to add anything, but it's useful to know
that these commands get compressed automatically:

```bash
git status           # → git status 2>&1 | sqz compress --cmd git
cargo test           # → cargo test 2>&1 | sqz compress --cmd cargo
docker ps            # → docker ps 2>&1 | sqz compress --cmd docker
kubectl get pods     # → kubectl get pods 2>&1 | sqz compress --cmd kubectl
```

The rewrite is skipped for interactive commands (`vim`, `ssh`,
`python`), compound commands (`a && b`, `a > file.txt`), and anything
already going through sqz.

### Escape hatch — when you see a `§ref:HASH§` token

If tool output contains a `§ref:a1b2c3d4§` token and you need the full
content it points at, resolve it:

- Shell: `sqz expand a1b2c3d4` (or paste the whole token
  `sqz expand §ref:a1b2c3d4§`) — binary at `C:\Users\<user>\.cargo\bin\sqz.exe`,
  on PATH in any fresh shell after install.
- To get uncompressed output for one command: prefix it with
  `SQZ_NO_DEDUP=1` (e.g. `SQZ_NO_DEDUP=1 git log | sqz compress`).

### When NOT to use sqz

- Writing or editing files — use the built-in `Write`/`Edit` tools.
  sqz has no write path (by design; see issue #5 follow-up).
- Running commands interactively or in watch mode.
- Reading very small files (<1KB) where compression can't help.

<!-- END sqz-claude-guidance -->
