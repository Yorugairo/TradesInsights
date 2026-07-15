---
name: project-resolution
description: Resolve source records into the development → project → event graph. Use when working in packages/resolution, implementing matching/merging/splitting, stage or event derivation, permit-cluster velocity, or the merge-review workflow (spec M2).
---

# Project resolution

Full rules: `docs/BUILD_SPEC.md` §9–§10. Goal: permits, notices, SEPA records, and solicitations from different sources resolve into one reviewable development → phase/project → event graph, with nothing lost and nothing invented.

## Matching order (strict precedence)

1. Same jurisdiction + official external ID.
2. Explicit permit/application/parent reference.
3. Parcel overlap.
4. Normalized address + compatible project name.
5. Geospatial proximity + compatible organization/project name.
6. Development/phase relationship supported by documents, parcels, and organizations.

## Always route to human review

- Conflicting parcels, addresses, jurisdictions, or owners.
- Generic names ("Tenant Improvement").
- Fuzzy matches without parcel/organization support.
- Same address with separate tenant projects.
- Current vs. older legal entities with similar names (e.g., Solis current UBI 604837560 vs. closed 604701295).

## Invariants

- Record the resolver version, features, score, merge decision, and evidence for every merge.
- Support split/undo. **Never delete underlying source records.**
- Confirmed facts and inferences stay separated (`confirmed`, `confidence`).
- Stage transitions produce `project_events` with prior/resulting stage, event date vs. observed-at, and `material_change`.
- Only an explicit solicitation, customer invitation, or equivalent evidence sets `bidding_confirmed`. A permit is not proof of an open trade bid.
- Digest at the account-relevant project/phase level: a 40-permit subdivision cluster is **one opportunity plus a velocity signal**, not 40 leads.

## Stage taxonomy

concept → preapplication → entitlement → approved → construction_documents → permit_applied → permit_issued → bidding_confirmed → construction → near_final → complete; plus `withdrawn` and `unknown`. Event types are enumerated in spec §9.

## Required test scenarios (spec §19)

- Same project seen across SEPA, local notice, and permit.
- Subdivision with phases and clustered building permits.
- Same address with separate TIs.
- Similar names in different jurisdictions.
- Conflicting parcels/owners.
- Solis current vs. older closed entity.
- Lacey Home / Commercial / joint_review routing.

Gates: correct project clustering ≥95%; ID/address/date extraction ≥98%.
