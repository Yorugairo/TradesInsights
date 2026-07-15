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

Public market/trade pages; autonomous prospecting or outreach; bid submission, pricing, estimating, or legal commitments; cleaning-company intelligence (first release); bypassing authentication, CAPTCHA, MFA, paywalls, or access controls. Never scrape customer credentials.

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

- `source-adapter` — build and activate a source adapter (contract, checklist, fixtures, test gates).
- `project-resolution` — resolve records into the development/project/event graph.
- `evidence-gate` — evidence rules, AI contract, and the opportunity publication gate.
- `milestone-report` — the required milestone reporting format and exit-gate checklists.
