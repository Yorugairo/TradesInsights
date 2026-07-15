# Status

> The living one-pager. Update at the end of every working session and every completed task ID. Sessions are ephemeral — this file plus git history is the durable memory.

**Current task:** M1.1 (Lacey REST + project pages) — next up.
**Last completed:** M0 (all of M0.1–M0.6) — exit gate green, 2026-07-15.

## Milestone ledger

| Task | Status | Evidence |
|---|---|---|
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
- All live sources disabled pending per-source activation checklists (M1).
- `source:backfill` window is plumbed through `RunContext.backfill`; real checkpointed backfill logic lands with the first paginated adapter (M1.1).

## Pending calibration (spec §22 — gather from customers, unblocks M3 rule finalization)

- **Lacey:** King County coverage for At Home; builder appetite; minimum lots/units; apartment/townhome routing; product lead times; builder relationships.
- **Solis:** license renewal (registration researched through 2026-08-11 — recheck); detailed drywall/painting scope; capacity; min/ideal job size + geography; preferred/blocked GCs; public-work constraints; invitation platforms + authorized ingestion.

## Connections needed later

- M3: `ANTHROPIC_API_KEY` (and/or OpenAI) + `LLM_MONTHLY_BUDGET_USD`.
- M4/pilot ops: customer-authorized WEBS access, bid-inbox ingestion method, production SMTP.

## Tooling

- 2026-07-15: sigmap (code-signature grounding), sqz (command-output compression), and ast-grep (structural code search + outline) installed and made mandatory workflow tools — see CLAUDE.md "AI tooling (mandatory)" and `docs/operations.md` "AI tooling: sigmap, sqz, and ast-grep". No product-code impact.
