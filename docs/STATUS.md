# Status

> The living one-pager. Update at the end of every working session and every completed task ID. Sessions are ephemeral — this file plus git history is the durable memory.

**Current task:** M4.5 (P1 sources from measured coverage gaps). Model-verified automation is built and mock-tested; it activates with `ANTHROPIC_API_KEY` + `LLM_MONTHLY_BUDGET_USD`.
**Last completed:** M4.3 + M4.4 (controlled automation policy) — 2026-07-16.

## Milestone ledger

| Task | Status | Evidence |
|---|---|---|
| M1.0 shared infra (checkpoints, HTTP helper, HTML extraction) | ✅ 2026-07-15 | runner checkpoint round-trip tests; `packages/documents` html.ts |
| M1.1 Lacey REST + project pages | ✅ 2026-07-15 | 79+79 records live, 0 rejected, health green, idempotent rerun + 90-day backfill verified; ledger in source-policy.md |
| M1.2 Lewis current planning + canary | ✅ 2026-07-15 | 14 applications live + canary (4 official links incl. discovered SmartGov host), green, idempotent rerun verified |
| M1.3 Lewis issued-permits PDF | ✅ 2026-07-15 | golden 06-28 PDF (wrapped rows, applicant/contractor split); 16 PDFs → 385 permits, 90-day backfill + checkpoint rerun green |
| M1.4 Pierce environmental determinations | ⛔ blocked 2026-07-15 | Cloudflare challenge (non-bypassable); ledger records blocker + M1.8 mitigation |
| M1.5 King public notices | ✅ 2026-07-15 | 170 notices (155 with parcels), unincorporated-King jurisdiction, idempotent rerun green |
| M1.6 King monthly reports (Excel) | ✅ 2026-07-15 | 8 reports → 1,446 issued + 474 applications, header-keyed dual-layout parser, checkpoint rerun + backfill green |
| M1.7 Seattle Socrata ×2 + canary | ✅ 2026-07-15 | 2,117 building + 118 land-use (applieddate high-water; nightly-republish caveat), canary green, 90-day backfill green |
| M1.8 WA SEPA register | ✅ 2026-07-15 | official data.wa.gov dataset mmcb-z6jf (separ UI robots-restricted); 564 pilot-county records, rerun + backfill green; Pierce mitigation live |
| M1.9 Thurston active notices | ✅ 2026-07-15 | 63 project notices (accordion parser, migration-canary throw), idempotent rerun green |
| M1.10 Tumwater ArcGIS + pages | ✅/⛔ 2026-07-15 | ArcGIS: 44 projects, official status-domain stage map, green. review/SEPA pages: Akamai-blocked (ledger + mitigations) |
| **M1 exit gate** | ✅ 2026-07-15 | 13 sources enabled all green, 5,555 records, 83/83 tests + E2E, backfills verified, blockers documented |
| M2.1 resolution normalizers | ✅ 2026-07-15 | address/parcel/org/name/stage/geometry + extractFeatures; 13 unit tests |
| M2.2 exact/lineage/parcel matching | ✅ 2026-07-15 | migration 0001_resolution; live corpus: 4,986 projects, 571 merges, 377 multi-record projects, 0 errors; cross-source merges verified (SEPA↔Seattle MUP, King notices↔reports, Thurston↔SEPA, Lewis↔SEPA, Lacey REST↔pages) |
| M2.3 fuzzy/geospatial + review gates | ✅ 2026-07-16 | passes 4–5 (address+name, proximity+org, PostGIS ST_DistanceSphere ≤75m); §10 gates: same-address TI, generic names, fuzzy-without-support → review; resolver 0.3.0 |
| M2.4 development/phase hierarchy | ✅ 2026-07-16 | name-base grouping w/ permit-vocab distinctiveness guard + org/parcel/proximity support; plat-parents phases; 26 developments / 60 projects live; derived layer rebuildable |
| M2.5 merge-review/split workflow | ✅ 2026-07-16 | decideReview merge/reject (rejected candidates excluded from re-resolution), undoResolution keeps records + history, review CLI |
| M2.6 permit-cluster velocity | ✅ 2026-07-16 | one cluster_velocity signal per development (≥5 permits/90d) on the anchor project; idempotent until a newer permit; live corpus max cluster = 4/90d → correctly silent |
| **M2 exit gate** | ✅ 2026-07-16 | 0 records lost (5,553 resolved + 2 canaries by design); 377 evidence-backed cross-source projects; 31 developments; 10,412 events; review/undo workflow proven; 121/121 tests + E2E |
| M3.1 account profiles + versioned rules | ✅ 2026-07-16 | 3 seeded pilot accounts from account-profiles.yaml; append-only rule versioning (edit = version max+1); 3 integration tests |
| M3.2 routing + deterministic scoring | ✅ 2026-07-16 | pure §12 scorer (components 0–1 × raw integer weights = 0–100), distinct per-account routing proven on live corpus (4,982 projects → 2,343 opportunities; At Home 247 King-excluded / Commercial 1,007 / Solis 1,089); sticky manual states; `pnpm score:run` |
| M3.3 model extraction pipeline + budgets | ✅ 2026-07-16 | migration `0002_model_runs`; §13 Zod contract (unknown evidence IDs reject the run); Anthropic provider (official SDK, `claude-opus-4-8`, key-activated) + MockProvider; per-job + monthly budget blocks *before* spend; every attempt persisted with tokens/cost/latency/result hash; visible blocked state without keys; 17 tests (7 contract + 10 integration) |
| M3.4 independent verifier + publication gate | ✅ 2026-07-16 | verifier: second model pass, one verdict per fact vs its cited evidence (fabricated/missing verdicts reject); gate: all 9 §15 checks deterministic over stored rows (red-source suppression, A-grade core event, D-never/C-not-alone grades, pending-review contradiction, 180d timing, threshold, verifier verdict); live corpus: 988 digest-band opportunities → 986 `blocked_on_verifier` (correct without keys) + 2 honest identity fails (SEPA records with unmappable stage); 16 tests |
| M3.5 §16 UI + §17 APIs | ✅ 2026-07-16 | all §16 routes + §17 endpoints 1:1; pilot HMAC-cookie auth, account isolation enforced in the query layer and proven by E2E (cross-account read → 404, customer → admin API → 403); opportunity page: facts-vs-inferences, evidence w/ grades+retrieval dates, timeline, gate checks, next action, feedback/state controls; admin: sources (run enqueues pg-boss job, disable), run detail w/ dead letters, review merge/reject, coverage; 9/9 Playwright E2E |
| M3.6 idempotent weekly digest | ✅ 2026-07-16 | §18: 5 sections, gate-passing items only, withheld items disclosed in section 5; per-item what-changed/why-it-fits/facts/inferences/next-action/source-links; "new" = first-ever inclusion (delivery history), unchanged repeats never labeled new; idempotent per (account, week) incl. never re-sending; Mailpit send verified; live run: 3 drafts, 767 withheld pending verification (honest keyless state); 4 integration tests |
| M3.7 feedback + disposition reasons | ✅ 2026-07-16 | controlled disposition vocabulary enforced at the API (free-form rejected 400, proven E2E); dismiss/feedback forms use the vocabulary; per-account calibration rollup (rates incl. honest nulls when unanswered, disposition counts, per-route relevance) on /app/feedback + `pnpm feedback:report`; never auto-applied to rules; 3 integration tests + E2E |
| M3.8 reviewed samples per account | ✅ 2026-07-16 | `docs/pilot-samples.md`: 7 per account from the live corpus, every fact matched verbatim to stored A-grade evidence + source URL; 3 misses found and logged as §22 calibration items (turf-field wrong_trade at 85, min-job-size, cross-source unit-count discrepancy stated not resolved) |
| **M3 exit gate** | ✅ 2026-07-16 | zero unsupported facts (0 records w/o evidence, 0 live model claims, 0 delivered items, 0 bidding_confirmed); distinct routing proven incl. same project → different routes per account (7096544-CN: Commercial joint_review vs Solis radar); feedback loop complete (capture → controlled dispositions → rollup → versioned rule edit); pilot runs without spreadsheets (UI + review queue + digest + CLIs); 172/172 vitest + 9/9 E2E. Independent-verifier *execution* pending keys — publication correctly held at `blocked_on_verifier` |
| M4.1 eval harness + labeled set + holdout | ✅ 2026-07-16 | `fixtures/eval/eval-set.v1.jsonl`: 200 examples (125 positives: 50 AH / 25 LGC / 50 SI + 75 hard negatives), 150 dev / 50 holdout stratified; features + labeling clock frozen per example → deterministic replay; reviewer rejections auditable in `review-exclusions.v1.json`; `pnpm eval:build` / `pnpm eval:run`; 4 harness unit tests; baseline measured (precision 97.3% ✅ / recall 72.3% ❌ → M4.2) |
| M4.2 precision/recall/duplicate/expiry gates | ✅ 2026-07-16 | scorer v1.1.0: residential-glass trade recency (glass installs months after permit — 180d window), lot-count text parse → repeatable-units/scale, unknown-stage timing 0.5 (neutral, not worst-case guess), mechanical-replacement → non-interior trade, field-work-only ⇒ never Division 08 (M3.8 fix). Eval: dev 100%/96.8%, holdout 100%/93.5% (gates ≥90%/≥80%), 0 hard-negative leaks; duplicate/expired measured over stored deliveries via per-item metadata (`pnpm delivery:metrics`, 0/0 live; metric proven to detect fabricated violations); live re-score: AH 12 priority/153 digest (was 0/67) |
| M4.3+M4.4 controlled automation policy | ✅ 2026-07-16 | `gate/automation.ts` (policy v1.0.0): auto-include requires gate pass + independent verification all-supported + every fact ≥0.9 confidence + no missing critical facts; high-risk categories (deadline/actionable claim, ≥$5M, ambiguous routing, contact data, bidding_confirmed) ALWAYS human — the only override is a recorded human decision (promoted); withheld items go to the digest reviewQueue (stored in delivery metadata with reasons, count disclosed in section 5, never silently dropped); 7 policy unit tests + 3 digest integration tests |
| M0.1 workspace/apps/packages/lint/type/test | ✅ 2026-07-15 | `pnpm lint` / `pnpm typecheck` clean |
| M0.2 Docker Compose + .env.example | ✅ 2026-07-15 | `pnpm infra:up` — Postgres/PostGIS, MinIO, Mailpit |
| M0.3 schema/migrations/seed | ✅ 2026-07-15 | migration `0000_init` (20 tables), idempotent seed (18 sources, 3 accounts) |
| M0.4 object store + immutable artifacts | ✅ 2026-07-15 | content-addressed MinIO store, sha256 verified round-trip |
| M0.5 pg-boss jobs/retries/dead-letter/logs | ✅ 2026-07-15 | `apps/worker/test/jobs.test.ts` |
| M0.6 manifest loader + fixture harness | ✅ 2026-07-15 | `fake_source` adapter + fixtures |
| **M0 exit gate** | ✅ | `apps/worker/test/m0-exit-gate.test.ts` — 24/24 tests, E2E 1/1 |

## Open blockers

- **M1.4 pierce_environmental_determinations:** piercecountywa.gov serves a site-wide Cloudflare browser challenge (403) to this execution environment regardless of user agent; solving it would mean bypassing an anti-bot control — prohibited. Source stays disabled; blocker + mitigation (Pierce SEPA coverage via M1.8 wa_sepa) recorded in the activation ledger. Re-verify from an unchallenged network (production runner / customer connection).
- **M1.10 tumwater_development_review + tumwater_sepa:** ci.tumwater.wa.us is Akamai-edge-denied (403, all clients) from this environment — same policy class as Pierce. Both stay disabled; mitigations: tumwater_development_arcgis (projects + official status) and wa_sepa (Tumwater-lead-agency determinations). Re-verify from an unchallenged network.

## Assumptions in force

- Solis score-component weights are **provisional** placeholders (spec §12.3 forbids finalizing before calibration).
- Live sources are enabled one at a time as their activation checklists pass (ledger in `docs/source-policy.md`); Lacey REST + pages enabled 2026-07-15.
- Health volume-drop rule skips runs with `unchangedCount > 0` (hash-identical content is not a drop); required-field null-rate drop (spec §14) still needs per-run field instrumentation — tracked for M1 exit.
- Lacey REST exposes only the *current* project listing — "≥90-day backfill" for Lacey means the full current listing is ingested and the window filter is verified, not that delisted historical projects are recoverable.
- The runner's unchanged-artifact skip keys on content hash only: a parser upgrade does not reprocess already-stored artifacts until their content changes. Stored-artifact reprocessing (replay by parserVersion) is a future capability — not required by M1.
- Fuzzy passes 4–5 apply to records resolved after M2.3 (resolver 0.3.0); the M2.2-era corpus was resolved with passes 1–3 only. Retroactive project-level duplicate candidates surface through the M2.5 merge-review workflow, not by re-running the resolver.
- **Divergence of record:** `cluster_velocity` extends the spec §9 event list — §21 M2.6 requires velocity events but §9 doesn't enumerate a type for them. Documented in taxonomy.ts, data-dictionary, architecture.
- M2.6 backfill: type-specific events (permit_issued/application_submitted/…) were backfilled for the M2.2-era corpus (4,859 events) — createProject originally emitted only project_first_seen; it now also emits the creating record's own event.

## Pending calibration (spec §22 — gather from customers, unblocks M3 rule finalization)

- **Lacey:** King County coverage for At Home; builder appetite; minimum lots/units; apartment/townhome routing; product lead times; builder relationships.
- **Solis:** license renewal (registration researched through 2026-08-11 — recheck); detailed drywall/painting scope; capacity; min/ideal job size + geography; preferred/blocked GCs; public-work constraints; invitation platforms + authorized ingestion.
- **From M3.8 sample review** (`docs/pilot-samples.md`): division_08 trade_fit needs a negative filter for site/field work (turf field scored 85); minimum-job-size floors would demote low-valuation SFR permits and STFI residential remodels; briefs must present both citations when sources disagree on unit count (41st Ave: 198 vs 180).

## Connections needed later

- M3: `ANTHROPIC_API_KEY` (and/or OpenAI) + `LLM_MONTHLY_BUDGET_USD`.
- M4/pilot ops: customer-authorized WEBS access, bid-inbox ingestion method, production SMTP.

## Tooling

- 2026-07-15: sigmap (code-signature grounding), sqz (command-output compression), and ast-grep (structural code search + outline) installed and made mandatory workflow tools — see CLAUDE.md "AI tooling (mandatory)" and `docs/operations.md` "AI tooling: sigmap, sqz, and ast-grep". No product-code impact.
- 2026-07-15: ECC (Everything Claude Code) curated install — 17 skills + 11 agents, **no hooks / no capture** (confirmed with user; ECC's global blocking/capture hooks deliberately excluded, plugin/`install.sh` path avoided). See CLAUDE.md "ECC skills and agents" and `docs/operations.md`. Project-scoped (`.agents/skills/`, `.claude/agents/`, `skills-lock.json`); every file read/scanned before use. No product-code impact; lint clean.
- 2026-07-15: Self-learning loop (custom, project-scoped) — after finding ECC's auto-learn hook is inert without per-call capture and its injector isn't separable, built a minimal Stop-extract + SessionStart-inject loop over `.claude/learned/LEARNED.md` (tracked). No per-call capture, fail-open, loop-guarded. `.claude/hooks/*`, `.claude/settings.json`; see `docs/operations.md` "Self-learning loop". Takes effect next session. No product-code impact.
