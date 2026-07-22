# Plan: Flywheel Phase 4 — Activity Score, Pursuit Outcomes, Matching Strength, Root-Domain Matching

## Summary
Phase 4 of the Registry ↔ Insights flywheel, integrating the owner-approved 4A scope (Contractor Activity Score, pursuit-outcome labels, calibration prep) with the 4B matching-strength package (phone extensions, google-phone key, address round 2, accept-side backfeed, match telemetry) and the owner-overridden **root-domain matching enablement**. Everything matching-related is **review-queue-only** — nothing new auto-binds. §12.3 scoring stays byte-frozen.

**Owner approval (verbatim, 2026-07-22):** "we will accept the phase 4b matching. and execute the prp plan and implementation next turn. We should also enable the root-domain matching; the integration of these two projects into one is your perogative, you have master authority over this space currently."

## Problem → Solution
- Extensions kill phones: `"360-555-0123 x102"` → 13 digits → null (`normalizePhoneUS`). → Strip extension suffixes first.
- `googlePhone` is fetched from the contract view but never used as a match key. → Unique-google-phone rule, de-rated, own accept history.
- Address matching drops shared-address buckets outright and can't see suite-noise variants. → Candidate variants both sides + name-dominance disambiguation.
- Accepting a binding stamps `registry_ref` + snapshot but NOT the entity's UBI/contractor number — WS-B.4 / strong-key link never fire for later records of the same org. → NULL-only strong-key backfeed with provenance.
- `root_domain` is fetched (registry-link.ts:48) but dormant. → `binding_domain_match` rule + org-side `root_domain` identifier lane, skip-safe.
- No per-rule evidence for tuning `MIN_QUEUE_TRUST`/weights at calibration. → `match:audit` CLI + below-floor counters.
- Registry trades directory is ranked by a mostly-NULL `registry_score`. → Contractor Activity Score (display/ranking only, disclosed basis, never fed to Insights scoring).
- Pursuit outcomes (won/lost/no_bid) evaporate. → `decision_labels` kind=`pursuit_outcome` captured in `transitionPursuit`.

## Metadata
- **Complexity**: Large (two repos, ~22 files, 2 migrations + 1 baseline patch)
- **Source**: `flywheel-phase4-approved-scope.md` (memory) + `registry-insights-flywheel-phases-1-4.plan.md` Phase 4
- **Repos/trunks**: Insights `C:\Users\Snipe\Downloads\TradesInsights` on `claude/tmux-install-320aiz`; Registry worktree `trades-google-place-integration-v2` on `release/trades-staging`
- **Migration numbers**: Insights drizzle **idx 30** (`0030_identifier_lanes.sql`, when `1784340000000`); Registry supabase `20260723090000_*` + baseline patch **29** + census README row

## Constraints (all carried from Phases 1–3, verbatim governance)
1. §12.3 scoring weights FROZEN — zero changes to `scoring.ts` / trust weights consumed by opportunity scoring; `TRUST_WEIGHTS` in registry-observations is the *observation-queue* trust (not opportunity scoring) and stays unchanged too — new rules reuse existing components with de-rated VALUES, not new weights. Eval gates must PASS byte-identical (precision 1.0 / recall 0.9609375).
2. Review-queue-only: `binding_name_match` observation type (which carries ALL binding rules) remains excluded from auto-accept (registry-observations.ts:625).
3. Unknown = null, never guessed. All normalizers fail closed.
4. Insights reads `registry_public.*` only / writes `registry_partner.*` only. Root-domain boundary: Insights READS `trades_identity_v1.root_domain`; registry website hydration (`registry_entity_websites`/`website_signals`) stays Codex's lane — do not write there.
5. Registry DDL: additive `_v1`, supabase migration + byte-identical baseline mirror + census row.
6. NOT building: cross-source phone-based org clustering in the resolver (phones recycled — rejected in planning); eTLD+1 PSL folding (see Task 7 normalizer note); any Insights read of the Activity Score.
7. Commit → push immediately after each repo's validation passes; never main.

---

## Mandatory Reading
| Priority | File | Why |
|---|---|---|
| P0 | `packages/resolution/src/identifiers.ts` (all) | normalizePhoneUS:15, normalizeAddressUS, addressMatchKeyCandidates:152, persistOrganizationIdentifiers:199, loadOrganizationPhones/Addresses |
| P0 | `packages/resolution/src/registry-observations.ts` (all) | byPhone:297, matchOrgByAddress:149, buildRegistryAddressIndex:131, binding loop 309–408, decideRegistryObservation:721, GenerateSummary:227 |
| P0 | `packages/resolution/src/registry-link.ts:24-88` | RegistryIdentityRow (rootDomain:51, googlePhone:59), identitySnapshot |
| P1 | `packages/intelligence/src/pursuit.ts:1-160` | PURSUIT_STATES, TRANSITIONS, HUMAN_ONLY, transitionPursuit:113 (reason/outcomeDate gates at :141-158) |
| P1 | `apps/web/app/api/app/opportunities/[id]/state/route.ts` | decision_labels snapshot-before-update pattern (Phase 1.4) |
| P1 | `packages/db/migrations/0024_identifier_types_address_entity.sql` | CHECK-widening pattern for 0030 |
| P1 | Registry `apps/registry/src/lib/public-pages/serviceDirectoryData.ts:100-133` | trades directory card query + ORDER BY (ranking hook) |
| P1 | Registry `db/baseline-v1.2/28_registry_public_trades_activity_v1.sql` | view style, security_invoker=false, UBI LATERAL, additive-_v1 comment discipline |
| P2 | Registry `apps/registry/src/app/contractor/[slug]/page.tsx` + `components/ContractorProfilePage.tsx` | settings.ubi normalization + PermitActivity prop pattern (Phase 3.1) |
| P2 | `apps/worker/src/cli/*.ts` any one (e.g. review.ts) | CLI shape for match-audit.ts |

## Patterns to Mirror

### FAIL_CLOSED_CANDIDATE_KEYS — identifiers.ts:152-173
```ts
export function addressMatchKeyCandidates(address, zip?): string[] {
  const primary = addressMatchKey(address, zip);
  if (!primary) return [];
  const out = [primary];
  if (String(address).includes(",")) return out;
  // peel loop: stop at digit-bearing / STREET_TAIL_TOKENS; validity floor ≥3 tokens, digit, ≥8 chars
```
New peels (unit-noise) extend this function; never a new parallel one.

### UNIQUE_KEY_INDEX — registry-observations.ts:297-301
```ts
const byPhone = new Map<string, RegistryIdentityRow | null>();
for (const row of registryRows) {
  if (!row.phone) continue;
  byPhone.set(row.phone, byPhone.has(row.phone) ? null : row);
}
```
Google-phone and root-domain indexes copy this shape (shared key ⇒ null ⇒ dropped).

### NAME_GATED_WEAK_MATCH — registry-observations.ts:335-353 (phone) & 149-164 (address)
```ts
const sim = nameSimilarity(org.canonical_name, row.canonicalName ?? "");
if (sim >= PHONE_MATCH_MIN_NAME_SIMILARITY && (best === null || sim > best.sim)) best = { row, sim };
```
`nameComponent = best.sim`, `identifier` set per-rule, distinct `ruleKey` ⇒ own Laplace history.

### DE_RATED_SECONDARY_CHANNEL — registry-observations.ts:436-465 (`phone_from_google` precedent)
Distinct rule key + payload channel label; secondary never overrides the L&I-primary path (`else if`).

### DECISION_LABEL_SNAPSHOT — state/route.ts:32-62
Snapshot SELECT runs BEFORE the state change; append-only INSERT into `decision_labels` with what the human saw.

### CHECK_WIDENING_MIGRATION — 0024_identifier_types_address_entity.sql
```sql
ALTER TABLE organization_identifiers DROP CONSTRAINT IF EXISTS organization_identifiers_identifier_type_check;
ALTER TABLE organization_identifiers ADD CONSTRAINT organization_identifiers_identifier_type_check
  CHECK (identifier_type IN (...widened list...));
```

### REGISTRY_VIEW_DISCIPLINE — baseline 28 file
`CREATE OR REPLACE VIEW ... WITH (security_invoker = false)`, header comment naming the byte-equivalent baseline twin, `COMMENT ON VIEW` contract note, additive-_v1.

### NULL_ONLY_BACKFEED — identifiers.ts:234-242
```ts
UPDATE organizations SET ubi = ${ubi} WHERE id = ${organizationId} AND ubi IS NULL
```

## Files to Change

**Insights** (`TradesInsights`, branch `claude/tmux-install-320aiz`)
| File | Action | Why |
|---|---|---|
| `packages/db/migrations/0030_identifier_lanes.sql` + `meta/_journal.json` idx 30 | CREATE/UPDATE | widen `identifier_type` CHECK to add `'root_domain'`; add `provenance text NOT NULL DEFAULT 'source_evidence'` CHECK (`'source_evidence','registry_accept'`); `ALTER COLUMN source_record_id DROP NOT NULL` (registry-accept rows have no source record — provenance column carries the why) |
| `packages/resolution/src/identifiers.ts` | UPDATE | 4B.1 extension strip; 4B.3 placeholder rejection + unit-noise candidates; RD `normalizeRootDomain` + persist website→root_domain + `loadOrganizationDomains`; 4B.4 `backfeedAcceptedIdentity` helper |
| `packages/resolution/src/identifiers.test.ts` | UPDATE | tests for all of the above (pure-unit) |
| `packages/resolution/src/registry-link.ts` | NO CHANGE | rootDomain already fetched; comment at :48-51 updated to "live as of Phase 4" only |
| `packages/resolution/src/registry-observations.ts` | UPDATE | 4B.2 google-phone rule; 4B.3 shared-bucket address index + dominance margin; RD domain rule; 4B.5 belowFloor counters in GenerateSummary |
| `packages/resolution/src/registry-observations.test.ts` | UPDATE | rule tests (pure, injected rows) |
| `packages/domain/src/normalized-record.ts` | UPDATE | optional `website: z.string().min(4).optional()` on organizations[] (additive; no parser emits it yet — skip-safe) |
| resolver persist call site (`packages/resolution/src/resolver.ts` — wherever `persistOrganizationIdentifiers` inputs are built) | UPDATE | pass `website` through |
| `packages/intelligence/src/pursuit.ts` | UPDATE | 4A.2 pursuit_outcome label insert inside `transitionPursuit` for won/lost/no_bid |
| pursuit test file (co-located or apps/worker DB harness, follow Phase 1 deviation precedent) | UPDATE | outcome-label round-trip |
| `apps/worker/src/cli/match-audit.ts` + `apps/worker/package.json` script `match:audit` | CREATE/UPDATE | 4B.5 per-rule generated/pending/accepted/rejected/auto counts, Laplace rates, trust distribution |
| `docs/calibration-prep-solis.md` | CREATE | 4A.3 label inventory queries, per-account precision readout, match:audit walkthrough, §12.3 agenda |
| `docs/STATUS.md`, report | UPDATE | close-out |

**Registry** (worktree `trades-google-place-integration-v2`, branch `release/trades-staging`)
| File | Action | Why |
|---|---|---|
| `apps/registry/supabase/migrations/20260723090000_contractor_activity_score_v1.sql` + `db/baseline-v1.2/29_contractor_activity_score_v1.sql` (byte-identical) + README census row | CREATE | 4A.1 `registry_internal.contractor_activity_score_v1` view |
| `apps/registry/src/lib/public-pages/serviceDirectoryData.ts` | UPDATE | LEFT JOIN score, `ORDER BY g.sponsor_rank DESC, s.activity_score DESC NULLS LAST, g.registry_score DESC, g.gym_name ASC`; expose `activityScore` on card |
| `apps/registry/src/app/[state]/[city]/page.tsx` (and state page if it lists cards) | UPDATE | disclosure line (pinned) |
| `apps/registry/src/app/contractor/[slug]/page.tsx` + `components/ContractorProfilePage.tsx` | UPDATE | Activity Score panel with per-component basis |
| `scripts/pseo-quality-gate.mjs` | UPDATE | pin disclosure copy + view read |

## NOT Building
- Cross-source phone clustering in the resolver; eTLD+1 PSL; auto-binds of any kind; any Insights consumption of Activity Score; registry-side website hydration (Codex); scoring-weight changes; new sources/prompts.

---

## Step-by-Step Tasks

### Task 1 — Migration 0030 `identifier_lanes` (Insights)
- **ACTION**: New SQL migration per CHECK_WIDENING_MIGRATION: widen `identifier_type` to `('phone','ubi','contractor_number','email','address','source_entity_id','root_domain')`; `ADD COLUMN provenance text NOT NULL DEFAULT 'source_evidence' CHECK (provenance IN ('source_evidence','registry_accept'))`; `ALTER COLUMN source_record_id DROP NOT NULL`. Journal idx 30, when `1784340000000`, tag `0030_identifier_lanes`. Update `packages/db/src/schema.ts` organizationIdentifiers table (add provenance, drop notNull on sourceRecordId) if the table is modeled there (check; 0023 may be SQL-only).
- **GOTCHA**: never `"public".`-qualified refs; idempotent-safe (DROP CONSTRAINT IF EXISTS).
- **VALIDATE**: `pnpm db:migrate` local (PG_PORT=5433); hosted apply deferred to Task 12.

### Task 2 — 4B.1 phone extension strip
- **ACTION**: In `normalizePhoneUS`, before digit reduction: `const cleaned = String(raw).replace(/\s*(?:x|ext\.?|extension|#)\s*\d{1,6}\s*$/i, "")`. Everything else unchanged.
- **GOTCHA**: only a TRAILING extension; `#` also appears in unit numbers but this is phone input only. `"3605550123x102"` (no separator) → regex still strips `x102`. Do NOT strip mid-string.
- **VALIDATE**: identifiers.test.ts: `"360-555-0123 x102"`→`3605550123`, `"(360) 555-0123 ext. 5"`→ok, `"+1 360 555 0123 #12"`→ok, `"36055501234567"`→null (unchanged), plain 10-digit unchanged.

### Task 3 — 4B.3 address round 2, key side (identifiers.ts)
- **ACTION**:
  1. Placeholder rejection in `addressMatchKey`: `if (/^\s*(?:NONE|N\/?A|UNKNOWN|SAME|TBD|NULL)\b/i.test(raw)) return null;`
  2. Unit-noise peel in `addressMatchKeyCandidates` (extend FAIL_CLOSED_CANDIDATE_KEYS): after existing city-peel loop, for EVERY candidate collected so far, if its street part ends `<STREET_TAIL_TOKEN> <unit-value-looking token>` (reuse `looksLikeUnitValue` semantics: digit-bearing ≤6 chars or lone letter), add a variant with that trailing token peeled — validity floor enforced, dedupe via Set, applies to comma'd strings too (suite noise survives commas).
- **GOTCHA**: peel only ONE trailing unit token; never peel when the result loses its digit/floor. This runs on BOTH sides (Task 5 moves the registry index onto candidates), which is what makes variants meet.
- **VALIDATE**: tests: `"1210 HOMANN DR SE 210, LACEY WA 98503"` yields both `…DR SE 210 98503` and `…DR SE 98503`; `"NONE, TACOMA WA 98402"`→[]; `"9680 153RD AVE NE B2 REDMOND WA 98052"` yields city-peeled + unit-peeled combos; `"1234 BROADWAY 98501"` unchanged (no tail token before digit).

### Task 4 — RD normalizer + org domain lane (identifiers.ts)
- **ACTION**:
  1. `normalizeRootDomain(raw)`: trim, lowercase; strip `scheme://`, leading `www.`, path/query/port; reject if no `.`, contains spaces, is an IP, or host ∈ `SHARED_HOST_DENYLIST` (facebook.com, instagram.com, google.com, yelp.com, angi.com, homeadvisor.com, thumbtack.com, linkedin.com, nextdoor.com, bbb.org, yellowpages.com — platform hosts identify nobody). NO eTLD+1 folding: both sides normalize through this same function, so `sub.example.com` vs `example.com` simply fails to match — fail-closed, never wrong (documented in the function comment).
  2. `persistOrganizationIdentifiers`: optional `website` on `OrgIdentifierInput` → `root_domain` row (raw = input, normalized = normalizeRootDomain).
  3. `loadOrganizationDomains(db)` — copy of `loadOrganizationPhones` over `identifier_type = 'root_domain'`.
  4. `packages/domain/src/normalized-record.ts`: optional `website` field on organizations[] (comment: additive, skip-safe — populates as parsers/sources emit it); thread through the resolver's persist call.
- **GOTCHA**: registry `root_domain` values come normalized by the registry — still pass through `normalizeRootDomain` on read (Task 6) so a drifting registry form can't silently mismatch. Denylist check runs on the FULL host after www-strip.
- **VALIDATE**: tests: `"https://www.NWMechanical.com/about"`→`nwmechanical.com`; `"facebook.com/nwmech"`→null; `"10.0.0.1"`→null; `"nw mechanical"`→null.

### Task 5 — 4B.3 shared-bucket address matching (registry-observations.ts)
- **ACTION**:
  1. `buildRegistryAddressIndex` → `Map<string, RegistryIdentityRow[]>` built from `addressMatchKeyCandidates(row.registeredAddress, row.registeredPostalCode)` (candidates on the REGISTRY side too); keep every row per key (no more drop-to-null).
  2. `matchOrgByAddress`: for each org key, collect the bucket; single-row bucket keeps the existing ≥`PHONE_MATCH_MIN_NAME_SIMILARITY` gate; multi-row bucket requires new exported constants `ADDRESS_SHARED_MIN_NAME_SIMILARITY = 0.5` AND `ADDRESS_DOMINANCE_MARGIN = 0.2` (best − second ≥ margin) — otherwise no candidate from that bucket. Best across all keys wins as before.
- **GOTCHA**: dedupe rows within a bucket by entityId (candidate variants can insert the same row under one key twice). Payload gains `shared_address_bucket_size` for the reviewer.
- **VALIDATE**: registry-observations.test.ts: two entities at one address, org name-sim 0.9 vs 0.2 → match; 0.55 vs 0.45 → no match (margin); 0.45 vs 0.1 → no match (floor); single-row bucket at 0.35 → match (old behavior preserved).

### Task 6 — 4B.2 google-phone rule + RD domain rule (registry-observations.ts binding loop)
- **ACTION**: Build alongside `byPhone` (UNIQUE_KEY_INDEX pattern):
  - `byGooglePhone`: from `row.googlePhone` normalized via `normalizePhoneUS`; a google phone equal to ANY L&I phone of a DIFFERENT entity, or shared between entities, is dropped (null).
  - `byDomain`: from `normalizeRootDomain(row.rootDomain)`; unique-only.
  - `orgDomains = await loadOrganizationDomains(db)`.
  In the unbound-org loop, after the L&I-phone branch and BEFORE the address branch, add google-phone matching (NAME_GATED_WEAK_MATCH, sim ≥ 0.3): `ruleKey = "binding_google_phone_match"`, `nameComponent = sim`, `identifier = 0.75` (de-rated — DE_RATED_SECONDARY_CHANNEL: a Google-profile phone is account-entered, not L&I-verified). After the address branch, add domain matching: `ruleKey = "binding_domain_match"`, `identifier = 1` (a registered website root domain is entity-specific once denylisted+unique), sim ≥ 0.3 gate. Payload gains `matched_channel: "google_phone" | "root_domain"` + the matched value.
- **GOTCHA**: order = L&I name/phone → google phone → address → domain (strongest evidence first; first hit wins, `dedupeKey` unchanged `bind:${org.id}:${hit.entityId}` so re-runs and cross-rule dupes stay single). Both rules ride observation_type `binding_name_match` ⇒ automatically excluded from auto-accept. No TRUST_WEIGHTS changes.
- **VALIDATE**: tests: google phone unique + sim 0.5 → candidate with ruleKey/identifier 0.75; google phone colliding with another entity's L&I phone → no candidate; domain match honest case; denylisted domain never indexed; L&I phone hit wins over google phone for same org.

### Task 7 — 4B.4 accept-side backfeed (identifiers.ts + registry-observations.ts)
- **ACTION**: New `backfeedAcceptedIdentity(db, organizationId, snapshot)` in identifiers.ts: from the accepted observation's `payload_json.snapshot` (identitySnapshot shape: `ubi`, `contractor_numbers[]`), NULL-ONLY update `organizations.ubi` / `contractor_registration` (NULL_ONLY_BACKFEED pattern, first contractor_number), and upsert `organization_identifiers` rows (`ubi`, `contractor_number` for each) with `source_record_id = NULL, provenance = 'registry_accept'` (ON CONFLICT → `last_seen_at = now()` — existing rows keep their original provenance). Call it inside `decideRegistryObservation` accept branch for `binding_name_match`, right after the registry_ref UPDATE (:746-754).
- **GOTCHA**: normalize via the same `alnumUpper`/≥7 UBI floor as persist; never overwrite; the upsert must now include the provenance column (Task 1 lands first). This is what makes WS-B.4 (`findBoundOrganizationByStrongKey`) and the nightly strong-key link fire for subsequent records — the actual learning fix.
- **VALIDATE**: DB-backed test (worker harness or resolution DB test per Phase 1 deviation precedent): accept a seeded binding observation → org has ubi/license set, identifier rows exist with provenance `registry_accept`; org with pre-existing ubi unchanged.

### Task 8 — 4B.5 telemetry + `match:audit` CLI
- **ACTION**:
  1. `GenerateSummary` gains `belowFloor: number` (candidates computed but skipped at `trust < MIN_QUEUE_TRUST`) and per-rule counts `byRule: Record<string, number>`; increment in the persist loop; include in the completion log.
  2. `apps/worker/src/cli/match-audit.ts` (mirror an existing CLI's structure): queries `registry_observations` grouped by `rule_key` × `status` → prints per-rule generated/pending/accepted/rejected/auto-accepted, human-review Laplace rate, min/median/max trust, plus a near-floor band count (trust in [MIN_QUEUE_TRUST, MIN_QUEUE_TRUST+0.1)). Package script `"match:audit": "tsx src/cli/match-audit.ts"`.
- **VALIDATE**: `pnpm --filter @otn/worker match:audit` runs against local DB; unit test for any pure aggregation helper if extracted.

### Task 9 — 4A.2 pursuit outcomes → decision_labels
- **ACTION**: In `transitionPursuit` (pursuit.ts:113), when `to ∈ {"won","lost","no_bid"}` and AFTER the existing validation gates (reason required :141, outcomeDate for won/lost :144) and the state UPDATE + pursuit_transitions insert: read a DECISION_LABEL_SNAPSHOT (opportunity `current_score/route/score_version/state`, `rationale_json->'signals'`, project county/stage/corroboration — same SELECT shape as state/route.ts:32) **before** the update, then INSERT `decision_labels (account_profile_id, opportunity_id, kind='pursuit_outcome', decided_by = input.actorId, snapshot, reason = input.reason, notes = null)` where snapshot also carries `{outcome: to, fromState, submittedValue, outcomeValue, estimatedContractValue}` from the pursuit row.
- **GOTCHA**: kind `pursuit_outcome` is already CHECK-admitted (0027:21) — no migration. HUMAN_ONLY already guarantees these are human decisions. Cockpit affordance: the transition API + `allowedTransitions` already exist; verify the pursuit detail UI renders won/lost/no_bid actions and add buttons only if missing (no new routes).
- **VALIDATE**: DB test: seed pursuit in `submitted`, transition to `won` with reason+outcomeDate → decision_labels row kind=pursuit_outcome, snapshot has outcome/score; transition to `qualified` → NO label. Full intelligence suite.

### Task 10 — 4A.3 `docs/calibration-prep-solis.md`
- **ACTION**: Write the prep doc: (a) label inventory SQL (counts by kind, promote/dismiss by route band and score decile, pursuit_outcome win rates); (b) per-account precision readout (priority-band dismiss rate as FP proxy; promoted-then-lost as calibration nuance); (c) `match:audit` walkthrough + how rule histories inform MIN_QUEUE_TRUST/auto-accept gates; (d) proposed §12.3 session agenda (inputs, decisions to make, freeze-lift criteria). Numbers come from queries run at session time — the doc ships QUERIES, not fabricated results.
- **VALIDATE**: queries execute against local DB.

### Task 11 — 4A.1 Contractor Activity Score (registry repo)
- **ACTION**:
  1. Migration `20260723090000_contractor_activity_score_v1.sql` (+ byte-identical baseline `29_…`, census row): `registry_internal.contractor_activity_score_v1` — REGISTRY_VIEW_DISCIPLINE — joining `tenants` (trades vertical, `settings->>'ubi'` normalized alnum-upper) → `registry_public.trades_identity_v1` (by ubi) → LEFT `registry_public.trades_activity_v1` (by entity_id). Columns: `tenant_id, entity_id, activity_score, permit_component, credential_component, web_component, project_count, project_count_12m`. Formula (disclosed in COMMENT ON VIEW): permit 0.5 × `least(coalesce(project_count_12m, project_count)::numeric / 12, 1)`; credential 0.3 × (has ubi + has contractor_number + active status)/3; web 0.2 × (has root_domain + has google_rating with review_count ≥ 5)/2; `activity_score = round(100 × sum)`. **Sample gate**: row exists ONLY when a partner rollup exists (INNER join semantics on trades_activity_v1 for the score; entities without public permit evidence get NULL score → never fabricated, never "0").
  2. `serviceDirectoryData.ts`: LEFT JOIN the view on `tenant_id`; ORDER BY `g.sponsor_rank DESC, s.activity_score DESC NULLS LAST, g.registry_score DESC, g.gym_name ASC`; surface `activityScore` on `ServiceDirectoryCard`.
  3. Disclosure line on city/state directory pages (light register): "Ranked by Contractor Activity Score — public permit activity (via OTN Insights), verified L&I credentials, and web presence. Businesses without sufficient public data are listed unscored." Pin copy + view read in `scripts/pseo-quality-gate.mjs`.
  4. Profile: `ContractorProfilePage` optional `activityScore` prop → small panel beside Permit activity showing the score + three component chips with basis; `contractor/[slug]/page.tsx` fetches from the view by tenant (try/catch → null, no panel — honest empty).
- **GOTCHA**: BJJ untouched (BJJ pages use classQuery/programDirectory, not serviceDirectoryData — verified in that file's header). The score is registry-display ONLY; nothing in Insights reads it. NULLS LAST keeps non-trades service verticals byte-order-identical (their join yields all NULLs).
- **VALIDATE**: `npx tsc --noEmit` (apps/registry), `npm run test:security`, `node scripts/pseo-quality-gate.mjs`, dual builds (`NEXT_PUBLIC_SITE_KEY=onetradenetwork|bjj`); migration applied local-equivalent then hosted via MCP `apply_migration`; live spot-check: score present for entities with rollups (e.g. the Solis-adjacent bound entities), NULL elsewhere.

### Task 12 — Hosted applies + live pass + close-out
- **ACTION**: Insights: `pnpm db:migrate` hosted (0030); one `pnpm maintenance:run` (Governance: never 2 concurrent) → capture new-rule candidate counts + `match:audit` output; spot-check any new `binding_google_phone_match`/`binding_domain_match`/shared-address candidates manually (they queue for the owner, nothing binds). Registry: `apply_migration` for the score view; verify ledger + baseline diff byte-identical. Both repos: full suites (`pnpm -r test` → expect 681+ green, `pnpm -r typecheck` 11/11), `pnpm eval:run` GATES PASS **byte-identical**, commit+push each trunk (conventional commits), update `docs/STATUS.md`, extend `registry-insights-flywheel-phases-1-4-report.md` Phase 4 section, update memory (`otn-cockpit-colocation-plan`, mark `flywheel-phase4-approved-scope` executed).
- **GOTCHA**: digest re-runs delete draft deliveries first; vitest requires local Docker DB (PG_PORT=5433).

---

## Testing Strategy (new tests)
| Test | Input | Expected |
|---|---|---|
| phone ext strip ×4 | `x102` / `ext. 5` / `#12` / no-ext | 10-digit / 10-digit / 10-digit / unchanged |
| placeholder address | `"NONE, TACOMA WA 98402"` | `[]` candidates |
| unit-noise peel | `"1210 HOMANN DR SE 210 …98503"` | primary + peeled variant |
| shared-bucket dominance | sims (0.9,0.2) / (0.55,0.45) / (0.45,0.1) | match / none / none |
| google-phone rule | unique gphone, sim 0.5 | candidate, identifier 0.75, own ruleKey |
| gphone collides with L&I | gphone == other entity's phone | dropped |
| domain rule + denylist | real domain / facebook.com | candidate / never indexed |
| backfeed on accept | accept seeded binding | org ubi+license set, identifier rows provenance `registry_accept`; pre-set ubi untouched |
| pursuit outcome label | submitted→won | decision_labels kind=pursuit_outcome w/ snapshot |
| non-outcome transition | qualified→bid_confirmed | no label |
| score neutrality | full eval | gates byte-identical |

## Validation Commands
```bash
# Insights (C:\Users\Snipe\Downloads\TradesInsights)
pnpm -r typecheck                      # 0 errors, 11/11
pnpm --filter @otn/resolution test     # identifiers + registry-observations
pnpm --filter @otn/intelligence test
pnpm -r test                           # full suite ≥ 681 green
pnpm db:migrate                        # local then hosted
pnpm eval:run                          # GATES PASS byte-identical (precision 1.0 / recall 0.9609375)
pnpm --filter @otn/worker match:audit

# Registry (worktree trades-google-place-integration-v2)
cd apps/registry && npx tsc --noEmit
npm run test:security                  # 64/64+
node scripts/pseo-quality-gate.mjs
NEXT_PUBLIC_SITE_KEY=onetradenetwork npm run build && NEXT_PUBLIC_SITE_KEY=bjj npm run build
```

## Acceptance Criteria
- [ ] All 12 tasks complete; all validation commands pass; eval gates byte-identical
- [ ] Zero auto-binds from new rules (observation_type gate verified by test)
- [ ] Hosted: 0030 + registry patch 29 applied, ledger-recorded; one maintenance pass ran; new candidates (if any) sit in the review queue
- [ ] Both trunks pushed; STATUS/report/memory updated

## Risks
| Risk | L | I | Mitigation |
|---|---|---|---|
| Registry-side candidate keys inflate shared buckets (candidates on both sides multiply keys) | M | M | dominance margin + floor; bucket-size in payload; match:audit shows per-rule volumes before owner reviews |
| Google phones heavily recycled (call-tracking numbers) | M | L | unique-only index + cross-check vs all L&I phones + 0.75 de-rate + review-only |
| `source_record_id DROP NOT NULL` weakens evidence invariant | L | M | provenance CHECK column makes NULL legal ONLY for `registry_accept`; test pins it |
| Directory ORDER BY change perturbs non-trades verticals | L | M | NULLS LAST + view only has trades rows; keep `registry_score` as tiebreaker |
| Score formula seen as fabricated ranking | L | M | disclosed basis pinned in pSEO gate; NULL (unscored) never 0 |

## Confidence: 8/10 — all anchors read this turn at exact lines; the two DB-backed test harness choices (Task 7/9) follow the Phase 1 deviation precedent rather than new infrastructure.
