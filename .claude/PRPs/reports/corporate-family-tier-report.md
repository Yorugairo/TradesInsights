# Implementation Report: Corporate-family tier + principal↔person discovery

## Summary
Added a third identity tier above brand and enterprise: the **corporate family**
— registry entities under common control, derived from the L&I principal
(officer/owner). Also added the lane the owner asked for on top of the plan:
matching a registry principal to an Insights contractor, as a review-gated
discovery queue.

Shipped: registry `bd6fbf57` (`release/trades-staging`), Insights `a151508`
(`claude/tmux-install-320aiz`). Both pushed.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Medium–Large | Medium–Large |
| Confidence | 8/10 | Justified — the one deviation (SQL-function normalizer) was an improvement, not a correction |
| Files Changed | ~10 | 12 (4 registry, 8 Insights) |
| Candidate families | ~153 | **217** — normalization created groups that were invisible before |
| Largest family | 8 | **9** (both `Erdahl` spellings merged) |
| Over-cap groups | unknown | **0** — the cap drops nothing today |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| A1 | `registry_entity_principals` table | Complete | Deviated — added two IMMUTABLE SQL functions (see below) |
| A2 | Derive + normalize + agent-classify | Complete | Deviated — set-based write, not row-by-row |
| A3 | Keep principals fresh at mint | Complete | Same statement as the backfill |
| B1 | Expose `principals` on the contract | Complete | Column 29, non-agent only |
| C1 | Insights reads principals | Complete | 42703 ladder widened to 4 steps |
| D1 | `corporateFamilyRollup` | Complete | Union-find grouping + `fam_project` collapse |
| **D2** | **Principal↔person discovery lane** | Complete | **Added beyond the plan, per the owner's instruction** |
| E1 | Authenticated review surface | Complete | Both sections on one admin page |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis | Pass | `pnpm -r run typecheck` — 11 projects, zero errors |
| Unit Tests | Pass | 34 new pure tests (24 key rules, 10 grouping) |
| Integration | Pass | 5 new `testDb` tests |
| Full suite | Pass | **828 passed / 93 files** (789 baseline + 39) |
| Build | Pass | `next build` clean; `/app/admin/corporate-families` built as ƒ (dynamic) |
| Governance assertions | Pass | see below |

### Governance assertions (run live post-migration)

| Assertion | Result |
|---|---|
| contract column count | 28 → **29**, col 29 = `principals` |
| `has_schema_privilege('anon','registry_public','USAGE')` | **false** |
| `has_schema_privilege('authenticated','registry_public','USAGE')` | **false** |
| `has_table_privilege('otn_insights_reader', …, 'SELECT')` | **true** |
| principal elements with a null `name` or `key` | **0** |
| entities carrying principals on the contract | 25,335 |

## Files Changed

| File | Action | Repo |
|---|---|---|
| `apps/registry/supabase/migrations/20260724000000_registry_entity_principals.sql` | CREATE | registry |
| `apps/registry/supabase/migrations/20260724001000_trades_identity_principals.sql` | CREATE | registry |
| `apps/registry/scripts/entity-resolution/backfill-lni-principals.mjs` | CREATE | registry |
| `apps/registry/scripts/entity-resolution/mint-entities.mjs` | UPDATE | registry |
| `packages/resolution/src/registry-link.ts` | UPDATE | Insights |
| `packages/resolution/src/principal-person.ts` | CREATE | Insights |
| `packages/resolution/src/principal-person.test.ts` | CREATE | Insights |
| `packages/intelligence/src/corporate-family.ts` | CREATE | Insights |
| `packages/intelligence/src/corporate-family.test.ts` | CREATE | Insights |
| `apps/web/app/app/admin/corporate-families/page.tsx` | CREATE | Insights |
| `apps/web/app/app/admin/registry-review/page.tsx` | UPDATE | Insights |
| `apps/worker/test/corporate-family.test.ts` | CREATE | Insights |

## Deviations from Plan

1. **Normalization is a SQL function, not JS.** The plan put normalization in
   `backfill-lni-principals.mjs`. But mint's reconcile is set-based SQL, so a JS
   normalizer would have needed a second implementation — exactly the drift the
   alias work was careful to avoid. `registry_internal.normalize_principal()` and
   `.is_agent_principal()` are now the single authoritative definitions and both
   write paths call them.
2. **Set-based write in the backfill.** The plan mirrored the alias backfill's
   row-by-row loop; that script wrote 253 rows, this one writes 26,152.
   `--limit` is now refused outside `--dry-run` — a partial write would leave an
   arbitrary subset of families visible.
3. **`buildFamilies` uses union-find, not a flat group-by.** A flat grouping by
   principal key produces overlapping groups when two officers share a company.
   Union-find over entity↔principal nodes resolves them into one family, which is
   what "common control" actually means.
4. **`corporateFamilyRollup` takes families as an argument.** Families derive from
   the *registry* contract while activity lives in *Insights*; passing them in
   lets one contract fetch feed both the rollup and the discovery lane.
5. **Task D2 added.** Not in the plan — added on the owner's instruction (see
   below).
6. **`corePrincipalKey` re-runs the character clean.** Found by an integration
   test: the registry key and the Insights key must agree byte-for-byte, and
   relying on the registry having already cleaned it is a silent-mismatch risk if
   that normalizer ever widens.

## The added lane (owner instruction)

> "also make sure that we allow matching of principal from registry to contractor
> from insights - thats where we might find new matches to group in the future."

**Tension resolved, not softened.** Plan governance §3 says a principal is never
a name match key. That rule's purpose is to stop a *business* name colliding with
a *person*. The lane honours it by construction rather than by exception:

- `personCoreKey` returns **null** for anything business-shaped, so a company
  name can never enter the principal index.
- The index (`PrincipalPersonIndex`) is a **separate structure** from `byNameKey`.
  There is no code path from the binding loop to it.
- A match produces a **display row on an authenticated page**. It writes nothing:
  no `registry_ref`, no identifier, no observation, no input to
  `evaluateStrictBind`.

**Live yield**: 2,426 person-shaped Insights orgs → **97 match a registry
principal**, all currently unbound, reaching 118 org↔entity pairs.

The sample is the predicted mix, and that is the point:

| Insights person | Reaches | Reading |
|---|---|---|
| `Michael Pearson` | Pearson Metal Salvage, Pearson Plumbing | almost certainly real |
| `Natalie Pompa` | Parker Bros Electric, Parker Bros Htg & Clg | almost certainly real |
| `Michael Atwood` | Atwood Fabricating, Rapid Heating & Cooling | plausible |
| `Michael Moore` | Gill Group, Moore Furniture | common-name collision |
| `James Stewart` | A + Painting, Security 101 Seattle | common-name collision |

A coarse key (surname + given, no middle initial) is required because permit data
rarely carries a middle name. Collisions are therefore expected, which is the
argument for a review queue and against a binding rule.

## Issues Encountered

- **Registry worktree**: the plan's `<registry>` is
  `.claude/worktrees/trades-google-place-integration-v2` on `release/trades-staging`
  — not the primary working directory, which is a *different vertical* of the same
  repo. Cost one detour.
- **Two integration-test failures, one real finding.** The digit-bearing run token
  broke the fixture (test artefact), but it also exposed that `corePrincipalKey`
  and `personCoreKey` applied *different* character cleaning. Fixed in the source,
  not the test — deviation 6.
- **GateGuard denial #11** on the new page. Facts stated, retried, passed.

## Tests Written

| Test File | Tests | Coverage |
|---|---|---|
| `packages/resolution/src/principal-person.test.ts` | 24 | both name conventions, middle-name collapse, punctuation folding, suffixes, **7 business-shape rejections**, index build, match + ordering |
| `packages/intelligence/src/corporate-family.test.ts` | 10 | spelling-variant grouping, lone entity, agent-only, officer+agent, transitive join, cap drop vs truncate, ordering, degraded contract |
| `apps/worker/test/corporate-family.test.ts` | 5 | shared project counted once, unbound org excluded, empty families, SQL prefilter, end-to-end discovery |

## Next Steps
- [ ] Owner review of the 217 families and 97 discovery matches at `/app/admin/corporate-families`
- [ ] Decide whether a *reviewed* family should feed anything downstream (scoring, GC-copilot); today it feeds only the page
- [ ] Still open from earlier: Phase 4 PRP (Google Places enrichment for unbound orgs); the 21 brand-attributed candidates at `/app/admin/registry-review`
