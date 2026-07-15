# Status

> The living one-pager. Update at the end of every working session and every completed task ID. Sessions are ephemeral — this file plus git history is the durable memory.

**Current task:** M1.3 (Lewis issued-permits PDF) — next up.
**Last completed:** M1.2 (Lewis current planning + canary) — both enabled, green, 2026-07-15.

## Milestone ledger

| Task | Status | Evidence |
|---|---|---|
| M1.0 shared infra (checkpoints, HTTP helper, HTML extraction) | ✅ 2026-07-15 | runner checkpoint round-trip tests; `packages/documents` html.ts |
| M1.1 Lacey REST + project pages | ✅ 2026-07-15 | 79+79 records live, 0 rejected, health green, idempotent rerun + 90-day backfill verified; ledger in source-policy.md |
| M1.2 Lewis current planning + canary | ✅ 2026-07-15 | 14 applications live + canary (4 official links incl. discovered SmartGov host), green, idempotent rerun verified |
| M0.1 workspace/apps/packages/lint/type/test | ✅ 2026-07-15 | `pnpm lint` / `pnpm typecheck` clean |
| M0.2 Docker Compose + .env.example | ✅ 2026-07-15 | `pnpm infra:up` — Postgres/PostGIS, MinIO, Mailpit |
| M0.3 schema/migrations/seed | ✅ 2026-07-15 | migration `0000_init` (20 tables), idempotent seed (18 sources, 3 accounts) |
| M0.4 object store + immutable artifacts | ✅ 2026-07-15 | content-addressed MinIO store, sha256 verified round-trip |
| M0.5 pg-boss jobs/retries/dead-letter/logs | ✅ 2026-07-15 | `apps/worker/test/jobs.test.ts` |
| M0.6 manifest loader + fixture harness | ✅ 2026-07-15 | `fake_source` adapter + fixtures |
| **M0 exit gate** | ✅ | `apps/worker/test/m0-exit-gate.test.ts` — 24/24 tests, E2E 1/1 |

## Open blockers

None.

## Assumptions in force

- Solis score-component weights are **provisional** placeholders (spec §12.3 forbids finalizing before calibration).
- Live sources are enabled one at a time as their activation checklists pass (ledger in `docs/source-policy.md`); Lacey REST + pages enabled 2026-07-15.
- Health volume-drop rule skips runs with `unchangedCount > 0` (hash-identical content is not a drop); required-field null-rate drop (spec §14) still needs per-run field instrumentation — tracked for M1 exit.
- Lacey REST exposes only the *current* project listing — "≥90-day backfill" for Lacey means the full current listing is ingested and the window filter is verified, not that delisted historical projects are recoverable.

## Pending calibration (spec §22 — gather from customers, unblocks M3 rule finalization)

- **Lacey:** King County coverage for At Home; builder appetite; minimum lots/units; apartment/townhome routing; product lead times; builder relationships.
- **Solis:** license renewal (registration researched through 2026-08-11 — recheck); detailed drywall/painting scope; capacity; min/ideal job size + geography; preferred/blocked GCs; public-work constraints; invitation platforms + authorized ingestion.

## Connections needed later

- M3: `ANTHROPIC_API_KEY` (and/or OpenAI) + `LLM_MONTHLY_BUDGET_USD`.
- M4/pilot ops: customer-authorized WEBS access, bid-inbox ingestion method, production SMTP.

## Tooling

- 2026-07-15: sigmap (code-signature grounding), sqz (command-output compression), and ast-grep (structural code search + outline) installed and made mandatory workflow tools — see CLAUDE.md "AI tooling (mandatory)" and `docs/operations.md` "AI tooling: sigmap, sqz, and ast-grep". No product-code impact.
- 2026-07-15: ECC (Everything Claude Code) curated install — 17 skills + 11 agents, **no hooks / no capture** (confirmed with user; ECC's global blocking/capture hooks deliberately excluded, plugin/`install.sh` path avoided). See CLAUDE.md "ECC skills and agents" and `docs/operations.md`. Project-scoped (`.agents/skills/`, `.claude/agents/`, `skills-lock.json`); every file read/scanned before use. No product-code impact; lint clean.
- 2026-07-15: Self-learning loop (custom, project-scoped) — after finding ECC's auto-learn hook is inert without per-call capture and its injector isn't separable, built a minimal Stop-extract + SessionStart-inject loop over `.claude/learned/LEARNED.md` (tracked). No per-call capture, fail-open, loop-guarded. `.claude/hooks/*`, `.claude/settings.json`; see `docs/operations.md` "Self-learning loop". Takes effect next session. No product-code impact.
