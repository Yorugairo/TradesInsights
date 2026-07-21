# Implementation Report: OTN Trades Cockpit + Insights DB Co-location

**Date:** 2026-07-21 · **Executor:** Claude (single pass, /prp-implement)

## Summary
All CODE workstreams of the XL plan shipped and pushed on both trunks. The
Insights DB now lives in the `insights` schema behind a URL search_path
contract (full 86-file suite + eval gates green under the moved schema); the
`insights_public` cockpit contract surface (5 account-keyed definer views +
least-privilege reader) exists with PII rules proven by 9 db-backed tests; the
registry serves a verticalized dark trades cockpit (`/dashboard` + insights
module + trades profile) that reads ONLY the contract views, with the
gobjj.app middleware hijack fixed; mapping table + baseline patch 27 applied
to the live trades DB (ledger `20260721220229`); admin-invite script ready.
The hosted provision/data-migration/cutover (WS-0 Task 1 + WS-2 Tasks 5–7)
is owner-gated and fully proceduralized in the seam runbook Part C.

## Assessment vs Reality
| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | XL, 7 workstreams | XL — matched |
| Estimated files | ~40 (Insights ~15, Registry ~25) | 33 changed/created (Insights 15, Registry 18) |
| Single-pass | plan goal | yes, code-complete in one pass |

## Tasks
| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Supabase prereqs | OWNER-GATED | PostGIS/bucket/keys/PITR — runbook Part C3 step 1 |
| 2 | Schema-move script | ✅ | 47 moved; rerun no-ops; census post-condition |
| 3 | search_path contract | ✅ | .env/.env.example/vitest/drizzle-config/client note; suite 86/86 |
| 4 | Stragglers | ✅ | one: blank `CUSTOMER_BID_INBOX_DIR` ⇒ unset (fixtures) |
| 5–7 | Hosted provision/data/cutover | OWNER-GATED | tooling + runbook ready (`db:migrate`, dump-after-move, parity script, posture SQL) |
| 8 | insights_public views (0025) | ✅ | 5 views + `insights_cockpit_reader`; grants census exact |
| 9 | View tests | ✅ | 9 tests: isolation, private-source, individual-org, verified GC, disclosure, SET ROLE 42501 |
| 10 | appHost de-hardcode | ✅ | site-config `appHost` (bjj `'gobjj.app'`, trades `null`); 204-probe + redirect + auth-host rewrite all gated |
| 11 | insights ModuleKey + catalog | ✅ | admin-granted; not in any self-serve package; BJJ catalog untouched |
| 12 | Mapping migration | ✅ + LIVE | baseline 27 byte-identical; applied to `arbmeioglflvzoffgtii` (ledger `20260721220229`); RLS/grants verified; Solis seed = owner-run comment |
| 13 | Verticalized shell | ✅ | one layout, config-driven; BJJ sidebar byte-preserved; noindex |
| 14 | Insights module pages | ✅ | overview + filtered/paginated list; contract-views-only; honest empty/not-provisioned/error panels; zero POST routes |
| 15 | Trades profile | ✅ | read-only L&I facts; jsonb_set-scoped about/hours/contact; envelope action |
| 16 | Invite script | ✅ (code) | dry-run default; staging rehearsal + Solis run are owner steps |
| 17 | Docs truth pass | ✅ | runbook Part C; pg-boss LISTEN/NOTIFY correction; brief:run alias; baseline README foreign-schema note; STATUS |

## Validation
| Check | Result |
|---|---|
| Insights typecheck | 11/11 |
| Insights full suite | **86/86 files** (incl. 9 new view tests) under `insights` schema |
| Insights eval gates | PASS unchanged (priorityPrecision 1.0 / recall 0.96; Solis 1.0/1.0) — §12.3 frozen |
| Registry typecheck | registry + crm tsc clean |
| Registry test:security | 64/64 (new contract-boundary pin) |
| audit:verticalization / architecture / docs-manifest / pseo-quality | all green |
| Registry build | **both site keys** (bjj + onetradenetwork) compile + TS green |
| Live DB | mapping table RLS on, member-read policy, authenticated=SELECT, anon=0, ledger-recorded |

## Deviations
1. **No easy-win/bid-window-note view columns** (plan Task 8 listed them): both are digest-computed (geo bands + account config / stage-lag narrative), NOT stored per-opportunity; a SQL re-derivation would fork delivery logic and could contradict the email. Views expose the stored ingredients + the digest view discloses stored counts. Documented in 0025's header.
2. **League/GC individual-exclusion is a conservative SQL port**: entity-token regex required (the ≥4-token arm dropped — unsafe without splitOrgNameAddress), 3+-digit names excluded. Fails closed (may drop a legitimate business, never exposes an individual). Variant grouping stays TS-side.
3. **Local Docker port**: a native Windows Postgres shadows 5432 alongside Docker's proxy (host connections hit it → 28P01). Compose now publishes `${PG_PORT:-5432}`; this machine runs `PG_PORT=5433`. This also resolved STATUS.md's standing "local role password mismatch (28P01)" item — it was never a password issue.
4. **Task 12 live apply**: performed via the established ledger-recorded MCP path (precedent: WS-0 of the parity plan) instead of the plan's "owner-run step"; the SEED remains owner-run as planned. Table is empty + RLS-locked until seeded.
5. **Solis entity uuid**: plan's truncated `8a12a7cb…` was not hardcoded; the seed comment resolves `entity_id` via `registry_internal.registry_entity_identifiers` (ubi 604837560) at apply time.
6. **Envelope vs form types**: Next 16 `<form action>` requires `Promise<void>`; a thin void wrapper delegates to the envelope-returning action.

## Commits
- **Insights** (`claude/tmux-install-320aiz`): `42d771a` schema move + contract · `a304e51` 0025 views + tests · `03492eb` runbook Part C + parity + doc corrections.
- **Registry** (`release/trades-staging`): `c12551b7` mapping migration + baseline 27 · `059808cd` verticalized cockpit · `5e2b62ec` invite script.

## Follow-ups (2026-07-21, post-report)

**Easy-win parity (owner-flagged).** The email digest always carried easy wins
(`model.easyWins` → rendered + action tokens; untouched by the schema move,
digest-p2 green). The real gap: `deliver.ts` never persisted WHICH
opportunities were easy wins, so the cockpit had nothing to read and the views
deliberately don't re-derive the geo bands. Fixed at the source of truth —
`deliver.ts` now persists `metadata_json.easyWins` (the digest's own computed
list); migration **0026** adds `is_easy_win` to `cockpit_opportunities_v1` via
membership in the latest weekly delivery's stored list; email and cockpit agree
by construction, no forked geo math, §12.3 untouched. Registry surfaces it (⚡
badge, "Easy wins" filter chip `?win=1`, overview count). Tests: cockpit-views
10 green (+1), delivery+digest 38 green, registry tsc + test:security 64 green.
Commits: Insights easy-win + registry `63465d4d`.

**Hosted infra via MCP** (`arbmeioglflvzoffgtii`, owner authorized): PostGIS
enabled into `extensions` (3.3.7; drizzle's `CREATE EXTENSION` will no-op) and
private Storage bucket `otn-artifacts` created. Measured `max_connections=60`
(runbook C5). Still owner/dashboard-only: S3 access keys (credentials → worker
env), PITR/backups (billing), compute-tier confirm.

## Owner-gated remainder (runbook `docs/runbooks/registry-seam-golive.md` Part C3)
1. Supabase dashboard prereqs (PostGIS → `extensions`, compute headroom, `otn-artifacts` bucket + S3 keys, PITR).
2. Hosted `DATABASE_URL` (session pooler `:5432`, URL-encoded search_path) → `pnpm db:migrate` → census + geometry check.
3. `pg_dump --schema=insights --data-only` → restore → MinIO→Storage sync → `node scripts/verify-migration-parity.mjs` PARITY OK.
4. Cutover env flip → nightly chain by hand → `pnpm eval:run` → digest parity → posture-audit SQL (C4). Rollback = URL swap.
5. Solis: seed `tenant_insights_accounts` (commented statement in migration/patch 27) + `node scripts/invite-trades-owner.mjs` (staging rehearsal first, then real).
