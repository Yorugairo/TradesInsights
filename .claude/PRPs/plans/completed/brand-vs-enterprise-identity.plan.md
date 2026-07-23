# Plan: Brand-vs-enterprise identity (operating brand in Insights, legal entity in OTN)

## Summary
Insights keeps modelling the **operating brand** (what a permit names, who you call);
OTN/registry stays the authority on the **legal entity**. They are linked
many-to-one via `organizations.registry_ref`, so combined in-region
contracts/dollars roll up per enterprise while brand rows — and their contacts —
stay distinct. The mechanism that makes this work is a **brand-scoped identity
backfeed**: an accept stamps only the matched brand's licence, not the entity's
whole licence array.

## User Story
As the operator, I want two brands of one legal entity (Apollo Sheet Metal,
Apollo Mechanical) to stay separate rows that still roll up together, so I can
see combined regional volume AND know who to call for that specific operation —
while genuine spelling duplicates of ONE brand still collapse.

## Problem → Solution
Accepting a binding stamps the entity's ENTIRE `contractor_numbers` array onto
every org bound to it, so the WS-B.4 resolver tier then fuses distinct brands
into one row. → Record which brand matched, stamp only that brand's licence, and
collapse on licence (brand-unique) rather than UBI (enterprise-wide).

## Metadata
- **Complexity**: Large
- **Source**: conversational design, 2026-07-23 (owner approved A–D)
- **Estimated Files**: ~12
- **Repos**: registry `release/trades-staging` (Task D); TradesInsights `claude/tmux-install-320aiz` (A, B, C)

### The two-level key L&I already gives us (verified live)
| Level | Key | Apollo (UBI 600443607) |
|---|---|---|
| Enterprise (legal entity) | **UBI** — shared | `600443607` on all three |
| Establishment (operating brand) | **contractor licence** — unique per brand | `APOLLHC867J1` / `APOLLMC795NR` / `APOLLSM006J6` |

Alias→licence and canonical→licence are both already stored:
`registry_entity_aliases.source_record_id` and
`registry_business_entities.primary_source_record_id` → `raw->'settings'->'license'->>'number'`.
Verified: `Apollo Mechanical Contractors → APOLLMC795NR`,
`Apollo Sheet Metal Inc → APOLLSM006J6`, `2 Sons Plumbing → 2SONSSP759CF`,
`Patriot Plumbing Htg & Cooling → PATRIPH765QM`.

---

## ⚠️ Two findings that change the plan

**1. Task ordering must be D → C → A (B is independent).** The owner listed A–D.
A alone does NOT preserve brands, because the fusion happens in the *backfeed*,
not only in WS-B.4:
`backfeedAcceptedIdentity` (identifiers.ts:517-523) stamps **every** licence in
`snapshot.contractor_numbers` onto the org, so after accepting both Apollo rows
both orgs hold all three licences and the licence arm of WS-B.4 fuses them
regardless of the UBI arm. C (brand pin + brand-scoped backfeed) is therefore a
**prerequisite** for A, and C needs D's licence mapping.

**2. An earlier claim was wrong and is corrected here.** It was stated that
spelling-variant pairs "already share a licence number". They do not: **0 of the
37 orgs** in the 18 multi-org clusters carry a licence OR a UBI today. They have
no strong keys at all until an accept backfeeds them. The collapse the owner
approved is delivered *by this plan* (same brand ⇒ same licence ⇒ WS-B.4
collapses), not by existing behaviour.

### What the finished system does
| Case | Brands matched | Licences stamped | Result |
|---|---|---|---|
| `CHRISTIAN'S ROOFING` ×3 | same brand | same licence | **collapse** ✔ owner-approved |
| `APOLLO SHEET METAL` vs `APOLLO MECHANICAL` | different brands | different licences | **stay separate**, share `registry_ref` ✔ |
| Either | — | — | roll up via `registry_ref`; contacts stay per brand ✔ |

---

## UX Design
Internal + one new read surface. No page changes in this plan.

| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Accept a binding | stamps entity's whole licence array | stamps only the matched brand's licence | the behavioural core |
| Resolver collapse (WS-B.4) | collapses on UBI **or** licence | collapses on licence only | UBI is enterprise-wide |
| Analytics | per-org only | per-org **and** per-enterprise rollup | new view |
| Contact | per org | unchanged (per brand) | already correct |

---

## Mandatory Reading
| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `packages/resolution/src/identifiers.ts` | 507-545 (`backfeedAcceptedIdentity`) | the fusion mechanism; Task C rewrites it |
| P0 | `packages/resolution/src/identifiers.ts` | 358-380 (`findBoundOrganizationByStrongKey`) | Task A narrows this |
| P0 | `packages/resolution/src/registry-link.ts` | 76-94 (`identitySnapshot`), 200-250 (`fetchRegistryIdentityRows`) | snapshot + contract read gain brand fields |
| P0 | `packages/resolution/src/registry-observations.ts` | 441-470 (`byNameKey` build), 1257-1271 (`applyBindingAccept`) | where the matched brand is known / applied |
| P1 | `packages/db/src/schema.ts` | 265-301 (`organizations`) | new column |
| P1 | `packages/db/migrations/0031_organization_aliases_unique.sql` | all | hand-authored migration + journal convention |
| P1 | `<registry>/apps/registry/supabase/migrations/20260723210000_trades_identity_aliases.sql` | all | contract view append-LAST + re-GRANT pattern (Task D) |
| P2 | `packages/intelligence/src/org-activity.ts` | 95-152 | aggregation SQL style for Task B |
| P2 | `apps/worker/test/registry-observations.test.ts` | 686-935 | integration harness + the DBA-alias describe block to extend |

## External Documentation
None — internal patterns only. (Concept reference: BLS/Census "establishment vs
enterprise"; no code dependency.)

---

## Patterns to Mirror

### IDENTIFIER_UPSERT (backfeed rows, provenance-stamped)
// SOURCE: identifiers.ts:527-532
```ts
await db.execute(sql`
  INSERT INTO organization_identifiers
    (organization_id, identifier_type, value_raw, value_normalized, source_record_id, provenance)
  VALUES (${organizationId}, ${row.type}, ${row.normalized}, ${row.normalized}, NULL, 'registry_accept')
  ON CONFLICT (organization_id, identifier_type, value_normalized)
  DO UPDATE SET last_seen_at = now()`);
```

### NULL_ONLY_BACKFEED (never overwrite a known value)
// SOURCE: identifiers.ts:535-543
```ts
await db.execute(sql`
  UPDATE organizations SET ubi = ${ubi} WHERE id = ${organizationId} AND ubi IS NULL`);
```

### CONTRACT_VIEW_APPEND_LAST + RE-GRANT
// SOURCE: registry `20260723210000_trades_identity_aliases.sql`
```sql
CREATE OR REPLACE VIEW registry_public.trades_identity_v1
WITH (security_invoker = false) AS
  SELECT ..., al.aliases            -- new column appended LAST
  ...
GRANT USAGE ON SCHEMA registry_public TO otn_insights_reader;
GRANT SELECT ON registry_public.trades_identity_v1 TO otn_insights_reader;
```

### SKIP_SAFE_CONTRACT_READ (deploy-order tolerance)
// SOURCE: registry-link.ts (`fetchRegistryIdentityRows`)
```ts
try { res = await pool.query(columns(true)); }
catch (err) {
  if ((err as { code?: string } | null)?.code !== "42703") throw err;
  res = await pool.query(columns(false));
}
```

### HAND_AUTHORED_MIGRATION + JOURNAL
// SOURCE: packages/db/migrations/0031_*.sql + meta/_journal.json
Insights migrations are hand-written with an explanatory header; append
`{"idx": N, "version": "7", "when": <prev+1000>, "tag": "00NN_name", "breakpoints": true}`
to `meta/_journal.json`. NEVER run `drizzle-kit generate`.

### TEST_STRUCTURE (integration)
// SOURCE: apps/worker/test/registry-observations.test.ts:686-760 — own `describe`
with its own `testDb()`, RUN-suffixed fixtures, explicit `afterAll` deletes.

---

## Files to Change
| File | Action | Justification |
|---|---|---|
| **D** `<registry>/apps/registry/supabase/migrations/<ts>_trades_identity_brands.sql` | CREATE | append `brands jsonb` to the contract |
| **C** `packages/db/migrations/0032_org_registry_brand_ref.sql` (+ journal) | CREATE | `registry_brand_ref` column |
| **C** `packages/db/src/schema.ts` | UPDATE | add the column |
| **C** `packages/resolution/src/registry-link.ts` | UPDATE | read `brands`; add brand to `identitySnapshot` |
| **C** `packages/resolution/src/registry-observations.ts` | UPDATE | record matched brand on the candidate; pass to accept |
| **C** `packages/resolution/src/identifiers.ts` | UPDATE | brand-scoped `backfeedAcceptedIdentity` |
| **A** `packages/resolution/src/identifiers.ts` | UPDATE | narrow `findBoundOrganizationByStrongKey` |
| **B** `packages/db/migrations/0033_enterprise_rollup.sql` (+ journal) | CREATE | rollup view |
| **B** `packages/intelligence/src/enterprise-rollup.ts` | CREATE | typed reader |
| tests | UPDATE | see Testing Strategy |

## NOT Building
- Merging existing org rows retroactively (the 37 rows stay as they are; this
  governs future behaviour). A backfill is a separate, owner-gated decision.
- Any UI for the rollup (view + typed reader only).
- Auto-binding alias matches — still review-gated (`viaRegistryAlias` guard stays).
- Changing `linkRegistry`'s `ubi_exact` strong-key BINDING (org→entity by UBI is
  correct and stays). Only the org→ORG collapse drops UBI.
- Person/principal → brand edges.

---

## Step-by-Step Tasks

### Task D1: Expose brands on the contract *(registry, do first)*
- **ACTION**: New migration appending `brands jsonb` to `registry_public.trades_identity_v1`, **after** `aliases`.
- **IMPLEMENT**: `LEFT JOIN LATERAL` producing
  `jsonb_agg(jsonb_build_object('name', <display>, 'licence', <licence>, 'is_canonical', <bool>) ORDER BY <display>)`
  over UNION of (a) the canonical: `e.canonical_name` + licence from
  `e.primary_source_record_id`, `is_canonical = true`; (b) each alias:
  `a.alias_display` + licence from `a.source_record_id`, `is_canonical = false`.
  Licence path: `sr.raw->'settings'->'license'->>'number'`.
- **VERIFIED SQL** (dry-run against live 2026-07-23 — returned Apollo 3 brands /
  Fischer 4 / Christian's Roofing 1, use verbatim as the LATERAL):
```sql
LEFT JOIN LATERAL (
  SELECT jsonb_agg(jsonb_build_object('name', b.nm, 'licence', b.lic, 'is_canonical', b.canon)
                   ORDER BY b.nm) AS brands
  FROM (
    SELECT e.canonical_name AS nm, psr.raw->'settings'->'license'->>'number' AS lic, true AS canon
      FROM registry_internal.registry_source_records psr
     WHERE psr.source_record_id = e.primary_source_record_id
    UNION ALL
    SELECT a.alias_display, asr.raw->'settings'->'license'->>'number', false
      FROM registry_internal.registry_entity_aliases a
      LEFT JOIN registry_internal.registry_source_records asr
        ON asr.source_record_id = a.source_record_id
     WHERE a.entity_id = e.entity_id
  ) b
) br ON TRUE
```
- **MIRROR**: CONTRACT_VIEW_APPEND_LAST + RE-GRANT.
- **GOTCHA**: `CREATE OR REPLACE VIEW` cannot insert mid-list — `brands` goes
  LAST (column 28). Re-assert both GRANTs. Rows with a NULL licence are still
  emitted with `"licence": null` (unknown = null, never invented).
- **VALIDATE**: `SELECT canonical_name, brands FROM registry_public.trades_identity_v1 WHERE canonical_name='Apollo Heating & A/C';`
  returns 3 objects with the three distinct licences; column count 27 → 28;
  `has_table_privilege('otn_insights_reader', …,'SELECT')` still true.

### Task C1: Insights reads brands
- **ACTION**: Add `brands?: RegistryBrand[] | null` to `RegistryIdentityRow`;
  select `brands` in `fetchRegistryIdentityRows`.
- **IMPLEMENT**: `export interface RegistryBrand { name: string; licence: string | null; isCanonical: boolean }`.
- **MIRROR**: SKIP_SAFE_CONTRACT_READ — extend the existing 42703 fallback to a
  three-step ladder (brands+aliases → aliases → neither) so either column can be
  missing during a rollout.
- **GOTCHA**: the existing fallback currently toggles one flag; keep exactly one
  try/catch per optional column, and only swallow `42703`.
- **VALIDATE**: unit test with a stubbed pool that throws 42703 on the first
  query returns rows with `brands: null` and no throw.

### Task C2: Record which brand matched
- **ACTION**: In the binding loop, when a name key resolves to a registry row,
  determine which brand's `crossNameKey` equals the org key and carry it into
  the payload as `matched_brand_licence` / `matched_brand_name`.
- **IMPLEMENT**: build `brandByKey: Map<string, Map<string, RegistryBrand>>`
  alongside `byNameKey` (entityId → key → brand) as rows are indexed; look up
  `brandByKey.get(hit.entityId)?.get(key)` after a hit.
- **MIRROR**: the `addNameKey` closure already added in `byNameKey`'s build.
- **GOTCHA**: a phone/address/domain-derived hit has NO matched brand — leave
  both fields null rather than guessing the canonical.
- **VALIDATE**: integration — an org matching the `Apollo Sheet Metal Inc` alias
  yields payload `matched_brand_licence = 'APOLLSM006J6'`.

### Task C3: Brand column + brand-scoped snapshot
- **ACTION**: Migration `0032` adding `organizations.registry_brand_ref text`
  (nullable) + index; add to `schema.ts`; extend `identitySnapshot` with
  `brand_licence` / `brand_name`.
- **MIRROR**: HAND_AUTHORED_MIGRATION + JOURNAL (next idx **32**, `when` = 1784342000000).
- **GOTCHA**: nullable and NEVER inferred — an enterprise-level bind (UBI strong
  key, no brand match) legitimately leaves it null.
- **VALIDATE**: `pnpm --filter @otn/db migrate` applies; column present.

### Task C4: Brand-scoped backfeed *(the behavioural core)*
- **ACTION**: `backfeedAcceptedIdentity` stamps the **matched brand's** licence
  only; when no brand matched, stamp NO licence (UBI still stamped).
- **IMPLEMENT**: read `snapshot.brand_licence`; `licenses = brandLicence ? [brandLicence] : []`.
  Keep the UBI stamp unchanged. Replace
  `contractor_registration = licenses[0]` with the brand licence (it is no longer
  an arbitrary array pick). Also `UPDATE organizations SET registry_brand_ref = …
  WHERE id = … AND registry_brand_ref IS NULL`.
- **MIRROR**: IDENTIFIER_UPSERT + NULL_ONLY_BACKFEED.
- **GOTCHA**: **behaviour change for already-bound orgs** — existing rows keep
  the licences they already have (NULL-only rules mean nothing is removed). This
  governs future accepts only; say so in the migration/PR notes.
- **VALIDATE**: integration — accepting an alias-matched binding stamps exactly
  ONE `contractor_number`, equal to that brand's licence, plus the UBI.

### Task A1: Narrow the resolver collapse to licence
- **ACTION**: In `findBoundOrganizationByStrongKey`, drop the UBI arm; match on
  `contractor_number` only. Rename params/doc accordingly.
- **IMPLEMENT**: keep the signature (callers unchanged) but ignore `rawUbi` for
  matching; document why. Return null when no licence.
- **MIRROR**: the existing query shape (`JOIN organizations o … WHERE o.registry_ref IS NOT NULL`).
- **GOTCHA**: `linkRegistry`'s `ubi_exact` binding is a DIFFERENT function and
  must keep UBI — do not touch `buildRegistryIndex`.
- **VALIDATE**: unit — two orgs sharing a UBI but different licences are NOT
  collapsed; same licence still collapses. Existing WS-B.4 test updated.

### Task B1: Enterprise rollup view + reader
- **ACTION**: Migration `0033` creating `enterprise_activity_v1` grouped on
  `organizations.registry_ref`; `packages/intelligence/src/enterprise-rollup.ts`
  exposing a typed read.
- **IMPLEMENT**: per `registry_ref`: `brand_count`, `project_count` (DISTINCT),
  `valuation_total`, `counties`, `brands` (array of canonical names), latest
  activity. Exclude `registry_ref IS NULL`.
- **MIRROR**: org-activity.ts:104-152 aggregation style (CTE + `count(DISTINCT …)`
  + `array_agg(DISTINCT …)`); reuse its `p.permitting_jurisdiction != 'Test Jurisdiction'` guard.
- **GOTCHA**: a project touched by two brands of one enterprise must count ONCE —
  use `count(DISTINCT pr.project_id)`, not a sum of per-brand counts.
- **VALIDATE**: integration — two brand orgs sharing `registry_ref` with one
  shared project report `brand_count = 2`, `project_count` counting the shared
  project once.

---

## Testing Strategy

### Unit (packages/resolution/src/*.test.ts — no DB)
| Test | Expected | Edge? |
|---|---|---|
| brand map: alias key → that brand's licence | exact licence | |
| brand map: phone-derived hit | null brand | yes |
| 42703 ladder: brands missing | falls back, no throw | yes |
| 42703 ladder: both missing | falls back twice | yes |
| non-42703 error | rethrows | yes |

### Integration (apps/worker/test — testDb)
| Test | Expected |
|---|---|
| accept alias binding | exactly ONE contractor_number stamped = brand licence |
| accept with no brand | UBI stamped, zero licences, `registry_brand_ref` null |
| two brands, one entity | two org rows survive; both share `registry_ref` |
| **spelling variants, one brand** | **same licence ⇒ WS-B.4 collapses** (owner-approved) |
| enterprise rollup | shared project counted once; `brand_count = 2` |

### Edge Cases Checklist
- [ ] Brand with NULL licence in the contract → no licence stamped, never invented
- [ ] Older contract without `brands` → degrades to today's behaviour
- [ ] Already-bound org with the full legacy licence array → untouched (NULL-only)
- [ ] Enterprise with exactly one brand → rollup identical to the org row
- [ ] `registry_ref IS NULL` → excluded from rollup

---

## Validation Commands

### Static analysis
```bash
pnpm -r run typecheck
```
EXPECT: zero errors

### Tests (Docker PG on 5433)
```bash
PG_PORT=5433 docker compose up -d postgres && pnpm exec vitest run
```
EXPECT: 783 baseline + new, all green. Run 3× — this repo has had
concurrency-sensitive tests; a new one must not be order-dependent.

### Migrations
```bash
pnpm --filter @otn/db migrate
```
EXPECT: 0032 + 0033 applied

### Registry contract
```sql
SELECT canonical_name, brands FROM registry_public.trades_identity_v1
WHERE canonical_name = 'Apollo Heating & A/C';
```
EXPECT: 3 brand objects, 3 distinct licences, reader grant intact

### Manual
- [ ] Accept `APOLLO SHEET METAL`; confirm exactly one licence stamped
- [ ] Accept `APOLLO MECHANICAL CONTRACTORS`; confirm the two orgs stay separate and share `registry_ref`
- [ ] Accept two `CHRISTIAN'S ROOFING` variants; confirm they collapse

---

## Acceptance Criteria
- [ ] Contract exposes `brands` (name + licence + is_canonical); reader grant intact
- [ ] Accept stamps only the matched brand's licence; `registry_brand_ref` set
- [ ] Distinct brands of one entity stay distinct rows sharing `registry_ref`
- [ ] Spelling variants of one brand still collapse
- [ ] Enterprise rollup counts a shared project once
- [ ] No auto-binds introduced; `viaRegistryAlias` guard intact

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Legacy orgs already hold the full licence array → still fuse | **High** | Med | NULL-only rules never remove; document that this governs future accepts. Retroactive cleanup is a separate owner-gated task |
| Contract view replace drops reader grant | Med | High | re-GRANT + verify (Task B precedent) |
| Brand licence null for some entities | Med | Low | stamp nothing; org still binds at enterprise level |
| Dropping UBI arm weakens dedupe for orgs with UBI but no licence | Med | Low | they still share `registry_ref`, so rollups are unaffected |
| Rollup double-counts shared projects | Med | Med | `count(DISTINCT project_id)` + explicit test |

## Notes
- Do NOT run `drizzle-kit generate` (hand-authored migrations + journal).
- `strict-bind:preview` now reports real counts (fixed `d1a0e70`) — safe for verification.
- Sequencing is **D → C → A**, with **B parallel**; A before C would not preserve brands.
- **Confidence: 9/10** — the mechanism, the two-level key, and Task D's
  aggregation are all verified live. The dry-run returned exactly the shape the
  design needs, including the decisive case: **Christian's Roofing Corp has ONE
  brand** (so its three Insights spelling variants share a licence and collapse),
  while **Apollo has THREE** (so its brands stay separate). No unknown SQL remains.
  Residual risk is execution-only: the legacy-licence-array caveat above, and
  keeping the new rollup test order-independent.
