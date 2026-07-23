# Plan: Organization alias capture + alias-aware binding

## Summary
Capture the organization name-variants the resolver currently discards into
`insights.organization_aliases`, backfill them from history, and teach the
binding matcher to match an Insights org's aliases (not just its canonical name)
against the registry — widening name-based binding with data we already hold, no
external calls. This is the name/alias arm of the cross-platform identity-graph
strategy (Phases 0+1, enabling Phase 3).

## User Story
As the operator maintaining the registry↔Insights knowledge map, I want every
name a company was seen under to become a match key, so that an org whose
canonical name drifts still binds to its L&I entity instead of sitting unlinked.

## Problem → Solution
Resolver collapses "Southwest Plumbing LLC" and "SW Plumbing" onto one org but
throws the loser away; `organization_aliases` = 0 rows, 0 writers; the binding
matcher only ever sees `organizations.canonical_name`. → Record each variant as
an alias (forward + backfill) and match aliases too, so a drifted or DBA-style
name still finds its registry entity.

## Metadata
- **Complexity**: Medium–Large
- **Source strategy doc**: `docs/cross-platform-identity-graph-strategy.md` (Phases 0+1→3)
- **PRD Phase**: N/A (strategy-doc child)
- **Estimated Files**: ~7 (1 schema + 1 migration + resolver + identifiers + registry-observations + 1 CLI + tests)
- **Repo**: TradesInsights, trunk `claude/tmux-install-320aiz`
- **NOT in this PRP**: L&I DBA ingest (registry-side, Phase 2 PRP) and Google Places enrichment (Phase 4 PRP). Auto-bind expansion for alias matches is DEFERRED — alias candidates enter the human review queue; the owner decides auto-bind after seeing matches.

---

## UX Design
Internal + review-queue change. Alias-matched candidates appear in the existing
registry-review page (`/app/admin/registry-review`) as `binding_alias_exact` rows,
tiered by `classifyReviewTier`. No new page.

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Registry review queue | canonical-name matches only | + alias matches (rule `binding_alias_exact`) | evidence shows which alias matched |
| Resolver run | variant discarded | variant → `organization_aliases` | idempotent, source-provenanced |

---

## Mandatory Reading
| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `packages/resolution/src/resolver.ts` | 108–185 (`upsertOrganizationsAndRoles`) | where variants collapse — the alias-capture hook site |
| P0 | `packages/resolution/src/identifiers.ts` | 275–380 (`persistOrganizationIdentifiers`, loaders) | exact INSERT…ON CONFLICT + Map-loader patterns to mirror |
| P0 | `packages/resolution/src/registry-observations.ts` | 360–560 (binding loop) | where name matching happens; add alias index + rule |
| P0 | `packages/resolution/src/normalize.ts` | 187–231 (`orgNameKey`, `nameSimilarity`, `normalizeOrgName`) | canonical + match normalization |
| P1 | `packages/db/src/schema.ts` | 293–301 (`organizationAliases`) | table shape; needs a unique index |
| P1 | `packages/resolution/src/registry-observations.ts` | 138–143 (`crossNameKey`) | the cross-system key both sides fold through |
| P1 | `packages/resolution/src/registry-observations.ts` | `classifyReviewTier` | tier the new alias rule |
| P2 | `apps/worker/test/registry-observations.test.ts` | all | integration test harness (`testDb`, seed pattern) |
| P2 | `apps/worker/src/cli/strict-bind.ts` | all | CLI skeleton to mirror for the backfill CLI |

## External Documentation
None — internal-only, uses established patterns.

---

## Patterns to Mirror

### IDENTIFIER_UPSERT (raw SQL, dedupe by ON CONFLICT)
// SOURCE: identifiers.ts:302-310
```ts
await db.execute(sql`
  INSERT INTO organization_identifiers
    (organization_id, identifier_type, value_raw, value_normalized, source_record_id)
  VALUES (${organizationId}, ${row.type}, ${row.raw}, ${row.normalized}, ${sourceRecordId})
  ON CONFLICT (organization_id, identifier_type, value_normalized)
  DO UPDATE SET last_seen_at = now()`);
```

### MAP_LOADER (evidence per org → Set, match key at load time)
// SOURCE: identifiers.ts:404-421 (loadOrganizationAddresses)
```ts
export async function loadOrganizationAddresses(db: Db): Promise<Map<string, Set<string>>> {
  const res = await db.execute(sql`SELECT organization_id, value_raw FROM organization_identifiers WHERE identifier_type = 'address'`);
  const map = new Map<string, Set<string>>();
  for (const r of res.rows as { organization_id: string; value_raw: string }[]) {
    const keys = addressMatchKeyCandidates(r.value_raw);
    if (keys.length === 0) continue;
    const set = map.get(r.organization_id) ?? new Set<string>();
    for (const key of keys) set.add(key);
    map.set(r.organization_id, set);
  }
  return map;
}
```

### RESOLVER_COLLAPSE (where the variant is known and lost)
// SOURCE: resolver.ts:113-148
```ts
for (const org of row.normalized.organizations) {
  const norm = normalizeOrgName(org.name);
  let orgId = (await findOrganizationBySourceEntityId(db, org.sourceEntityId)) ?? undefined;
  if (!orgId) orgId = (await findBoundOrganizationByStrongKey(db, org.ubi, org.contractorLicense)) ?? undefined;
  if (!orgId) { /* exact canonical-name match */ }
  if (!orgId) { /* insert new */ }
  if (org.phone || org.ubi || ...) await persistOrganizationIdentifiers(db, orgId, row.id, org);
  // ← org.name (raw) + orgId in hand here; today the variant is discarded.
}
```

### BINDING_NAME_INDEX (registry side → rows by cross-key)
// SOURCE: registry-observations.ts:364-372
```ts
const byNameKey = new Map<string, RegistryIdentityRow[]>();
for (const row of registryRows) {
  if (!row.canonicalName) continue;
  const key = crossNameKey(row.canonicalName);
  if (!key) continue;
  (byNameKey.get(key) ?? byNameKey.set(key, []).get(key))!.push(row);
}
```

### TEST_STRUCTURE (integration, real testDb)
// SOURCE: apps/worker/test/registry-observations.test.ts:62-111 — insert accountProfiles/organizations/projects/sourceRecords, INSERT project_roles via sql, assert via db.execute; unique RUN suffix; afterAll cleanup.

### CLI_SKELETON
// SOURCE: apps/worker/src/cli/strict-bind.ts — `import "../load-env.js"`, createPool/createDb, createLogger, `main().catch(err => { console.error(err); process.exit(1); })`.

---

## Files to Change
| File | Action | Justification |
|---|---|---|
| `packages/db/src/schema.ts` | UPDATE | add unique index `(organization_id, alias)` to `organizationAliases` for idempotent ON CONFLICT |
| `packages/db/migrations/0031_*.sql` (+ meta) | CREATE | generated migration for the unique index (drizzle-kit) |
| `packages/resolution/src/identifiers.ts` | UPDATE | add `persistOrganizationAlias` + `loadOrganizationAliases` |
| `packages/resolution/src/resolver.ts` | UPDATE | call `persistOrganizationAlias` when the incoming name is a real variant of the resolved org |
| `packages/resolution/src/registry-observations.ts` | UPDATE | build alias index for unbound orgs; add `binding_alias_exact` rule; tier it |
| `packages/resolution/src/registry-observations.test.ts` | UPDATE | pure tests: alias match key + tier for the new rule |
| `apps/worker/test/registry-observations.test.ts` | UPDATE | integration: resolver writes alias on strong-key collapse; alias produces a candidate |
| `apps/worker/src/cli/alias-backfill.ts` | CREATE | one-time backfill of aliases from historical source_records |
| `apps/worker/package.json` | UPDATE | `alias:backfill` script |

## NOT Building
- L&I DBA ingest (registry repo, Phase 2 PRP).
- Google Places enrichment (Phase 4 PRP).
- Auto-binding alias matches (deferred; they go to review — owner decides after seeing them).
- Registry-side alias surfacing on the contract view (needs registry aliases first → Phase 2).
- Business-address-city locality promotion — **optional Task 8** below; may be split to a follow-up.

---

## Step-by-Step Tasks

### Task 1: Unique index on organization_aliases
- **ACTION**: In `schema.ts` `organizationAliases`, add `uniqueIndex("organization_aliases_org_alias_ux").on(t.organizationId, t.alias)` alongside the existing alias index.
- **MIRROR**: `registryObservations` uniqueIndex usage (schema.ts:1014).
- **GOTCHA**: table has no unique constraint today; without it `ON CONFLICT` can't dedupe.
- **VALIDATE**: `pnpm --filter @otn/db exec drizzle-kit generate` produces migration `0031_*.sql` adding the unique index; review it adds nothing else.

### Task 2: persistOrganizationAlias
- **ACTION**: In `identifiers.ts`, add `persistOrganizationAlias(db, organizationId, alias, sourceId?)` that INSERTs the raw variant with ON CONFLICT DO NOTHING.
- **IMPLEMENT**:
```ts
export async function persistOrganizationAlias(
  db: Db, organizationId: string, alias: string, sourceId: string | null,
): Promise<boolean> {
  const trimmed = alias.trim();
  if (!trimmed) return false;
  const res = await db.execute(sql`
    INSERT INTO organization_aliases (organization_id, alias, source_id)
    VALUES (${organizationId}, ${trimmed}, ${sourceId})
    ON CONFLICT (organization_id, alias) DO NOTHING
    RETURNING organization_id`);
  return res.rows.length > 0;
}
```
- **MIRROR**: IDENTIFIER_UPSERT pattern.
- **GOTCHA**: `source_id` references `sources.id` (the SOURCE, a uuid), NOT `source_records.id`. The resolver has the source id on `RecordRow`; pass it or null (FK is nullable).
- **VALIDATE**: unit — inserting the same (org, alias) twice returns true then false.

### Task 3: loadOrganizationAliases
- **ACTION**: In `identifiers.ts`, add `loadOrganizationAliases(db): Promise<Map<string, Set<string>>>` returning per-org **cross-key-normalized** alias keys.
- **IMPLEMENT**: SELECT organization_id, alias; fold each `alias` through `crossNameKey` (import from registry-observations) — but to avoid a circular import, fold through `orgNameKey`/the same normalization the binding uses. **Decision**: move `crossNameKey` to `normalize.ts` (or export a shared `orgMatchKey`) so both identifiers.ts and registry-observations.ts use it without a cycle. Skip empty keys.
- **MIRROR**: MAP_LOADER (loadOrganizationAddresses).
- **GOTCHA**: circular import — `crossNameKey` currently lives in registry-observations.ts. Relocate it to `normalize.ts` and re-export, updating registry-observations.ts to import it. (Pure move; unit tests unchanged.)
- **VALIDATE**: unit — two aliases folding to the same key dedupe to one.

### Task 4: Capture aliases in the resolver
- **ACTION**: In `resolver.ts` `upsertOrganizationsAndRoles`, after `orgId` is resolved, if the incoming raw `org.name`'s match key differs from the org's stored canonical's match key, call `persistOrganizationAlias(db, orgId, org.name, <sourceId>)`.
- **IMPLEMENT**: fetch the resolved org's `canonical_name` (already selected when name-matched; SELECT it when reused via sourceEntityId/strong-key), compare `crossNameKey(org.name) !== crossNameKey(canonical)`; when different, persist the alias.
- **MIRROR**: RESOLVER_COLLAPSE site; persist call sits right after the identifier persist (line 148).
- **GOTCHA**: don't write an alias equal to the canonical (same key) — noise. Only genuine variants (different key) become match keys. Need the source id — thread `row.sourceId` (confirm the field on `RecordRow`).
- **VALIDATE**: integration — a second record naming the same strong-key entity under a different name writes exactly one alias.

### Task 5: Alias-aware binding rule
- **ACTION**: In `registry-observations.ts` binding loop, for an unbound org with no unique canonical-name hit, try each of its **alias** keys against `byNameKey`; a unique hit becomes a candidate with `ruleKey = "binding_alias_exact"`, `nameComponent = 1`, identifier neutral (0.5).
- **IMPLEMENT**: load `orgAliases = await loadOrganizationAliases(db)`; in the loop, after the existing name/phone/address/domain attempts, if still no `hit`, iterate `orgAliases.get(org.id)` keys, look up `byNameKey`, take a unique (length===1) hit. Payload records `matched_alias`. dedupeKey stays `bind:${org.id}:${hit.entityId}`.
- **MIRROR**: BINDING_NAME_INDEX + the existing unique-hit handling (registry-observations.ts:409-414).
- **GOTCHA**: an alias that matches MULTIPLE registry entities is ambiguous → skip (same rule as canonical). Never auto-bind (alias rule excluded from strict tier for now — deferred).
- **VALIDATE**: integration — an org whose canonical doesn't match but whose alias equals a registry canonical yields one `binding_alias_exact` pending candidate; org stays unbound until reviewed.

### Task 6: Tier the alias rule
- **ACTION**: In `classifyReviewTier`, treat `binding_alias_exact` like `binding_name_exact` (tier1 if same city, else tier2).
- **IMPLEMENT**: extend the `nameExact` check: `ruleKey === "binding_name_exact" || "binding_name_phone" || "binding_alias_exact"` with `name >= 1`.
- **MIRROR**: existing `classifyReviewTier` binding branch.
- **VALIDATE**: unit — `binding_alias_exact` + same city → tier1.

### Task 7: Alias backfill CLI
- **ACTION**: `apps/worker/src/cli/alias-backfill.ts` + `alias:backfill` script — one pass over historical data populating aliases the resolver-going-forward can't.
- **IMPLEMENT**: for each org, gather distinct raw party names seen across its `project_roles → source_records.normalized_json->'organizations'` where the name maps to that org; write those whose match key differs from the org's canonical via `persistOrganizationAlias`. Log counts. Idempotent (ON CONFLICT).
- **MIRROR**: CLI_SKELETON (strict-bind.ts); the org↔party-name linkage query mirrors the `orgPermitTrades` join style in registry-observations.ts.
- **GOTCHA**: the `organizations` array element isn't keyed to `organization_id` directly — join by `crossNameKey(element.name)` back to the org's known names, OR (simpler/robust) reconstruct via the same resolver clustering. Simplest correct approach: for each org, take the party names on its `project_roles.source_record_id` records and keep those whose key ≠ canonical key. Accept minor over-capture (all are real variants seen on that org's permits).
- **VALIDATE**: run against local Docker DB seed; assert alias rows created; rerun = 0 new.

### Task 8 (OPTIONAL — may split to follow-up): business-address-city locality
- **ACTION**: fold each org's address-identifier city into the `locality` signal in the binding loop, so an exact-name match whose contractor business-city equals the registry `city_token` reaches `locality = 1` (promoting tier2→tier1) even when permit job-cities differ.
- **IMPLEMENT**: derive city from `organization_identifiers` address `value_raw`; add to the localities set used at registry-observations.ts:502.
- **VALIDATE**: unit over injected rows; live preview shows tier2→tier1 movement for address-carrying orgs.
- **NOTE**: include only if it doesn't bloat the PR; otherwise its own small PRP.

---

## Testing Strategy
### Unit Tests (packages/resolution/src/*.test.ts — no DB)
| Test | Input | Expected | Edge? |
|---|---|---|---|
| alias match-key dedup | two aliases → same crossNameKey | one key | yes |
| tier for alias rule | `binding_alias_exact`, locality 1 | tier1 | |
| tier for alias rule | `binding_alias_exact`, locality 0.3 | tier2 | |
| crossNameKey relocation | existing crossNameKey cases | unchanged | regression |

### Integration Tests (apps/worker/test — testDb)
| Test | Expected |
|---|---|
| resolver writes alias on strong-key collapse | one alias row, key ≠ canonical |
| resolver writes NO alias for a same-key variant | zero alias rows |
| alias produces a `binding_alias_exact` candidate | pending; org unbound |
| ambiguous alias (2 entities) | no candidate |
| backfill idempotent | rerun adds 0 |

### Edge Cases Checklist
- [ ] Empty/whitespace alias → skipped
- [ ] Alias equal to canonical → not stored
- [ ] Alias matching multiple registry entities → skipped
- [ ] Rerun (resolver + backfill) → no duplicates
- [ ] No registry connection → generation still skips visibly

---

## Validation Commands
### Static Analysis
```bash
pnpm --filter @otn/resolution typecheck && pnpm --filter @otn/worker typecheck && pnpm --filter @otn/db typecheck
```
EXPECT: zero type errors

### Unit + Integration Tests (Docker DB up on 5433)
```bash
PG_PORT=5433 docker compose up -d postgres
pnpm exec vitest run packages/resolution/src/registry-observations.test.ts packages/resolution/src/identifiers.test.ts apps/worker/test/registry-observations.test.ts
```
EXPECT: all pass

### Migration
```bash
pnpm --filter @otn/db exec drizzle-kit generate   # produces 0031_*
```
EXPECT: only the unique index diff

### Live preview (read-only — reuse the strict-bind dry-run to see alias candidates surface)
```bash
pnpm --filter @otn/worker strict-bind:preview
```
EXPECT: `binding_alias_exact` candidates appear in the review queue after a maintenance run; no auto-binds (deferred)

### Manual Validation
- [ ] After `alias:backfill`, `SELECT count(*) FROM insights.organization_aliases` > 0
- [ ] Registry review page shows `binding_alias_exact` rows with the matched alias in evidence

---

## Acceptance Criteria
- [ ] `organization_aliases` populated (backfill + forward capture), deduped
- [ ] Alias matches surface as `binding_alias_exact` review candidates, tiered
- [ ] No alias auto-binds (deferred to owner review)
- [ ] All validation commands pass; no regressions in the 95 resolution + 18 worker tests

## Completion Checklist
- [ ] Patterns mirrored (INSERT…ON CONFLICT, MAP_LOADER, CLI skeleton)
- [ ] crossNameKey relocated cleanly (no circular import), existing tests green
- [ ] Provenance on every alias (source_id) — no fabricated data
- [ ] Idempotent forward + backfill

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Over-capture of junk aliases (typo variants) | Med | Low | only store key ≠ canonical; review-gated, never auto-bind |
| Circular import moving crossNameKey | Med | Med | relocate to normalize.ts, re-export, run existing tests |
| Alias→multiple entities false match | Low | Med | skip ambiguous keys (same guard as canonical) |
| Backfill mis-links party name to wrong org | Low | Med | link only via that org's own project_roles records |
| Alias index bloats matching | Low | Low | unique per (org,alias); load once per pass |

## Notes
- Strong-key propagation (phone→UBI) already exists (`persistOrganizationIdentifiers` backfeed + `findBoundOrganizationByStrongKey`); this PRP adds the NAME/alias arm only.
- After this lands, Phase 2 (L&I DBA) makes registry aliases available to match the OTHER direction, and Phase 4 (free Google Places) adds place/phone keys for orgs with no name match at all.
- **Confidence: 8/10** single-pass — the one real unknown is the exact `RecordRow.sourceId` field name (confirm in resolver.ts imports) and the drizzle-kit generate flow; both are quick reads at implement time.
