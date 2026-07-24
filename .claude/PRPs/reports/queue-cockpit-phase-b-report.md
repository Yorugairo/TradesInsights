# Implementation Report: Queue cockpit — Phase B (family accept → registry relationship export)

## Summary
Phase B of `queue-cockpit.plan.md` — the accept action that closes the enrichment
loop. Confirming a corporate-family pair (or a principal↔person link) now records
an entity↔entity `principal_shared` relationship that rides the EXISTING
`registry_observations → exportRegistryObservations → registry_partner.partner_observations`
pipeline into the registry, where the loader adjudicates it into
`registry_entity_relationships`. Nothing here binds identity — it teaches the
registry which companies share common control, which sharpens Insights matching
in turn. The plan stays in `plans/` (phased — Phase D remains; order C → B → D).

## Assessment vs reality
| Metric | Plan | Actual |
|---|---|---|
| Complexity | part of Large–XL plan | Phase B alone = Medium |
| Files changed | B1–B7 (7 tasks) | 3 Insights files created, 4 updated, 1 helper+test added; 2 registry DDL applied live; B3 handed off |
| New questions during impl | 0 | 1 (registry DDL apply-live vs hand-off — owner chose apply-live) |

## Tasks completed
| # | Task | Status | Notes |
|---|---|---|---|
| B1 | `registry_entity_relationships` table | Applied live | via Supabase MCP on the shared DB; verified (PK, 2 FKs CASCADE, canonical-order + type CHECKs, RLS, b-index) |
| B2 | widen `partner_observations` CHECK | Applied live | now `IN ('alias','trade_evidence','relationship')`; table was empty (0 rows) so drop-and-re-add was safe; verified |
| B3 | loader `relationship` branch | **Handed off** | lives in the registry repo's `ingest-otn-insights.mjs` (not on this filesystem) — spec + code sketch below |
| B4 | widen the Insights export lane | Complete | `OBSERVATION_TYPES += relationship_export`; export filter + 3-way `PARTNER_OBSERVATION_TYPE` map |
| B5 | `recordRelationshipAcceptance` | Complete | direct-insert of an already-accepted row; `relationshipDedupeKey` (order-independent); +3 unit tests |
| B6 | relationship decision route | Complete | `POST /api/admin/corporate-families/relationship`, `withAdmin`, zod-validated, guards self-pair + `contradicted` |
| B7 | accept buttons | Complete | `ConfirmRelationshipButton` on BOTH family-pair rows and principal↔person rows |

## What was built (Insights repo)
| File | Action | Purpose |
|---|---|---|
| `packages/resolution/src/registry-observations.ts` | UPDATE | `relationship_export` type; export-lane 3-way map + widened filter; `relationshipDedupeKey` + `recordRelationshipAcceptance` |
| `packages/resolution/src/registry-observations.relationship.test.ts` | CREATE | 3 tests: dedupe-key order independence, insert-then-replay (no duplicate), self-relationship rejected |
| `packages/intelligence/src/family-anchors.ts` | CREATE | `loadBoundOrgIdsByEntity` — registry entity → bound Insights org (the accept action's provenance anchor) |
| `packages/intelligence/src/family-anchors.test.ts` | CREATE | 2 tests: empty-input no-query, registry_ref→org mapping |
| `packages/intelligence/src/index.ts` | UPDATE | export the anchor helper |
| `apps/web/app/api/admin/corporate-families/relationship/route.ts` | CREATE | the decision route |
| `apps/web/app/app/admin/corporate-families/actions.tsx` | CREATE | `ConfirmRelationshipButton` client component |
| `apps/web/app/app/admin/corporate-families/page.tsx` | UPDATE | anchor map + row index; confirm buttons wired into both lanes |

## Key design decisions (verified, not assumed)
1. **Both lanes reduce to one entity↔entity model.** A family pair is already two
   registry entities. A principal↔person match becomes a relationship only when the
   person's OWN org is bound to a DIFFERENT registry entity (`candidate.registryRef`)
   — then the person links two companies, and we corroborate THOSE TWO ENTITIES
   (via `corroborateEntities`), not the person. If the org isn't bound, there is no
   second entity and no button.
2. **The anchor org is provenance, never the claim.** `registry_observations.organization_id`
   is NOT NULL, so a bound Insights org must anchor the row ("who confirmed it").
   For a family pair with no bound org on either side, the button is disabled with a
   tooltip — the observation cannot be recorded without an anchor. The CLAIM is the
   payload's `entity_id_a`/`entity_id_b`.
3. **Canonical ordering everywhere.** `relationshipDedupeKey` sorts the pair so the
   dedupe key is identical whichever side the reviewer clicked from, and it matches
   B1's `entity_id_a < entity_id_b` CHECK. A swapped-order replay dedupes to the same
   row (unit-tested).
4. **Review-gated, one click per claim.** No bulk path — every claim leans on a
   private individual's name. `contradicted` pairs get NO button (a middle-initial
   conflict L&I itself records must not be overridden by one click); the server route
   rejects `contradicted` as defense-in-depth. `name_only` shows a de-emphasized
   button.
5. **Reused the existing export pipeline, no new plumbing.** Accepted rows are
   `relationship_export` observations that the nightly `exportRegistryObservations`
   already drains — widened by one type arm and one filter value.
6. **Client bundle safety preserved.** `actions.tsx` type-imports only from
   `@otn/resolution` (a value import drags `pg` into the browser bundle); the
   corroboration payload shape is restated locally.

## Validation
| Level | Result |
|---|---|
| Typecheck (`pnpm -r`) | clean — 11/11 projects incl. `apps/web` |
| ESLint (all Phase B files) | clean |
| Unit (`packages/resolution` + `packages/intelligence`) | 317/317 pass (5 new) |
| Build (`@otn/web`) | clean; `/app/admin/corporate-families` = `ƒ` dynamic, 1.17 kB (client accept component, no `pg` leak); relationship route compiled |
| Registry DDL (live, verified) | B1 table + constraints + RLS + index present; B2 CHECK widened; `partner_observations` had 0 rows |

## Deviations
- **B1/B2 applied live via Supabase MCP** rather than through the registry repo's
  migration files (owner decision this session — "Apply B1+B2 live now"). The exact
  DDL is recorded below so the registry checkout can add matching migration files;
  `CREATE TABLE IF NOT EXISTS` keeps a later registry migration idempotent.

## B3 — remaining registry-repo work (handoff)
File: `<registry>/scripts/entity-resolution/ingest-otn-insights.mjs`, function `adjudicate()`.
Add a `relationship` branch mirroring the alias/trade branches:

```js
// partner_observations row: observation_type='relationship',
// entity_id = payload.entity_id_a (canonical A), payload carries both ids.
if (obs.observation_type === 'relationship') {
  const p = obs.payload ?? {};
  const a = p.entity_id_a, b = p.entity_id_b;
  if (!a || !b || a === b) return skip('invalid_relationship');
  // The SORT decides storage order — never assume obs.entity_id === entity_id_a.
  const [lo, hi] = a < b ? [a, b] : [b, a];
  // Both entities must exist and be active in registry_business_entities.
  if (!(await entityActive(lo)) || !(await entityActive(hi))) return skip('unknown_entity');
  const ins = await db.query(
    `INSERT INTO registry_internal.registry_entity_relationships
       (entity_id_a, entity_id_b, relationship_type, principal_key, confidence, evidence, source)
     VALUES ($1,$2,'principal_shared',$3,$4,$5::jsonb,'otn_insights')
     ON CONFLICT (entity_id_a, entity_id_b, relationship_type) DO NOTHING
     RETURNING entity_id_a`,
    [lo, hi, p.principal_key ?? null, p.confidence ?? null, JSON.stringify(p.evidence ?? {})],
  );
  return ins.rowCount === 0 ? skip('duplicate_relationship') : done('relationship_added');
}
```

Validate (per plan): dry-run on a seeded row → `relationship_added`; rerun →
`skipped:duplicate_relationship`; unknown entity_b → skipped, no write.

### DDL applied live (record as registry migration files)
```sql
-- B1
CREATE TABLE IF NOT EXISTS registry_internal.registry_entity_relationships (
  entity_id_a uuid NOT NULL REFERENCES registry_internal.registry_business_entities(entity_id) ON DELETE CASCADE,
  entity_id_b uuid NOT NULL REFERENCES registry_internal.registry_business_entities(entity_id) ON DELETE CASCADE,
  relationship_type text NOT NULL DEFAULT 'principal_shared',
  principal_key text, confidence numeric,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text NOT NULL DEFAULT 'otn_insights',
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (entity_id_a, entity_id_b, relationship_type),
  CONSTRAINT registry_entity_relationships_canonical_order CHECK (entity_id_a < entity_id_b),
  CONSTRAINT registry_entity_relationships_type_check CHECK (relationship_type IN ('principal_shared'))
);
CREATE INDEX IF NOT EXISTS registry_entity_relationships_b_idx
  ON registry_internal.registry_entity_relationships (entity_id_b);
ALTER TABLE registry_internal.registry_entity_relationships ENABLE ROW LEVEL SECURITY;

-- B2
ALTER TABLE registry_partner.partner_observations DROP CONSTRAINT partner_observations_observation_type_check;
ALTER TABLE registry_partner.partner_observations ADD CONSTRAINT partner_observations_observation_type_check
  CHECK (observation_type IN ('alias', 'trade_evidence', 'relationship'));
```

### Deployment ordering
B2 is already live, so the export lane's target is valid now. Relationship rows
only exist once an admin clicks "confirm link", and they are only adjudicated into
`registry_entity_relationships` once B3 ships. Until then they queue harmlessly in
`partner_observations` (exactly like alias/trade exports awaiting the loader).

## Next steps
- [ ] Phase D — Google Place: the 926-row auto-resolver + `registry_public.google_place_review_v1`
      (lights up the cockpit Place card) + `/app/admin/google-place-review` UI.
- [ ] Registry checkout — land B3 loader branch + record B1/B2 as migration files.
- [ ] BACKLOGGED: Phase A (PALS + Google enrichment), Phase E (domain).
