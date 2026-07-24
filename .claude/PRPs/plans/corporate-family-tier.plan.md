# Plan: Corporate-family tier (common control above the legal entity)

## Summary
Add a THIRD identity tier above brand and enterprise: the **corporate family** —
the set of legal entities under common control, derived from the L&I principal
(officer/owner) already present on every trades source record. Lets Insights
answer "one buying decision-maker behind six brands" and stop treating a
roll-up's subsidiaries as unrelated companies. Principals are private-individual
data: they flow ONLY to Insights behind authentication, never to a public
registry surface.

## User Story
As the operator, I want the six HVAC companies one person controls to roll up as
one corporate family, so I can see true combined regional volume and know I'm
selling to a single decision-maker — without merging the brands or exposing
private individuals publicly.

## Problem → Solution
`Blue Flame Htg Air & Electric` and `Rescue Rooter` share UBI 601837949 (both ARS
brands) so the existing enterprise tier catches them — but `Erdahl, Darrin Paul`
controls **eight separate UBIs** (Ackerman / Alexander's / Black Lion / Brennan /
Gropp / Puyallup Heating…) that we model as eight unrelated companies, because
common control lives above the UBI and we've never read it. → Derive a normalized,
agent-filtered principal per entity; group entities sharing one into a family;
roll up activity across the family.

## Metadata
- **Complexity**: Medium–Large
- **Source**: conversational design, 2026-07-23 (owner-approved: build it; keep
  principals Insights-only, behind paying-customer/locked pages)
- **Estimated Files**: ~10
- **Repos**: registry `release/trades-staging` (Tasks A–B); TradesInsights
  `claude/tmux-install-320aiz` (Tasks C–E)
- **Builds on**: `brand-vs-enterprise-identity.plan.md` (completed) — this is the
  tier above `enterpriseRollup`

### Verified live (2026-07-23) — why this is low-risk
| Metric | Value |
|---|---|
| trades source records | 26,934 |
| records carrying `settings.principal` | **26,924 (100.0%)** |
| distinct principals | 26,223 (highly discriminating) |
| principals spanning >1 UBI | **172** |
| …caught by the agent denylist regex | 15 |
| …org-shaped (no comma → law firm / agent co) | 4 |
| …**person-shaped (`Last, First …`) — the real candidates** | **153** |
| largest genuine person-controlled family | **8 UBIs** (`Erdahl, Darrin Paul`) |

**The entire feature's output is ~153 candidate families, max 8 entities each —
small enough for one human review pass.** That bounds the blast radius of any
false family completely.

### The two worked examples that motivated this
- **`Mcmahon, James Thomas`** (on a Blue Flame record) ≈ **`Mcmahon, James T`**
  (on the Rescue Rooter record) — same ARS officer, same HQ (965 Ridge Lake Blvd,
  Memphis). Note Blue Flame ALSO has a second record whose principal is
  `Ct Corporation System`, a registered agent — proof that an entity can carry
  both a real officer and an agent, so filtering must be per-record, not per-entity.
- **`Erdahl, Darrin Paul`** (8 UBIs) and **`Erdahl, Darrin P`** (6 UBIs) — one
  person, two spellings. Middle-name-vs-initial recurs systematically in L&I data
  (it appears in BOTH worked examples), so normalization is mandatory, not polish.

---

## UX Design
Internal + one new authenticated read surface.

| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Contract view | brand + enterprise identity | + `principals` (non-agent only) | seam-only; see governance |
| Insights rollup | `enterpriseRollup` (per UBI) | + `corporateFamilyRollup` (per family) | project counted ONCE across the family |
| Registry public pages | no principals | **no principals — unchanged** | hard constraint |

---

## ⚠️ Governance (owner decision, 2026-07-23) — encode these, do not soften

1. **Principals are private-individual data.** They may reach Insights and appear
   ONLY behind authentication (`currentSession()` / `requireSession()` — every
   `/app/*` route). They must NEVER render on a public registry page, a pSEO
   surface, a digest sent to a non-customer, or any unauthenticated route.
2. **`registry_public` is NOT web-public.** Verified live: schema USAGE is granted
   to `otn_insights_reader` ONLY — not `anon`, not `authenticated`, not `public`.
   The name is misleading. **Any migration in this plan that adds a GRANT to
   `anon`/`authenticated`/`public` on `registry_public` is a defect.** Re-assert
   only the existing `otn_insights_reader` grants.
3. **A principal is NEVER a name match key.** The person-vs-business gate from
   Phase 2 stands: a principal links ENTITIES TO EACH OTHER. It must never become
   an org alias, enter `byNameKey`, or let a permit naming a person match a
   business. (`Hathaway, Collin` must not match a company called "Collin Hathaway".)
4. **A corporate family NEVER auto-binds anything.** It is an analytics/rollup
   grouping only. It does not create `registry_ref`, does not stamp identifiers,
   and does not feed `evaluateStrictBind`.

---

## Mandatory Reading
| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `<registry>/apps/registry/scripts/entity-resolution/backfill-lni-aliases.mjs` | all | EXACT derive-from-L&I script pattern to mirror (dry-run, set-based, ON CONFLICT) |
| P0 | `<registry>/apps/registry/supabase/migrations/20260723230000_trades_identity_brand_phone.sql` | all | contract-view append-LAST + re-GRANT pattern; the per-record join shape |
| P0 | `packages/intelligence/src/enterprise-rollup.ts` | all | the tier below this one; `corporateFamilyRollup` mirrors its shape exactly |
| P0 | `packages/resolution/src/registry-link.ts` | 25–110, 240–310 | `RegistryIdentityRow`, the 42703 ladder, `parseBrands` (mirror for `parsePrincipals`) |
| P1 | `<registry>/apps/registry/scripts/entity-resolution/mint-entities.mjs` | tail | set-based reconcile at end of mint (where ongoing capture hooks in) |
| P1 | `apps/web/lib/auth.ts` | all | `currentSession` / `requireSession` — the locked-page gate |
| P2 | `packages/intelligence/src/org-activity.ts` | 95–160 | aggregation SQL idiom (CTE + count(DISTINCT …)) |

## External Documentation
None — internal patterns and data we already hold.

---

## Patterns to Mirror

### DERIVE_FROM_LNI_SCRIPT
// SOURCE: backfill-lni-aliases.mjs — shebang, docstring stating the premise +
// safety rules, `--dry-run` default, set-based SQL, `ON CONFLICT DO NOTHING`,
// JSON summary log, `main().catch(err => { console.error(err); process.exit(1) })`.

### CONTRACT_VIEW_APPEND_LAST + RE-GRANT
// SOURCE: 20260723230000_trades_identity_brand_phone.sql
```sql
CREATE OR REPLACE VIEW registry_public.trades_identity_v1
WITH (security_invoker = false) AS
  SELECT ..., br.brands, pr.principals   -- appended LAST
  ...
GRANT USAGE ON SCHEMA registry_public TO otn_insights_reader;
GRANT SELECT ON registry_public.trades_identity_v1 TO otn_insights_reader;
```

### SKIP_SAFE_CONTRACT_READ (the 42703 ladder — now THREE optional columns)
// SOURCE: registry-link.ts `fetchRegistryIdentityRows`
```ts
const ladder = [["aliases","brands","principals"], ["aliases","brands"], ["aliases"], []];
for (const [i, optional] of ladder.entries()) {
  try { res = await pool.query(columns(optional)); break; }
  catch (err) {
    if ((err as {code?:string}|null)?.code !== "42703" || i === ladder.length-1) throw err;
  }
}
```

### DEFENSIVE_JSONB_PARSE
// SOURCE: registry-link.ts `parseBrands` — keep only well-formed entries, never
// fabricate a missing field, return null (not []) when nothing survives.

### ROLLUP_SHAPE
// SOURCE: packages/intelligence/src/enterprise-rollup.ts — `ent_project` CTE
// collapsing (group, project) BEFORE aggregation so a project touched by two
// members counts ONCE; `strArray` helper; `Math.min(opts.limit ?? 100, 500)`.

---

## Files to Change
| File | Action | Justification |
|---|---|---|
| **A** `<registry>/.../migrations/<ts>_registry_entity_principals.sql` | CREATE | table + unique index + agent flag |
| **A** `<registry>/scripts/entity-resolution/backfill-lni-principals.mjs` | CREATE | derive + normalize + agent-classify |
| **A** `<registry>/scripts/entity-resolution/mint-entities.mjs` | UPDATE | set-based reconcile keeps principals fresh |
| **B** `<registry>/.../migrations/<ts>_trades_identity_principals.sql` | CREATE | expose `principals jsonb` (non-agent only), appended LAST |
| **C** `packages/resolution/src/registry-link.ts` | UPDATE | `RegistryPrincipal` type, 3-step ladder, `parsePrincipals` |
| **D** `packages/intelligence/src/corporate-family.ts` | CREATE | family grouping + `corporateFamilyRollup` |
| **D** `packages/intelligence/src/index.ts` | UPDATE | export |
| **E** `apps/web/app/app/admin/corporate-families/page.tsx` | CREATE | authenticated review surface |
| tests | UPDATE/CREATE | see Testing Strategy |

## NOT Building
- Principals as a name match key / org alias (governance §3 — forbidden).
- Auto-binding or auto-merging anything from a family (governance §4).
- Any public/unauthenticated surface for principals (governance §1).
- Person↔person or person↔permit linkage (a different feature entirely).
- Backfilling family membership onto `organizations` as a column — families are
  derived and can change; compute them, don't denormalize yet.
- Non-`trades` verticals.

---

## Step-by-Step Tasks

### Task A1: `registry_entity_principals` table *(registry, first)*
- **ACTION**: Migration creating
  `registry_internal.registry_entity_principals (entity_id uuid, principal_normalized text, principal_display text, is_agent boolean NOT NULL DEFAULT false, source_record_id bigint, created_at timestamptz DEFAULT now())`
  with `PRIMARY KEY (entity_id, principal_normalized)` and an index on
  `(principal_normalized) WHERE NOT is_agent` (the lookup that forms families).
- **GOTCHA**: FK `entity_id → registry_business_entities(entity_id) ON DELETE CASCADE`
  and `source_record_id → registry_source_records ON DELETE SET NULL`, matching
  `registry_entity_aliases`. RLS: `ENABLE ROW LEVEL SECURITY` like its siblings.
- **VALIDATE**: table exists; inserting a duplicate `(entity_id, principal_normalized)` is a no-op.

### Task A2: Derive + normalize + agent-classify
- **ACTION**: `backfill-lni-principals.mjs` — for every resolved trades record,
  read `raw->'settings'->>'principal'`, normalize, classify, insert.
- **IMPLEMENT — normalization (the part that must be right):**
  - Trim, collapse whitespace, uppercase.
  - L&I person format is `Last, First [Middle]`. **Collapse any middle token to
    its initial**: `MCMAHON, JAMES THOMAS` → `MCMAHON, JAMES T`;
    `ERDAHL, DARRIN PAUL` → `ERDAHL, DARRIN P`. This is what unifies BOTH worked
    examples and is verified against live data.
  - Strip trailing punctuation and generational suffixes (`JR`, `SR`, `II`, `III`).
- **IMPLEMENT — agent classification (`is_agent = true`), belt AND braces:**
  1. **Structural**: no comma ⇒ not a person-shaped name ⇒ agent/org. Verified
     to catch all 4 org-shaped multi-UBI principals (`Bates & Ely Pllc`,
     `Cairncross & Hempelmann Ps`, `Mn Service Corporation (Wa)`,
     `United States Corp Agents Inc`).
  2. **Denylist regex** (catches comma-less AND any future comma'd variant):
     `corporation service|c ?t corp|registered agent|incorp services|national registered|legalzoom|cogency|corporate creations|harbor compliance|northwest registered|us corp agents`.
     Verified to catch 15 of the 172 multi-UBI principals, including all five
     `CT Corporation` spellings.
- **MIRROR**: DERIVE_FROM_LNI_SCRIPT.
- **GOTCHA**: classify PER RECORD, not per entity — Blue Flame legitimately has
  one record with a real officer and another with a registered agent. Store both;
  only `is_agent = false` rows ever form families.
- **VALIDATE**: `--dry-run` reports ~26,924 principals across ~25,545 entities;
  `Mcmahon, James Thomas` and `Mcmahon, James T` normalize IDENTICALLY;
  `Erdahl, Darrin Paul` and `Erdahl, Darrin P` normalize IDENTICALLY;
  every `CT Corporation` variant lands `is_agent = true`. Live run then rerun adds 0.

### Task A3: Keep principals fresh at mint
- **ACTION**: Append a set-based reconcile to `mint-entities.mjs`, immediately
  after the existing `record_count` / alias reconciles.
- **MIRROR**: the alias reconcile block added in `8f1beb6b` — same statement as
  the backfill, `ON CONFLICT DO NOTHING`, `metrics.principalsAdded = res.rowCount`.
- **VALIDATE**: re-running mint adds 0 principals on an unchanged corpus.

### Task B1: Expose `principals` on the contract
- **ACTION**: Migration appending `principals jsonb` LAST (column 29) to
  `registry_public.trades_identity_v1`.
- **IMPLEMENT**: `LEFT JOIN LATERAL` aggregating **`WHERE NOT is_agent`** only:
  `jsonb_agg(jsonb_build_object('name', principal_display, 'key', principal_normalized) ORDER BY principal_normalized)`.
  Agents are deliberately NOT exposed — they carry no signal and would invite misuse.
- **MIRROR**: CONTRACT_VIEW_APPEND_LAST + RE-GRANT.
- **GOTCHA**: `CREATE OR REPLACE VIEW` cannot insert mid-list — append LAST, keep
  all 28 existing columns' name/type/ordinal. Re-assert ONLY the
  `otn_insights_reader` grants (governance §2).
- **VALIDATE**: column count 28 → 29; `principals` non-null for the Erdahl
  entities; `has_table_privilege('otn_insights_reader', …, 'SELECT')` true;
  **`has_schema_privilege('anon','registry_public','USAGE')` is FALSE.**

### Task C1: Insights reads principals
- **ACTION**: Add `RegistryPrincipal { name: string; key: string }` and
  `principals?: RegistryPrincipal[] | null` to `RegistryIdentityRow`; extend the
  42703 ladder to three optional columns; add `parsePrincipals`.
- **MIRROR**: SKIP_SAFE_CONTRACT_READ + DEFENSIVE_JSONB_PARSE.
- **GOTCHA**: principals must NOT be added to `byNameKey`, `brandByEntityKey`, or
  any index the binding loop reads (governance §3). This task touches ONLY the
  fetch/parse layer.
- **VALIDATE**: unit — stubbed pool throwing 42703 on the first two queries still
  returns rows, with `principals: null`; a non-42703 error rethrows.

### Task D1: `corporateFamilyRollup`
- **ACTION**: `packages/intelligence/src/corporate-family.ts` — group bound orgs
  into families by shared non-agent principal key, then roll up activity.
- **IMPLEMENT**:
  - `buildFamilies(rows: RegistryIdentityRow[]): Map<string, FamilyGroup>` —
    PURE and unit-testable, no DB. Union entities sharing any principal key.
    Family id = the lexicographically smallest principal key (deterministic).
  - `MAX_FAMILY_ENTITIES = 12` — a group larger than this is almost certainly an
    agent artifact that slipped the denylist (largest verified real family is 8).
    Over the cap ⇒ **drop the family and log it**, never silently truncate.
  - `corporateFamilyRollup(db, opts)` — mirrors `enterpriseRollup` exactly:
    `fam_project` CTE collapsing (family, project) BEFORE aggregation so a project
    touched by two members counts ONCE; returns `familyId`, `principalNames`,
    `entityCount`, `brandCount`, `orgNames`, `projects`, `projects90d`, `counties`,
    `statedValuationTotal`, `latestActivityAt`.
- **MIRROR**: ROLLUP_SHAPE.
- **GOTCHA**: only orgs with `registry_ref IS NOT NULL` participate — an unbound
  org has no entity and therefore no family.
- **VALIDATE**: unit — two entities sharing `ERDAHL, DARRIN P` group into one
  family; an entity whose only principal is an agent forms none; a 13-entity group
  is dropped with a log line. Integration — a project worked by two brands of two
  entities in one family counts once.

### Task E1: Authenticated review surface
- **ACTION**: `apps/web/app/app/admin/corporate-families/page.tsx` listing
  families with their principals, member entities/brands, and combined activity.
- **MIRROR**: `registry-review/page.tsx` — `export const dynamic = "force-dynamic"`,
  `currentSession()` → redirect `/login`, `role !== "admin"` → redirect
  `/app/opportunities`, `table`/`cell` from `lib/ui.js`.
- **GOTCHA (governance §1)**: this page displays private individuals. It MUST sit
  under `/app/` behind `currentSession()`. Do NOT add a public route, do not
  include principal names in any digest/export, and do not import a VALUE from
  `@otn/resolution` in a client component (drags `pg` into the browser bundle —
  `next build` fails; type-only imports are fine).
- **VALIDATE**: unauthenticated request redirects to `/login`; `next build` clean.

---

## Testing Strategy

### Unit (no DB)
| Test | Expected |
|---|---|
| `MCMAHON, JAMES THOMAS` vs `MCMAHON, JAMES T` | identical normalized key |
| `ERDAHL, DARRIN PAUL` vs `ERDAHL, DARRIN P` | identical normalized key |
| `Smith, John Jr` | suffix stripped |
| every `CT Corporation` spelling variant | `is_agent = true` |
| `Bates & Ely Pllc` (no comma) | `is_agent = true` structurally |
| `buildFamilies`: two entities share a key | one family |
| `buildFamilies`: agent-only entity | no family |
| `buildFamilies`: 13-entity group | dropped + logged, not truncated |
| 42703 ladder: principals missing | degrades, `principals: null`, no throw |

### Integration (testDb)
| Test | Expected |
|---|---|
| family rollup counts a shared project ONCE | `projects` counts it once |
| unbound org | excluded from every family |
| principals never enter `byNameKey` | a permit naming a principal produces NO binding candidate |

### Edge Cases Checklist
- [ ] Entity with both a real officer AND an agent record → family via officer only
- [ ] Principal present but entity inactive → excluded (view pre-filters)
- [ ] Older contract without `principals` → degrades, rollup returns empty
- [ ] Family of exactly 1 entity → not a family, excluded
- [ ] Same person, two spellings → ONE family (the whole point)

---

## Validation Commands

### Registry
```bash
node apps/registry/scripts/entity-resolution/backfill-lni-principals.mjs --dry-run
```
EXPECT: ~26,924 principals / ~25,545 entities; agent counts match the table above; zero writes

### Insights
```bash
pnpm -r run typecheck && PG_PORT=5433 docker compose up -d postgres && pnpm exec vitest run
```
EXPECT: 789 baseline + new, all green. Run 3× — this repo has had concurrency-sensitive tests.

```bash
pnpm --filter @otn/web build
```
EXPECT: compiled clean

### Governance assertions (run BOTH, they are the point of the plan)
```sql
SELECT has_schema_privilege('anon','registry_public','USAGE') AS must_be_false;
SELECT count(*) AS must_be_zero FROM registry_public.trades_identity_v1 t,
  LATERAL jsonb_array_elements(coalesce(t.principals,'[]'::jsonb)) p
 WHERE p->>'name' IS NULL;
```

### Manual
- [ ] `Mcmahon, James T*` groups Blue Flame + Rescue Rooter into one family
- [ ] `Erdahl, Darrin P*` groups all 8 UBIs into one family across BOTH spellings
- [ ] `/app/admin/corporate-families` redirects to `/login` when logged out
- [ ] No principal name appears on any registry public page or in a digest

---

## Acceptance Criteria
- [ ] ~153 candidate families derived, max 12 entities each, agents excluded
- [ ] Both worked examples (Mcmahon, Erdahl) group correctly across spellings
- [ ] Family rollup counts a shared project once
- [ ] Principals reach ONLY authenticated Insights surfaces; `anon` has no
      `registry_public` USAGE; no principal in any public page or digest
- [ ] Principals are not a match key anywhere; no auto-bind introduced

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Common-name collision** (two real `SMITH, JOHN A`) merges unrelated firms | Med | Med | Families are ≤12 and only ~153 exist — **reviewable in one human pass**. Surface them on the E1 page before any downstream use; do not feed scoring yet |
| Agent slips the denylist → giant false family | Med | Med | Two independent filters (structural no-comma + regex) AND the `MAX_FAMILY_ENTITIES` cap, which drops rather than truncates |
| Middle-initial normalization over-merges (`SMITH, JOHN PAUL` vs `SMITH, JOHN PETER`) | Low | Med | Accepted and documented: both collapse to `SMITH, JOHN P`. Bounded by the same review pass; revisit only if a real collision is observed |
| Privacy leak onto a public surface | **Low** | **High** | Governance §1–2 encoded as validation assertions, not prose; `registry_public` verified `otn_insights_reader`-only |
| Contract view replace drops the reader grant | Med | High | Re-GRANT + verify (established precedent) |

## Notes
- Sequencing is **A → B → C → D → E**; A2's normalization is the correctness
  crux — get its unit tests green before touching anything downstream.
- Do NOT run `drizzle-kit generate` (Insights migrations are hand-authored with a
  hand-maintained `meta/_journal.json`, `when` +1000 per idx). No Insights
  migration is needed in this plan — families are derived, not stored.
- The registry has no migration ledger table; migrations are applied by file and
  verified by querying the resulting object.
- **Confidence: 8/10** — coverage, discrimination, agent shape, family sizes and
  both worked examples are all verified against live data. Residual unknown is
  the exact `mint-entities.mjs` insertion point (a read at implement time) and
  how many of the 153 person-families are common-name collisions, which the E1
  review page is designed to answer rather than guess.
