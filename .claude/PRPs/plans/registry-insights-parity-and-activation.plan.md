# Plan: Registry ⇄ Insights — Competitive Parity, Easy-Win Activation & First-Class Pre-Permit Layer

## Summary
A single cross-repo plan that brings OTN Insights to competitive parity with Shovels.ai and Building Radar and closes the last-mile activation gaps, executed across **two repos together**: the Trades **Registry** (`C:\Users\Snipe\Downloads\WA JiuJitsu Registry-20260608T183757Z-3-001`, branch `release/trades-staging`) and **Insights** (`C:\Users\Snipe\Downloads\TradesInsights`, branch `claude/tmux-install-320aiz`). It captures the live-only registry contract drift into source control, wires Insights to consume the enriched contract (verified GC phone + rating + trade codes), surfaces "who do I call" on every opportunity, fires urgent phase-change alerts, adds outreach templates + a Charlie-style NL assistant on the existing LLM brief layer, ships a CRM/webhook + CSV export tier, formalizes a first-class pre-permit "Decisions" layer with new verify-first early feeds, and documents the six env-gated easy-win activations.

## User Story
As a **Solis Interiors estimator (and OTN's other trade-sub accounts)**, I want **the weekly digest and alerts to tell me exactly which projects are winnable right now, who the decision-maker is with a verified phone, a ready-to-send intro, and a way to push those into my CRM — plus earlier pre-permit signals than anyone else** so that **I can start relationships and bid before competitors even know the project exists, without leaving my weekly cadence.**

## Problem → Solution
**Current state:** The registry seam, LLM briefs, bid-inbox, and digest are built but dark or partial — verified GC contact is un-wired to delivery, there are no phase-change/urgent alerts, no outreach drafts, no NL query, no CRM export, and pre-permit signals live in an un-labeled "radar" footnote. The enriched 25-col registry contract view exists only in the live DB (uncommitted drift). → **Desired state:** the enriched contract is captured and consumed; every opportunity carries a verified decision-maker + phone + draft intro; urgent alerts fire when a commercial project enters its bid window; a conversational assistant answers "what's winnable in Thurston this week?"; pursued opportunities export to any CRM by webhook/CSV; and a first-class pre-permit "Decisions" layer with new verify-first feeds makes OTN the earliest credible signal in-region.

## Metadata
- **Complexity**: **XL** (two repos, ~9 workstreams, 40+ files). **Execute workstream-by-workstream** — each WS is independently shippable behind its own validation gate. Do NOT attempt in one pass.
- **Source PRD**: N/A (free-form competitive-research directive; sibling to `.claude/PRPs/plans/registry-insights-dataflow-solis-inference.plan.md`)
- **PRD Phase**: N/A
- **Estimated Files**: ~44 (Registry: 5 · Insights: ~39)
- **Recommended sequence**: WS-0 → WS-A → WS-B → WS-C → WS-E → WS-D → WS-F → WS-G (WS-A activations run in parallel with all code work; WS-G is the largest and independent).

---

## Governance Constraints (READ FIRST — these override convenience at every task)

These are standing, owner-set constraints. Every task below inherits them.

1. **§12.3 — scoring weights are FROZEN** until Solis confirms scope in the calibration session. New scoring inputs must be **score-neutral**: push into `signals[]` (or an *unweighted* `components` entry), never add an account weight. The scorer is `SCORING_ALGORITHM_VERSION = "1.9.0"`; do not bump it for a neutral signal. The eval harness asserts neutrality — keep it green.
2. **No bot-bypass sourcing.** Never defeat Akamai/WAF/Exago `eid`/CAPTCHA/auth/paywalls. New gated sources are **capture-fed** (parse genuine-browser bytes staged under `$OTN_CAPTURE_DIR/<key>/`), `cadence: on_demand`, run via `pnpm source:run:operator-local`.
3. **Verify-first source activation** (source-adapter skill, 9 steps): confirm live publisher today, record access URL/format/cadence in `config/sources.yaml`, review robots/terms, capture fixtures, define fields, implement parser + failure fixtures, manual row/count compare, shadow mode, enable only after health tests pass. Ship new adapters `enabled: false`.
4. **No fabricated source fields.** Unknown = `null`, never guessed, never zero. Every record keeps `county` + `permittingJurisdiction`.
5. **Person-vs-business gate.** Homeowner/individual PII must never cross into the registry bridge or a public surface. The registry↔Insights bridge is business entities only.
6. **Least-privilege registry access.** Insights **reads** `registry_public.*` only and **writes** `registry_partner.*` staging only. `otn_insights_reader` (NOLOGIN grant holder) gets `SELECT` on views; `otn_insights` login inherits reader+writer. Never read `registry_internal.*` from Insights. L&I phone stays authoritative (`phone_write_policy = 'lni_phone_authoritative'`); Google phone is a *secondary surfaced* contact, never an overwrite.
7. **No secrets in the repo.** Connection strings, service keys, API keys, webhook URLs, inbound-email secrets — env/config only. `.env` is gitignored.
8. **Registry is another party's production data.** Registry DDL is additive under the `_v1` contract (a breaking change mints `_v2`); every migration has a byte-equivalent `db/baseline-v1.2/NN_*.sql` mirror.
9. **Commit → push immediately** on each repo's trunk after each task group (Codex/GPT handoff depends on `origin`). **Never target `main`**; trunks are `release/staging`/`release/trades-staging` (registry) and `claude/tmux-install-320aiz` (Insights). Git attribution is disabled — no `Co-Authored-By` trailer.
10. **Outbound only to customer-configured destinations.** Export webhooks post only to a URL the account owner configured in their account config — never a URL discovered in observed content (email, permit doc, web page).
11. **This is a planning artifact.** No implementation until the user confirms. `/prp-implement` executes it WS-by-WS.

---

## UX Design

### Before
```
Weekly digest (HTML email)
┌───────────────────────────────────────────────┐
│ ⚡ Winnable now · 🤝 GCs worth meeting (name)   │
│ ⏰ Deadlines (date — title (GC name))           │
│ 1. Priority new opportunities                   │
│    Project · stage · county · score 88          │
│    Brief… What changed… Why it fits… Next step  │
│    [no phone] [no verified badge] [no intro]    │
│ 2. Stage changes  3. Missing facts  4. Monitor  │
│ 5. Coverage & source health                     │
│ (pre-permit signals buried in "4. Monitoring")  │
└───────────────────────────────────────────────┘
Alerts: spend_budget · source_red · source_stale · delivery_unsent   (ops-only, no opportunity alerts)
No NL query · No CRM export · No outreach draft
```

### After
```
Weekly digest (HTML email)
┌───────────────────────────────────────────────┐
│ ⚡ Winnable now · 🤝 GCs worth meeting           │
│    ▸ Acme Builders ✓verified · ☎ (360) 555-0148 │
│ 🧭 Decisions radar (pre-permit, first-class)     │
│    ▸ Entitlement approved · bid window opens ~8w │
│ ⏰ Deadlines (date — title (GC ✓ ☎))            │
│ 1. Priority new opportunities                   │
│    Project · stage · county · score 88          │
│    Brief… Bid window: OPEN … Why it fits…        │
│    GC: Acme Builders ✓verified ☎ (360) 555-0148 │
│    ✍ Draft intro: "Hi Acme, we're a Thurston…"  │
│    Next step · [Export to CRM] · Sources         │
└───────────────────────────────────────────────┘
Alerts: + phase_change (urgent: commercial project entered plan-review / high-score new opp)
Assistant: POST /api/app/assistant → "3 winnable in Thurston this week: …"
Export: CSV + webhook POST of pursued opportunities (HubSpot-compatible JSON)
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Opportunity row | name/stage/score/brief only | + verified GC phone + ✓ badge + draft intro + Export button | WS-B, WS-D, WS-E |
| 🤝 GCs worth meeting | GC name only | + ✓verified + ☎ phone + rating | WS-B |
| ⏰ Deadlines | date — title (GC name) | + GC ✓ ☎ | WS-B |
| Pre-permit signals | buried in Monitoring | first-class 🧭 Decisions radar + bid-window context | WS-G |
| Alerts | 4 ops types | + `phase_change` urgent (opportunity-scoped) | WS-C |
| NL query | none | conversational assistant grounded in verified facts | WS-F |
| CRM | none | webhook + CSV export of pursued opportunities | WS-D |

---

## Mandatory Reading

### Insights (`C:\Users\Snipe\Downloads\TradesInsights`)
| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `packages/resolution/src/registry-link.ts` | 20-266 | Contract reader (`RegistryIdentityRow`, `fetchRegistryIdentityRows` SELECT, `identitySnapshot`, `linkRegistry`) — extend for 4 new columns (WS-B) |
| P0 | `packages/resolution/src/registry-observations.ts` | 45-89, 252, 712-724 | Observation taxonomy + trust gate + the `public_business` contact-adoption side-effect to mirror for `google_phone` (WS-B) |
| P0 | `packages/intelligence/src/scoring.ts` | 36, 207-251, 464-552 | Version, `weighted()`/`band()`, `routeSolis` signal-assembly, §12.3 neutrality mechanism (WS-B) |
| P0 | `packages/delivery/src/digest.ts` | 30-113, 144-247, 468, 552-576 | `DigestItem`/`RelationshipPlay`/`DeadlineItem`, `easyWin*`, `upcomingDeadlines`, `RADAR_STAGES`, `buildDigest` (WS-B, WS-G) |
| P0 | `packages/delivery/src/render.ts` | 123-262 | `itemHtml`, `topBlock`, `renderDigestHtml` — where phone/badge/intro/Decisions render (WS-B, WS-E, WS-G) |
| P0 | `packages/intelligence/src/brief.ts` | 76-299 | Brief menu/prompt/provider/budget/persist triad — reuse for outreach + assistant (WS-E, WS-F) |
| P0 | `packages/delivery/src/alerts.ts` | 15-181 | `AlertCandidate` union, `evaluateAlertConditions`, `runAlerts` idempotency (WS-C) |
| P1 | `packages/intelligence/src/org-activity.ts` | 36-82, 123, 203 | `OrgActivityRow` + rollup SELECT + `relationshipTargets` — carry phone/verified (WS-B) |
| P1 | `packages/intelligence/src/bid-window.ts` | 20-225 | `bidTrackFor`, `COMMERCIAL_BUYOUT_STAGES`, `tradeBidWindow` — trigger for phase-change alerts + Decisions (WS-C, WS-G) |
| P1 | `packages/domain/src/normalized-record.ts` | 26-70 | `NormalizedSourceRecordSchema` (`normalizedStage`) — new adapters emit pre-permit stages (WS-G) |
| P1 | `packages/domain/src/taxonomy.ts` | 4-40 | `PROJECT_STAGES` + `EVENT_TYPES` — pre-permit already enumerated (WS-G) |
| P1 | `packages/source-sdk/src/types.ts` | 7-100 | `SourceAdapter` contract for new feeds (WS-G) |
| P1 | `packages/adapters/src/olympia-smartgov-reports.ts` | 201-540 | Capture-fed adapter + `checkInvariants` reconciliation to mirror (WS-G) |
| P1 | `apps/web/lib/api.ts` | 19-60 | `withAccount`/`guard`/`jsonError` wrapper for new routes (WS-D, WS-E, WS-F) |
| P1 | `apps/web/app/api/app/opportunities/[id]/regenerate-memo/route.ts` | all | Exact mirror for model-calling account-scoped POST (WS-E, WS-F) |
| P1 | `apps/worker/src/schedules.ts` | 82-98, 140-158, 277-339 | Schedulable/operator-local sources, alerts wiring, dead-letter + source-run registration (WS-C, WS-G) |
| P2 | `packages/config/src/account-config.ts` | 46-81 | `easy_win`/`radius_bands_mi`, `AccountProfileSchema` — export webhook config lands here (WS-A, WS-D) |
| P2 | `packages/intelligence/src/invitations.ts` | 53-124 | `ingestInvitation` → `bid_invitations` (bid-inbox activation reference, WS-A) |
| P2 | `apps/worker/test/digest.test.ts`; `packages/delivery/src/digest.test.ts`; `apps/worker/test/alerts.test.ts`; `packages/intelligence/src/scoring.test.ts` | all | Test harnesses to copy (all WS) |

### Registry (`C:\Users\Snipe\Downloads\WA JiuJitsu Registry-…`, branch `release/trades-staging`)
| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `apps/registry/supabase/migrations/20260719091458_registry_public_trades_identity_v1.sql` | 18-71 | Committed view body + `otn_insights_reader` role/grant idiom to extend (WS-0) |
| P0 | `apps/registry/supabase/migrations/20260719120000_surface_registered_address_in_trades_identity_v1.sql` | 29-47 | Additive `CREATE OR REPLACE VIEW` precedent (21-col state = the base to re-capture from) (WS-0) |
| P0 | `db/baseline-v1.2/23_registry_public_contract.sql`; `db/baseline-v1.2/README.md` | all | Baseline mirror + manifest table + psql apply loop (WS-0) |
| P1 | `db/baseline-v1.2/20_google_external_profiles.sql` | 13-90 | `registry_entity_external_profiles`/`_links` shape + `public_surface_policy`/`phone_write_policy` gates (WS-0 provenance) |
| P1 | `apps/registry/scripts/entity-resolution/trades-taxonomy-map.mjs` | 24-127 | `TAXONOMY_SEED`, `normalizeSpecialty`, `PATTERN_INDEX` — reconcile assignment provenance (WS-0) |
| P1 | `apps/registry/scripts/entity-resolution/assign-license-trades.mjs` | 19-82 | Assignment upsert + run idiom (`DATABASE_URL=… node … --dry-run`) (WS-0) |
| P1 | `db/baseline-v1.2/18_entity_resolution.sql` | 333-360 | `registry_trade_taxonomy`/`registry_trade_assignments` DDL (WS-0) |
| P2 | `apps/registry/supabase/migrations/20260720093000_registry_public_trades_taxonomy_v1.sql` | 5-41 | `trades_taxonomy_v1` + baseline-twin header convention (WS-0) |

## External Documentation
| Topic | Source | Key Takeaway |
|---|---|---|
| Pre-permit "Decisions" layer | Shovels.ai product ("Decisions") | Formalize planning approvals / hearing agendas as a first-class signal upstream of permits — OTN's bid-timing edge |
| Conversational query | Shovels "Charlie" AI assistant | NL over the dataset; OTN reuses the existing grounded brief layer (facts-only, cite refIds) |
| AI lead scoring + phase-change alerts + CRM sync + contact discovery | Building Radar | Parity checklist: verified decision-maker + phone on every lead, alert on phase change, push to CRM, pre-drafted outreach |
| Upstream (title/rezoning) signals | Mercator.ai (https://www.mercator.ai/) | The one place a rival is "earlier" than permits; region-limited today — OTN's opening is WA title/rezoning/land-use feeds as **new Insights sources** |
| pg-boss v10 queues/dead-letter | in-repo `apps/worker/src/schedules.ts:277-303` | Dead-letter queue must be created before a queue references it (`deadLetter: SOURCE_RUN_DEAD_LETTER`) |
| PostGIS distance | in-repo `packages/delivery/src/digest.ts:183` | `ST_DistanceSphere(ST_Centroid(geometry), home)` — reuse for any geo gating |

**RESEARCH NOTE:** No further external research needed for implementation — every mechanism is an established internal pattern. The competitor references are product-framing only; do not copy any competitor code or scrape their data.

---

## Patterns to Mirror

Real snippets captured from the codebase. Follow exactly.

### CONTRACT_READER (extend the SELECT + row-map + type)
```ts
// SOURCE: packages/resolution/src/registry-link.ts:180 (Insights)
export async function fetchRegistryIdentityRows(pool: RegistryPoolLike): Promise<RegistryIdentityRow[]> {
  const res = await pool.query(
    `SELECT entity_id, ubi, contractor_numbers, canonical_name, canonical_name_normalized,
            phone, city_token, state_code, registered_address, registered_postal_code,
            status, record_count, root_domain, first_minted_at
       FROM registry_public.trades_identity_v1`,
  );
  return res.rows.map((r: Record<string, unknown>) => ({
    entityId: r["entity_id"] as string,
    ubi: (r["ubi"] as string | null) ?? null,
    // … one explicit-cast line per column …
  }));
}
```

### CONTACT_ADOPTION_SIDE_EFFECT (mirror for google_phone → organization_contacts)
```ts
// SOURCE: packages/resolution/src/registry-observations.ts:717 (Insights)
await db.execute(sql`
  INSERT INTO organization_contacts (organization_id, account_profile_id, name, role, phone, source_type)
  SELECT ${row.organization_id}, NULL, ${registryName}, 'L&I registered phone', ${phone}, 'public_business'
  WHERE NOT EXISTS ( ... )`);
```
`accountProfileId = NULL` + `source_type = 'public_business'` = a GLOBAL verified contact (migration 0020). Google phone reuses this exactly with role `'Google Business phone'`, and only when the L&I `phone` is absent (L&I stays authoritative).

### SCORE_NEUTRAL_SIGNAL (§12.3 — push into signals[], no weight)
```ts
// SOURCE: packages/intelligence/src/scoring.ts:474 (Insights) — routeSolis
if (f.orgs.some((o) => o.registryVerified &&
    ["primary_contractor", "applicant", "owner"].includes(o.role ?? ""))) {
  signals.push("verified_gc_on_project");
}
// New gc_quality / trade_match signals attach HERE, same shape, NO account weight.
```
Guarded by the neutrality test: `expect(withVerified.score).toBe(noOrg.score)` (`scoring.test.ts:609`).

### ALERT_EMISSION (idempotent, ON CONFLICT DO NOTHING)
```ts
// SOURCE: packages/delivery/src/alerts.ts:98 + :163 (Insights)
candidates.push({ alertType: "source_red", subjectKey: s.key, severity: "critical",
  message, details: { ... }, idempotencyKey: `source_red:${s.key}:${day}` });
// runAlerts:
await db.execute(sql`INSERT INTO alerts (alert_type, subject_key, severity, message, details_json, idempotency_key)
  VALUES (...) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`);
```

### MODEL_JOB_TRIAD (provider + budget + persistModelRun; never throws)
```ts
// SOURCE: packages/intelligence/src/brief.ts:210-231 (Insights)
const budget = await checkBudget(db, opts.budget, estimated);
if (!budget.allowed) { /* persistModelRun status:"blocked"; return {status:"blocked", ...} */ }
try {
  const resp = await provider.complete({ system: SYSTEM_PROMPT, prompt, maxTokens: MAX_OUTPUT_TOKENS });
  /* validate contract → persistModelRun status:"succeeded" */
} catch (err) { /* persistModelRun status:"error"; return {status:"error", ...} — never throw */ }
```
Provider resolution: `providerFromEnv()` (OpenRouter key wins, else Anthropic, else `null`); no key ⇒ `blocked`, never unlimited. `MockProvider` is the deterministic no-key test double.

### ACCOUNT_SCOPED_ROUTE (mirror for /assistant, /outreach, /export)
```ts
// SOURCE: apps/web/app/api/app/opportunities/[id]/regenerate-memo/route.ts (Insights)
export const POST = withAccount<{ id: string }>(async ({ db, account, params }) => {
  const built = await buildDecisionMemo(db, params.id);
  if (!built || built.accountProfileId !== account.id) return jsonError(404, "opportunity not found");
  // … call intelligence layer, return NextResponse.json(...)
});
```

### SOURCE_ADAPTER (capture-fed, verify-first)
```ts
// SOURCE: packages/adapters/src/olympia-smartgov-reports.ts:201 + :460 (Insights)
export class OlympiaSmartgovReportsAdapter implements SourceAdapter {
  readonly key = "olympia_smartgov_reports";
  readonly parserVersion = "1.1.0";
  // parse() emits: { record: NormalizedSourceRecord{ normalizedStage, applicationDate|issueDate, organizations, evidence }, rawFields }
  // fetch() reads captured bytes from $OTN_CAPTURE_DIR/<key>/ when live gate is bot-protected
}
```
Pre-permit stages already exist — new adapters emit `normalizedStage ∈ {preapplication, entitlement, approved, construction_documents}`; no new enum.

### REGISTRY_MIGRATION (additive view + baseline mirror + re-grant)
```sql
-- SOURCE: apps/registry/supabase/migrations/20260719120000_surface_registered_address_in_trades_identity_v1.sql (Registry)
-- Header names the byte-equivalent db/baseline-v1.2/NN twin. Keep both identical.
BEGIN;
CREATE OR REPLACE VIEW registry_public.trades_identity_v1 WITH (security_invoker = false) AS
  SELECT … , nr.address_normalized AS registered_address, … ;
GRANT SELECT ON registry_public.trades_identity_v1 TO otn_insights_reader;
COMMIT;
```

### REGISTRY_SCRIPT (run idiom + pool)
```js
// SOURCE: apps/registry/scripts/entity-resolution/db.mjs:12 + assign-license-trades.mjs:19 (Registry)
// Usage: DATABASE_URL=postgres://... node scripts/entity-resolution/assign-license-trades.mjs [--dry-run] [--limit=N]
export function makePool(databaseUrl = process.env.DATABASE_URL) { /* ssl off for localhost, max:4 */ }
```

### TEST_STRUCTURE (integration harness)
```ts
// SOURCE: apps/worker/test/digest.test.ts:23 (Insights)
import { MockProvider, extractProject } from "@otn/intelligence";
import { buildDigest, deliverDigest, renderDigestHtml } from "@otn/delivery";
const BUDGET = { monthlyCapUsd: 100, perJobCapUsd: 0.5 };
// testDb()/resetSource() (apps/worker/test/helpers.ts) runs drizzle migrate; seed via drizzle client; assert on model + rendered HTML.
```
Pure-unit precedent (no DB): `packages/delivery/src/digest.test.ts` uses `Partial`-override factories + `expect().toBe()`.

---

## Files to Change

### WS-0 — Registry contract durability (Registry repo, `release/trades-staging`)
| File | Action | Justification |
|---|---|---|
| `apps/registry/supabase/migrations/<UTC>_surface_google_and_trades_in_trades_identity_v1.sql` | CREATE | Capture the live 25-col view (google_phone/rating/review_count/trade_codes) + re-grant reader |
| `db/baseline-v1.2/26_registry_public_trades_identity_v1_enrichment.sql` | CREATE | Byte-equivalent baseline mirror |
| `db/baseline-v1.2/README.md` | UPDATE | Add row to manifest table (or `audit:docs-manifest` fails) |
| `apps/registry/scripts/entity-resolution/assign-license-trades.mjs` (+ `trades-taxonomy-map.mjs`) | VERIFY/UPDATE | Reconcile & commit the provenance that produced the 24,669 live assignments (see Task 0.2) |
| `docs/runbooks/registry-seam-golive.md` | UPDATE | Note the enrichment migration + re-capture step |

### WS-B — Consume enriched contract + verified GC contact + neutral signals (Insights)
| File | Action | Justification |
|---|---|---|
| `packages/resolution/src/registry-link.ts` | UPDATE | Add 4 fields to `RegistryIdentityRow` + SELECT + row-map + `identitySnapshot` |
| `packages/resolution/src/registry-observations.ts` | UPDATE | Add `google_phone` adoption + `trade_codes` observation (mirror `phone_adoption`/`trade_export`) |
| `packages/intelligence/src/org-activity.ts` | UPDATE | `OrgActivityRow` + rollup SELECT carry `phone` + `verifiedAt` + `rating` |
| `packages/intelligence/src/scoring.ts` | UPDATE | Add score-neutral `gc_quality` + `trade_match` signals in `routeSolis` |
| `packages/delivery/src/digest.ts` | UPDATE | `RelationshipPlay`/`DeadlineItem`/`DigestItem` carry GC phone+verified; `upcomingDeadlines` SELECT |
| `packages/delivery/src/render.ts` | UPDATE | Render ✓ badge + phone in `itemHtml`, 🤝 block, ⏰ block |
| tests: `registry-link.test.ts`, `registry-observations.test.ts`, `scoring.test.ts`, `apps/worker/test/digest.test.ts` | UPDATE | Cover new fields + neutrality invariant + rendered badge |

### WS-C — Phase-change urgent alerts (Insights)
| File | Action | Justification |
|---|---|---|
| `packages/delivery/src/alerts.ts` | UPDATE | Add `phase_change` alert type + `evaluateAlertConditions` query over `project_events` × opportunities |
| `packages/delivery/src/alerts.test.ts` / `apps/worker/test/alerts.test.ts` | UPDATE | Emission + idempotency + threshold gating |

### WS-D — CRM/webhook + CSV export tier (Insights, greenfield)
| File | Action | Justification |
|---|---|---|
| `packages/delivery/src/export.ts` | CREATE | `exportPursuits(db, accountProfileId, opts)` → CSV + webhook POST (HubSpot-compatible JSON) |
| `packages/delivery/src/export.test.ts` | CREATE | Serialization + mocked webhook + account isolation |
| `packages/config/src/account-config.ts` | UPDATE | Add optional `export` block (webhook_url, format) to `AccountProfileSchema` |
| `apps/worker/src/cli/export-run.ts` | CREATE | `pnpm export:run` CLI |
| `apps/web/app/api/app/pursuits/export/route.ts` | CREATE | `GET withAccount ?format=csv` download (mirror organizations route) |

### WS-E — Outreach templates (Insights)
| File | Action | Justification |
|---|---|---|
| `packages/intelligence/src/outreach.ts` | CREATE | `generateOutreach(db, provider, opportunityId, opts)` — brief-layer twin, job_type `outreach_draft` |
| `packages/intelligence/src/outreach.test.ts` | CREATE | MockProvider draft + budget-blocked path |
| `packages/delivery/src/render.ts` | UPDATE | Render "✍ Draft intro" block in `itemHtml` |
| `apps/web/app/api/app/opportunities/[id]/outreach/route.ts` | CREATE | POST mirror of regenerate-memo |

### WS-F — NL assistant (Insights)
| File | Action | Justification |
|---|---|---|
| `packages/intelligence/src/assistant.ts` | CREATE | NL→structured-filter planner + grounded answer over account-scoped opportunities |
| `packages/intelligence/src/assistant.test.ts` | CREATE | NL→filter mapping (deterministic) + grounded MockProvider answer + isolation |
| `apps/web/app/api/app/assistant/route.ts` | CREATE | POST mirror of regenerate-memo |
| `apps/worker/src/cli/assistant-run.ts` | CREATE | `pnpm assistant:run` for batch/testing |

### WS-G — First-class pre-permit "Decisions" layer + new feeds (Insights)
| File | Action | Justification |
|---|---|---|
| `packages/delivery/src/digest.ts` | UPDATE | Promote `RADAR_STAGES` block to labeled "🧭 Decisions" section with bid-window context |
| `packages/delivery/src/render.ts` | UPDATE | Render the Decisions section |
| `packages/adapters/src/olympia-lacey-preapp.ts` | CREATE | Pre-application feed adapter (capture-fed, pre-permit stages) |
| `packages/adapters/src/thurston-hearing-examiner.ts` | CREATE | Hearing-examiner agenda/decision adapter |
| `packages/adapters/src/seattle-design-review.ts` | CREATE | Seattle DRB adapter |
| `packages/adapters/src/thurston-landuse-rezone.ts` | CREATE | Pilot title/rezoning/land-use signal source (verify-first) |
| `packages/adapters/src/index.ts` | UPDATE | Register new adapters |
| `config/sources.yaml` | UPDATE | Declare new feeds `enabled: false`, robots/terms review, cadence |
| `fixtures/<key>/…` + per-adapter `.test.ts` | CREATE | Golden + failure fixtures, checkInvariants, shadow mode |

### WS-A — Easy-win activations (config/ops — see runbook tasks, minimal code)
| File | Action | Justification |
|---|---|---|
| `.env` (Insights, gitignored) | UPDATE | `REGISTRY_DATABASE_URL`, `OPENROUTER_API_KEY`/`ANTHROPIC_API_KEY`, `LLM_MONTHLY_BUDGET_USD`, SMTP, `INBOUND_EMAIL_SECRET` — **owner sets values** |
| `docs/runbooks/registry-seam-golive.md` + `docs/STATUS.md` | UPDATE | Activation checklist + verification commands |

## NOT Building
- **No scoring-weight changes.** `gc_quality`/`trade_match` are score-neutral signals only until §12.3 calibration (a separate, owner-gated change bumps `SCORING_ALGORITHM_VERSION`).
- **No HubSpot/Salesforce native/MCP integration.** WS-D ships a generic outbound webhook + CSV (HubSpot documented as one consumer). The marketing MCP connectors require interactive auth and are out of scope.
- **No warehouse sync (BigQuery/Snowflake/S3) build.** The "API/warehouse export tier" ships as webhook+CSV+read-route only; a warehouse connector and a paid data-buyer API are future work.
- **No arbitrary model-authored SQL** in the NL assistant. The model maps NL → a whitelisted structured filter; deterministic code runs the query (injection/isolation safety).
- **No new pre-permit stage enum.** `PROJECT_STAGES` already covers pre-permit; adapters emit existing stages.
- **No un-vetted title/rezoning scraping.** WS-G ships ONE verify-first pilot (Thurston land-use/rezone) in shadow mode; statewide title-transfer coverage is explicitly deferred pending per-source robots/terms/legal review.
- **No secrets, connection strings, or webhook URLs committed.** Env/account-config only.
- **No Google-phone overwrite of L&I phone.** Google phone is a secondary surfaced contact.
- **No autonomous env-setting.** WS-A documents the values the **owner** enters; do not guess-set a DB credential or API key.

---

## Step-by-Step Tasks

> Execute in workstream order. Commit + push each WS on its repo trunk when its VALIDATE gate is green.

### WS-0 — Registry contract durability

#### Task 0.1: Capture the live 25-col contract view into a migration + baseline mirror
- **ACTION**: In the Registry repo on `release/trades-staging`, author a new migration that re-creates `registry_public.trades_identity_v1` with the four enrichment columns exactly as they exist live, plus the byte-equivalent baseline mirror, and re-grant the reader.
- **IMPLEMENT**: First dump the live view definition (authoritative source of truth) via the Supabase MCP: `SELECT pg_get_viewdef('registry_public.trades_identity_v1'::regclass, true);`. Create `apps/registry/supabase/migrations/<UTC>_surface_google_and_trades_in_trades_identity_v1.sql` wrapping the live `CREATE OR REPLACE VIEW … WITH (security_invoker = false) AS …` in `BEGIN;…COMMIT;`, appending: `gp.phone_raw AS google_phone`, `gp.rating AS google_rating`, `gp.review_count AS google_review_count` (LATERAL from `registry_entity_external_profiles` via `registry_entity_external_profile_links`, gated `link_status='accepted' AND public_surface_policy IN ('profile_enrichment_ready','primary_only') AND external_provider='google_maps'`, ordered `review_count DESC`), and `trade_codes` (`array_agg` from `registry_trade_assignments` where entity+vertical, primary-first). End with `GRANT SELECT ON registry_public.trades_identity_v1 TO otn_insights_reader;`. Header must name the baseline twin. Copy the identical body to `db/baseline-v1.2/26_registry_public_trades_identity_v1_enrichment.sql`.
- **MIRROR**: REGISTRY_MIGRATION pattern (`20260719120000_surface_registered_address…sql`).
- **IMPORTS**: N/A (SQL). Use Supabase MCP `apply_migration` / `execute_sql` to verify against live; do NOT hand-write column logic — derive from `pg_get_viewdef`.
- **GOTCHA**: The live view is AHEAD of source — trust `pg_get_viewdef`, not memory. Keep additive under `_v1` (no column reorder/rename; a breaking change would need `_v2`). The migration must be idempotent (`CREATE OR REPLACE`, `IF NOT EXISTS` role guard). Update `db/baseline-v1.2/README.md` manifest or `audit:docs-manifest` fails.
- **VALIDATE**: `SELECT count(*) FROM information_schema.columns WHERE table_schema='registry_public' AND table_name='trades_identity_v1';` returns 25. `SET ROLE otn_insights_reader; SELECT google_phone, trade_codes FROM registry_public.trades_identity_v1 LIMIT 1; RESET ROLE;` succeeds. Migration body byte-identical to baseline mirror (`diff`).

#### Task 0.2: Reconcile & commit the trade-assignment provenance
- **ACTION**: Prove the 24,669 live `registry_trade_assignments` rows are reproducible from committed source; fix the drift if not.
- **IMPLEMENT**: Compare live assignment counts by `source` (`SELECT source, count(*) FROM registry_internal.registry_trade_assignments GROUP BY 1`) against a `--dry-run` of the committed `assign-license-trades.mjs` (which uses `normalizeSpecialty` substring matching — NOT the `specialtyCodeToTrade` helper referenced in stale notes, which does not exist on this branch). If the committed script reproduces the live assignment set, add a note + `--dry-run` transcript to the runbook. If it does NOT (i.e. the live rows were produced by an uncommitted method), commit the actual logic that produced them (extend `trades-taxonomy-map.mjs`/`assign-license-trades.mjs`) so a fresh provision reproduces the 25-col `trade_codes`.
- **MIRROR**: REGISTRY_SCRIPT pattern; `normalizeSpecialty` / `PATTERN_INDEX`.
- **IMPORTS**: `makePool`/`withTransaction` from `db.mjs`.
- **GOTCHA**: `trade_codes` in the view is `array_agg` over these assignments — if provenance is uncommitted, WS-B's `trade_codes` reads become non-reproducible across environments. Source is authoritative `'license_code'`; never permit-infer GC (`keywords: []` on purpose).
- **VALIDATE**: `DATABASE_URL=… node apps/registry/scripts/entity-resolution/assign-license-trades.mjs --dry-run` reports a plan consistent with live counts (±0 net new for a settled DB). Provenance documented in `registry-seam-golive.md`.

### WS-A — Easy-win activations (owner-gated env/config; verification is the deliverable)

#### Task A.1: Registry seam ON (easy win #1)
- **ACTION**: Document + verify turning on `REGISTRY_DATABASE_URL` (Insights `.env`) = the Trades Supabase **session pooler** (port 5432, role `otn_insights`). **Owner enters the value** (contains a credential — do not guess-set).
- **IMPLEMENT**: In `docs/runbooks/registry-seam-golive.md`, record: value shape `postgres://otn_insights.<ref>:<password>@<host>:5432/postgres` (session pooler, NOT transaction pooler 6543 — pg-boss breaks on it); then run `pnpm --filter @otn/worker resolve:run` → `linkRegistry` binds by strong key; the nightly chain's `exportRegistryObservations` (`schedules.ts:140`) begins writing `registry_partner`.
- **GOTCHA**: Absent the var, `linkRegistry`/`export` **skip visibly** (`summary.skipped`) — that's correct, not a failure. Least-privilege: reader reads `registry_public` only.
- **VALIDATE**: `SELECT count(*) FROM organizations WHERE registry_ref IS NOT NULL;` > 0 after `resolve:run`; Solis binds to entity `8a12a7cb-…` via `ubi_exact`.

#### Task A.2: Model API key (easy win #2) · Task A.3: SMTP (easy win #3) · Task A.5: Bid-inbox (easy win #5)
- **ACTION**: Document + verify each env activation; **owner enters secret values**.
- **IMPLEMENT**: A.2 — set `OPENROUTER_API_KEY` (or `ANTHROPIC_API_KEY`) + `LLM_MONTHLY_BUDGET_USD`; `pnpm brief:run` flips briefs from `blocked` → `succeeded`. A.3 — set SMTP/`ALERTS_EMAIL`; `pnpm digest:run` sends. A.5 — the bid-inbox is already wired end-to-end (JSON adapter + inbound-email webhook); activation = obtain written customer authorization + set `INBOUND_EMAIL_SECRET` (email path) or provision `CUSTOMER_BID_INBOX_DIR` (JSON path). Then `bid_invitations` populate the digest ⏰ Deadlines and `bidding_confirmed` becomes reachable.
- **GOTCHA**: No key ⇒ briefs `blocked`, never unlimited. `bidding_confirmed` is set ONLY by `customer-bid-inbox.ts`/`tacoma-solicitations.ts` on explicit-invitation statuses — do not widen. Customer authorization is a real prerequisite, not a code toggle.
- **VALIDATE**: `SELECT status, count(*) FROM model_runs WHERE job_type='brief_draft' GROUP BY 1;` shows `succeeded`; a test digest email arrives; `SELECT count(*) FROM bid_invitations WHERE bid_due_at >= now();` > 0 once inbox authorized.

*(Easy wins #4 and #6 are code — WS-B and WS-C.)*

### WS-B — Consume enriched contract + verified GC contact + neutral signals

#### Task B.1: Read the 4 new contract columns
- **ACTION**: Extend `RegistryIdentityRow` + `fetchRegistryIdentityRows` SELECT/row-map + `identitySnapshot`.
- **IMPLEMENT**: Add `googlePhone`, `googleRating`, `googleReviewCount`, `tradeCodes: string[] | null` to the interface; append `google_phone, google_rating, google_review_count, trade_codes` to the SELECT; map with the explicit-cast idiom (`Number(...)` for rating/review_count, `as string[]` for trade_codes). Add `google_phone`/`google_rating` + `trade_codes` to `identitySnapshot` so bound orgs cache them in `registry_identity_json`.
- **MIRROR**: CONTRACT_READER pattern.
- **IMPORTS**: none new.
- **GOTCHA**: New fields OPTIONAL on the type so existing hand-built test fixtures still compile. Reader role has SELECT on the view only.
- **VALIDATE**: `pnpm --filter @otn/resolution test` green; a live `fetchRegistryIdentityRows` (seam on) returns non-null `googlePhone` for ≥3,000 rows.

#### Task B.2: Adopt google_phone as a global verified contact + trade observation
- **ACTION**: In `registry-observations.ts`, add a `phone_adoption` path fed by `google_phone` (when L&I `phone` is null) and a `trade_export`-style observation from `trade_codes`.
- **IMPLEMENT**: Extend `generateRegistryObservations` to read the new row fields; emit a `phone_adoption` observation with role `'Google Business phone'`; on accept, INSERT into `organization_contacts` (`account_profile_id NULL`, `source_type 'public_business'`). Add `trade_codes` to the existing trade observation flow.
- **MIRROR**: CONTACT_ADOPTION_SIDE_EFFECT.
- **GOTCHA**: Keep the human/auto-accept trust gate (`MIN_QUEUE_TRUST`, `AUTO_ACCEPT_*`). L&I phone stays authoritative — only adopt google_phone when L&I phone absent. Never adopt if the entity is person-classed.
- **VALIDATE**: `pnpm --filter @otn/resolution test` green; accepting a google_phone observation inserts exactly one `public_business` contact (idempotent on re-run).

#### Task B.3: Carry GC phone + verified into the digest model
- **ACTION**: Extend `OrgActivityRow` + rollup SELECT (`org-activity.ts`) and `RelationshipPlay`/`DeadlineItem`/`DigestItem` (`digest.ts`) with `generalContractorPhone`, `verified` (from `organizations.verified_at IS NOT NULL`), `rating`.
- **IMPLEMENT**: Add columns to the `orgActivityRollup` SELECT (LEFT JOIN `organization_contacts` for phone, read `verified_at`, `registry_identity_json->>'google_rating'`); thread into `relationshipTargets`. Add GC phone/verified to `upcomingDeadlines` SELECT (already LEFT JOINs `organizations`).
- **MIRROR**: existing `OrgActivityRow` SELECT (`org-activity.ts:123`); `upcomingDeadlines` (`digest.ts:247`).
- **GOTCHA**: Digest model must stay pure/deterministic (no side effects) — `render.ts` does all HTML.
- **VALIDATE**: `apps/worker/test/digest.test.ts` seeds a bound GC with a contact → model carries phone + `verified: true`.

#### Task B.4: Render ✓ verified badge + phone (easy win #4)
- **ACTION**: In `render.ts`, add phone + `✓ verified` badge to `itemHtml` (GC block), the 🤝 GCs-worth-meeting block, and the ⏰ Deadlines block.
- **IMPLEMENT**: New GC line in `itemHtml`: `GC: <name> <verified?'✓ verified':''> <phone?'☎ '+fmt(phone):''>`. Same in `topBlock`'s two GC blocks. `esc()` all values.
- **MIRROR**: `itemHtml`/`topBlock` string-building (`render.ts:123`/`:187`).
- **GOTCHA**: Deterministic render — no data access here. Badge only when `verified_at != null`; phone formatting must handle raw digits.
- **VALIDATE**: `pnpm --filter @otn/delivery test`; a rendered fixture contains `✓ verified` + the phone only when present.

#### Task B.5: Score-neutral gc_quality + trade_match signals (§12.3)
- **ACTION**: In `scoring.ts` `routeSolis`, push `"gc_quality"` when `google_rating >= 4.0 && review_count >= 5`, and `"trade_match"` when a project's inferred trade ∈ the GC's `trade_codes`.
- **IMPLEMENT**: `signals.push(...)` only — no `components` weight, no version bump.
- **MIRROR**: SCORE_NEUTRAL_SIGNAL.
- **GOTCHA**: Must NOT change any score. Add a neutrality test.
- **VALIDATE**: `pnpm --filter @otn/intelligence test`; new test asserts `withGcQuality.score === baseline.score` and `signals` contains the new strings; eval harness gates still pass (priorityPrecision 1.0 / recall 0.96 / Solis 1.0).

### WS-C — Phase-change urgent alerts (easy win #6 + Building Radar parity)

#### Task C.1: Add the phase_change alert type + evaluation
- **ACTION**: Extend the `AlertCandidate` union with `"phase_change"` and add an `evaluateAlertConditions` branch that fires when a priority opportunity's project enters its bid window.
- **IMPLEMENT**: Query `project_events` (`material_change = true`) joined to `opportunities` where `current_score >= <priority band floor>` AND `resulting_stage ∈ COMMERCIAL_BUYOUT_STAGES` (commercial track) OR a new high-score `permit_issued` (residential). Encode account + opportunity in `subject_key` (no `account_profile_id` column exists). `idempotencyKey = phase_change:${opportunityId}:${resultingStage}:${day}`. Severity `warning`.
- **MIRROR**: ALERT_EMISSION.
- **IMPORTS**: `COMMERCIAL_BUYOUT_STAGES`/`bidTrackFor` from `@otn/intelligence`.
- **GOTCHA**: Runs inside the existing daily `pipeline-maintenance` cron (the "real-time-ish answer without leaving weekly cadence") — do NOT add a new high-frequency cron. `ON CONFLICT DO NOTHING` prevents re-alerting the same stage/day. Account-scope via subject_key so isolation holds.
- **VALIDATE**: `apps/worker/test/alerts.test.ts` seeds a commercial project entering `permit_applied` with a priority opp → `res.fired.some(f => f.alertType === 'phase_change')`; a second run dedupes; a below-threshold opp does not fire.

### WS-D — CRM/webhook + CSV export tier

#### Task D.1: Export module
- **ACTION**: Create `packages/delivery/src/export.ts` with `exportPursuits(db, accountProfileId, opts)` producing CSV + a webhook POST.
- **IMPLEMENT**: Select the account's pursued/priority opportunities with GC contact (WS-B fields), project facts, score, bid window; serialize to (a) CSV rows, (b) a HubSpot-compatible JSON payload POSTed to `opts.webhookUrl` (from account config). Return a typed summary `{ exported, webhookStatus }`; never throw on webhook failure (status-discriminated result, like the brief triad).
- **MIRROR**: `exportRegistryobservations` run/idempotency shape; MODEL_JOB_TRIAD error discipline; logging via injected logger.
- **IMPORTS**: `sql` (drizzle), account config loader, `fetch` (global).
- **GOTCHA**: POST ONLY to the account-configured `webhook_url` — never a URL from observed content (Governance #10). Account-scoped query (isolation). Rate-limit; redact the URL in logs (`redactUrl`). No secrets in code.
- **VALIDATE**: `packages/delivery/src/export.test.ts` — CSV row count matches seeded pursuits; webhook mocked, receives the account's rows only; another account's rows never appear.

#### Task D.2: CLI + web download route
- **ACTION**: `apps/worker/src/cli/export-run.ts` (`pnpm export:run`) + `GET /api/app/pursuits/export?format=csv` (download).
- **IMPLEMENT**: CLI resolves account + config, calls `exportPursuits`. Web route mirrors `organizations/route.ts` `withAccount` GET, returns `text/csv` with a `Content-Disposition` attachment.
- **MIRROR**: ACCOUNT_SCOPED_ROUTE; `apps/web/app/api/app/organizations/route.ts`.
- **GOTCHA**: The `export` config block is optional; absent webhook_url ⇒ CSV-only.
- **VALIDATE**: CLI dry-run prints a plan; `curl` the route (authed) downloads a CSV of the account's pursuits.

### WS-E — Outreach templates

#### Task E.1: generateOutreach
- **ACTION**: Create `packages/intelligence/src/outreach.ts` — a brief-layer twin that drafts a short intro to the GC.
- **IMPLEMENT**: Build a menu from `buildDecisionMemo` + GC contact (WS-B); prompt the model for a ≤120-word intro citing only verified facts (refId discipline); `persistModelRun` job_type `outreach_draft`; budget-gated; `MockProvider` double. Return `{ status, text|reason, modelRunId }`.
- **MIRROR**: MODEL_JOB_TRIAD; `brief.ts` menu/prompt/validate structure.
- **IMPORTS**: `providerFromEnv`, `checkBudget`, `budgetFromEnv`, `persistModelRun`, `buildDecisionMemo`.
- **GOTCHA**: No hallucinated facts — every claim maps to a menu refId. No key ⇒ `blocked`. Never auto-send; this is a draft the estimator copies.
- **VALIDATE**: `outreach.test.ts` — MockProvider returns a draft citing menu refs; no-provider path returns `blocked` and persists a `model_runs` row.

#### Task E.2: Surface the draft
- **ACTION**: Render "✍ Draft intro" in `itemHtml`; expose `POST /api/app/opportunities/[id]/outreach`.
- **MIRROR**: `regenerate-memo/route.ts`; `itemHtml`.
- **VALIDATE**: rendered fixture shows the draft when present; route returns the draft for an in-account opportunity, 404 cross-account.

### WS-F — NL assistant (Charlie-style)

#### Task F.1: assistant.ts (NL → whitelisted filter → grounded answer)
- **ACTION**: Create `packages/intelligence/src/assistant.ts` answering questions like "what's winnable in Thurston this week?" over the account's opportunities.
- **IMPLEMENT**: Step 1 — the model maps the NL question to a **structured filter** from a whitelist (`county`, `trade`, `stage`/bid-window-open, `scoreBand`, `timeframe`); validate with Zod. Step 2 — deterministic code runs the account-scoped SQL for that filter. Step 3 — the model narrates the grounded result citing refIds (reuse the brief menu). Budget-gated; `MockProvider` double. Return `{ status, answer, opportunityIds, modelRunId }`.
- **MIRROR**: MODEL_JOB_TRIAD; brief menu; `bidTrackFor`/`tradeBidWindow` for "winnable".
- **IMPORTS**: provider/budget triad; `z` (zod); drizzle `sql`.
- **GOTCHA**: NEVER execute model-authored SQL (Governance / NOT Building) — the model only picks whitelisted filter values; deterministic code queries. Account-scope every query. If no facts match, say so — never invent.
- **VALIDATE**: `assistant.test.ts` — a fixed NL question maps to the expected filter (deterministic, no model needed for the mapping test via a stubbed parse); grounded answer via MockProvider references only seeded opportunities; a cross-account opportunity is never returned.

#### Task F.2: Route + CLI
- **ACTION**: `POST /api/app/assistant` + `apps/worker/src/cli/assistant-run.ts`.
- **MIRROR**: ACCOUNT_SCOPED_ROUTE; `brief-run.ts` CLI.
- **VALIDATE**: authed POST returns a grounded answer; CLI prints an answer for a seeded account.

### WS-G — First-class pre-permit "Decisions" layer + new verify-first feeds

#### Task G.1: Promote the radar to a first-class "Decisions" section
- **ACTION**: Relabel/elevate the `RADAR_STAGES` digest block into a "🧭 Decisions" section with bid-window context.
- **IMPLEMENT**: In `digest.ts`, keep `RADAR_STAGES = {concept, preapplication, entitlement}` (optionally add `approved`), attach `tradeBidWindow` status ("opens in ~Nw") to each; render a labeled section in `render.ts` above Deadlines.
- **MIRROR**: `topBlock` sections; `bid-window.ts` wiring at `digest.ts:468`.
- **GOTCHA**: Display-only; pre-permit signals do NOT set `bidding_confirmed` and (by default) do NOT enter the easy-win set (stage gate stays `permit_issued`/`approved`) unless the owner opts in per account.
- **VALIDATE**: digest test shows a `preapplication` project in the Decisions section with a bid-window note.

#### Task G.2: New verify-first early-feed adapters (one per source, ship disabled)
- **ACTION**: Create `olympia-lacey-preapp.ts`, `thurston-hearing-examiner.ts`, `seattle-design-review.ts`, each implementing `SourceAdapter`, emitting pre-permit `normalizedStage` + appropriate `EVENT_TYPES` (`decision_issued`, `notice_published`).
- **IMPLEMENT**: Follow the 9-step activation. Capture-fed `fetch()` from `$OTN_CAPTURE_DIR/<key>/` where the live gate is bot-protected; `discover`/`parse` per contract; `checkInvariants` reconciling any printed totals. Register in `adapters/src/index.ts`; declare in `sources.yaml` with `enabled: false`, `cadence: on_demand`, `terms_reviewed_at`/`robots_reviewed_at` blank until reviewed.
- **MIRROR**: SOURCE_ADAPTER (Olympia); source-adapter skill.
- **GOTCHA**: Discover the real hostnames from the official county page today — never guess (e.g. Lewis SmartGov). Unknown fields = null. Ship in shadow mode; enable only after health tests pass. Watch the Thurston Sept-2026 system-migration canary.
- **VALIDATE**: per-adapter golden + failure fixtures pass; manual row/count compare recorded in fixture metadata; shadow run produces records with `county`+`permittingJurisdiction` non-null.

#### Task G.3: Title/rezoning pilot (the "Mercator is earlier" gap)
- **ACTION**: Create ONE verify-first pilot `thurston-landuse-rezone.ts` for land-use/rezoning applications (upstream of permits).
- **IMPLEMENT**: Same adapter contract; emit `normalizedStage: entitlement` (or `unknown` when the index carries no outcome) + `EVENT_TYPES` (`plat_approved`/`sepa_determination`/`notice_published` as applicable). Confirm publisher, robots, terms; capture fixtures; shadow mode.
- **MIRROR**: SOURCE_ADAPTER; the SEPA/hearing precedents already in `sources.yaml`.
- **GOTCHA**: Title-transfer/assessor data is the most legally sensitive — this task is a SINGLE lawful pilot only; statewide coverage is NOT building here (deferred pending per-source review). Registry has NO such data (confirmed) — this is net-new Insights sourcing. Homeowner PII must not cross the registry bridge.
- **VALIDATE**: pilot passes fixture + health tests in shadow mode; a manual sample matches the published source; remains `enabled: false` pending owner go-ahead.

---

## Testing Strategy

### Unit / Integration Tests
| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| `registry-link` reads new cols | contract row w/ google_phone/trade_codes | `RegistryIdentityRow` carries them; snapshot caches them | Yes — null google_phone |
| google_phone adoption | L&I phone null + accepted google link | one `public_business` contact; idempotent | Yes — person-classed entity → no adopt |
| scoring neutrality | GC w/ rating 4.8/50 reviews + trade match | `signals` has `gc_quality`+`trade_match`; **score unchanged** | Yes — §12.3 guard |
| digest render badge | bound GC w/ verified_at + phone | HTML has `✓ verified` + `☎` | Yes — unverified → no badge |
| phase_change alert | commercial opp enters `permit_applied`, score≥floor | one `phase_change` fired; dedupes on rerun | Yes — below-threshold → none |
| export isolation | 2 accounts w/ pursuits | webhook/CSV carries only the caller's rows | Yes — no webhook_url → CSV only |
| outreach draft | opp + GC contact + MockProvider | ≤120-word intro citing refIds | Yes — no key → `blocked` |
| assistant NL→filter | "winnable in Thurston this week" | filter `{county:Thurston, bidWindowOpen:true, timeframe:7d}`; grounded answer | Yes — no match → honest "none" |
| pre-permit adapter | captured fixture | records w/ pre-permit stage, county non-null | Yes — malformed → dead-letter |
| registry view drift | live vs migration | 25 cols; reader SELECT ok; baseline byte-identical | Yes — fresh provision reproduces 25 cols |

### Edge Cases Checklist
- [ ] Empty input (no bound GC; no pursuits; NL question with no matches)
- [ ] Missing external dep (no `REGISTRY_DATABASE_URL` → visible skip; no model key → `blocked`)
- [ ] Concurrent access (alert idempotency `ON CONFLICT`; export re-run)
- [ ] Permission denied (cross-account opportunity → 404; reader can't read `registry_internal`)
- [ ] Network failure (webhook POST fails → status-discriminated result, no throw)
- [ ] §12.3 invariant (new signals never move a score)
- [ ] PII gate (person-classed entity never adopted/exported)

---

## Validation Commands

### Static Analysis (Insights)
```bash
cd C:/Users/Snipe/Downloads/TradesInsights && pnpm -r typecheck
```
EXPECT: Zero type errors.

### Affected-area tests (per WS)
```bash
pnpm --filter @otn/resolution test        # WS-B
pnpm --filter @otn/intelligence test      # WS-B, WS-E, WS-F
pnpm --filter @otn/delivery test          # WS-B, WS-C, WS-D, WS-G
pnpm --filter @otn/worker test            # integration (digest/alerts/registry-link)
```
EXPECT: All green.

### Full suite + eval gates (Insights)
```bash
pnpm test:security   # full suite (was 78 files / 568 tests green pre-change)
pnpm --filter @otn/intelligence eval    # priorityPrecision ≥0.9, recall ≥0.8, Solis 1.0/1.0
```
EXPECT: No regressions; eval gates PASS (score-neutrality holds).

### Registry contract (WS-0)
```bash
# Verify live view captured + reader access (Supabase MCP or psql)
SELECT count(*) FROM information_schema.columns
  WHERE table_schema='registry_public' AND table_name='trades_identity_v1';   -- 25
diff <migration body> <db/baseline-v1.2/26_*.sql>                              -- identical
DATABASE_URL=… node apps/registry/scripts/entity-resolution/assign-license-trades.mjs --dry-run
```
EXPECT: 25 cols; byte-identical mirror; assignment plan consistent with live counts.

### Manual Validation
- [ ] Seam on → `resolve:run` binds Solis; digest shows GC phone + ✓ badge on a Thurston opp.
- [ ] `brief:run` with a key → a brief + an outreach draft render.
- [ ] Enter a commercial project into plan-review → `alerts:run` fires a `phase_change`.
- [ ] `POST /api/app/assistant` "winnable in Thurston this week" → grounded answer citing real opps.
- [ ] `pursuits/export?format=csv` downloads the account's pursued opps with GC contact.
- [ ] New pre-permit adapter shadow run → Decisions section populates; stays `enabled: false`.

---

## Acceptance Criteria
- [ ] WS-0: enriched 25-col view + baseline mirror committed; reader access verified; assignment provenance reproducible.
- [ ] WS-A: activation runbook documents all six env/config steps + verification (owner enters secrets).
- [ ] WS-B: Insights reads 4 new columns; verified GC phone + ✓ badge render; `gc_quality`/`trade_match` are score-neutral.
- [ ] WS-C: `phase_change` alert fires on bid-window entry, idempotent, threshold-gated, account-scoped.
- [ ] WS-D: pursued opps export to CSV + a customer-configured webhook, account-isolated.
- [ ] WS-E: outreach draft generated (grounded, budget-gated) + surfaced.
- [ ] WS-F: NL assistant answers via whitelisted filters + grounded facts, account-isolated, no model-SQL.
- [ ] WS-G: Decisions section first-class; ≥3 new verify-first adapters + 1 title/rezoning pilot pass fixture/health tests in shadow mode.
- [ ] All validation commands pass; eval gates green; no type/lint errors.

## Completion Checklist
- [ ] Code mirrors discovered patterns (SOURCE refs above)
- [ ] Error handling matches the throw-for-precondition / status-for-IO split
- [ ] Logging via injected `createLogger` (object-first, URL-redacted)
- [ ] Tests follow the pure-unit + `testDb()`/`MockProvider` harnesses
- [ ] No hardcoded secrets/URLs; env/config only
- [ ] Registry DDL additive under `_v1` + baseline mirror + manifest updated
- [ ] Each WS committed + pushed to its trunk (never `main`)
- [ ] §12.3 neutrality preserved; no `SCORING_ALGORITHM_VERSION` bump
- [ ] New sources ship `enabled: false`, verify-first, capture-fed

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Live registry view drift lost on fresh provision | High (already drifted) | High (Insights reads break cross-env) | WS-0 first — capture from `pg_get_viewdef` into migration + baseline mirror |
| Assignment provenance uncommitted (`trade_codes` non-reproducible) | Medium | Medium | Task 0.2 reconciles/commits before WS-B depends on `trade_codes` |
| A new signal accidentally moves scores (breaks §12.3) | Medium | High (owner trust / calibration) | Neutrality unit test + eval gate; signals-only, no weight, no version bump |
| Model-authored SQL in assistant → injection / cross-account leak | Medium | High | Whitelisted structured filter only; deterministic account-scoped query; isolation test |
| Export webhook posts to an attacker-supplied URL | Low | High | Post only to account-config `webhook_url`; never a URL from observed content; redact in logs |
| New pre-permit source violates robots/terms or trips a bot gate | Medium | High (legal / IP) | Verify-first 9-step; capture-fed; ship disabled; shadow mode; per-source review |
| Homeowner PII crosses the registry bridge via a pre-permit/title feed | Medium | High (privacy) | Person-vs-business gate; business-only bridge; title pilot is single + shadow |
| Owner-gated activations block "live" value | High | Medium | WS-A explicitly owner-gated; code paths skip visibly until env set (no failure) |
| Transaction pooler (6543) breaks pg-boss | Low | Medium | Runbook pins session pooler (5432) for `REGISTRY_DATABASE_URL` |

## Notes
- **Cross-repo execution**: WS-0 lands in the **Registry** repo (`release/trades-staging`); WS-A–WS-G land in **Insights** (`claude/tmux-install-320aiz`). Commit/push each repo independently; the seam is the only runtime coupling (env var).
- **This plan supersedes nothing** in `registry-insights-dataflow-solis-inference.plan.md` — it builds on that seam. WS-A #1 is that plan's remaining go-live step (set `REGISTRY_DATABASE_URL` + run the loop).
- **Provenance correction**: stale notes reference `specialtyCodeToTrade`/`CC_SPECIALTY_TRADE`; these do NOT exist on `release/trades-staging` (the committed matcher is `normalizeSpecialty`). Task 0.2 reconciles this rather than assuming.
- **MCP connector caveat**: HubSpot/Slack/etc. connectors need interactive auth and are unavailable non-interactively; WS-D is deliberately a generic webhook/CSV, which is also the more durable design.
- **Calibration dependency**: WS-B's neutral signals become *weighted* only via a separate, owner-confirmed §12.3 change after the Solis calibration session.
