# Triage follow-up: entity duplicates and the silent ambiguous bucket

Both items from `small-backlog-triage-20260725.md`, investigated at the data level.
**One turned out not to exist. The other is real, and is now located to the line.**

---

## 1. "Registry duplicate entities" — NO SUCH PROBLEM. My triage was wrong.

I reported that `PYE-BARKER` was "a registry duplicate entity — one company split into
two entities by an `LLC` suffix, the same licence-vs-entity class as the Google Place
bug." That was wrong, and it was wrong because I inferred sameness from the name.

The two Pye-Barker entities:

| entity | UBI | phone | licences |
|---|---|---|---|
| Pye-Barker Fire & Safety | **604214250** | 6162458719 | 1 |
| Pye-Barker Fire & Safety LLC | **604541987** | 8013958731 | 3 |

**Different UBIs.** A UBI is a distinct Washington business registration, so these are two
separate legal businesses — exactly what a national roll-up looks like when it acquires
local fire-safety companies and registers separately. Entity resolution was correct to
keep them apart.

### Checked at scale, because one example proves nothing

Grouping active entities by canonical name with legal suffixes stripped
(`LLC|INC|CORP|CO|LTD|LP|LLP|PLLC|PC|PS`…):

| measure | count |
|---|---|
| suffix-variant groups | 853 |
| entities involved | 1,799 |
| **groups sharing a UBI** | **0** |
| groups sharing a phone | 30 (63 entities) |
| fully distinct (UBI *and* phone) | 823 |

**Zero UBI collisions.** There is no duplicate-entity population to merge. The 853 groups
are similarly-named but legally distinct businesses, and merging on name would have
destroyed real distinctions — the precise failure the codebase already guards against with
"`google_name` is NOT a match key."

**No work to do here.** Had I acted on the original triage, I would have built a merge
pipeline against a non-existent problem and corrupted 1,799 entities.

### Residue, low priority
30 groups (63 entities) share a phone with a similar name and different UBIs. That is a
plausible common-operator signal, not a merge signal — call centres and franchise support
lines recycle numbers. It belongs in the corporate-family lane, which exists but is
**empty**: `registry_internal.registry_entity_relationships` has **0 rows**, because the
loader branch that writes it was never built. Tracking there rather than here.

---

## 2. The silent `exact_match_ambiguous` bucket — REAL, located, not yet fixed

`packages/resolution/src/registry-observations.ts:802-809`:

```ts
} else if (nameHits && nameHits.length > 1 && phones.size > 0) {
  // Ambiguous name key — the L&I phone may disambiguate to exactly one.
  const agreeing = nameHits.filter((h) => h.phone !== null && phones.has(h.phone));
  if (agreeing.length === 1) {
    hit = agreeing[0]!;
    agreement = agreementFor("phone", hit.phone!);
    ruleKey = "binding_name_phone";
  }
}
```

Two silent paths:
1. `agreeing.length !== 1` → `hit` stays undefined, `ruleKey` stays `""`, **no observation
   is emitted.**
2. `nameHits.length > 1` **and** `phones.size === 0` → the branch is never entered at all.

So an org whose name matches several entities produces **no record of any kind**. Verified:
`B & R PLUMBING`, `PYE-BARKER FIRE & SAFETY LLC` and `FASTSIGNS` are all unbound with
**zero rows** in `insights.registry_observations`. Nothing queues them, nothing counts
them, and nobody can see them.

**Why it matters more later**: with contractors added daily, every new ambiguous org joins
an invisible backlog. The bucket exists in the audit CLI, so the number is computable on
demand — but it is never persisted, so drift is undetectable between manual runs.

### Design constraint discovered

`insights.registry_observations.registry_entity_id` is **NOT NULL**. So an ambiguous
observation cannot be expressed as one row carrying N candidates. Two viable shapes:

**A — one review-only observation per candidate.** Fits the existing queue exactly (each
row is "org X might be entity Y"; a human accepts one). Reuses plumbing rather than
inventing it, per project convention. Requires restructuring the single-`hit`-per-org loop
to emit N, and needs a fan-out cap — FASTSIGNS alone matches 16 entities.
Must use a new rule key (`binding_name_ambiguous`) that is **absent from
`evaluateStrictBind`'s allowed list**, which today admits only `binding_name_exact` and
`binding_name_phone` — so it is review-only by construction and cannot auto-bind.

**B — a measurement table** (e.g. `insights.org_binding_gap`: organization_id, reason,
candidate_count, candidates_json, computed_at). Not a decision surface, so it never
competes with `registry_observations`; purely makes the gap countable over time. Smaller,
touches no governed path, and is the closer fit for "data quality pipeline".

**Not implemented.** A is a real refactor of a governed binding path and deserves a focused
pass rather than being started with limited context; B is small but should be a deliberate
choice rather than a default. Recommend **B first** (measurement, immediate, zero risk),
then A when the queue UI work is being touched anyway.

### Note on `B & R PLUMBING`
My earlier claim that it "now matches exactly 1 entity and is bindable" used a SQL `LIKE`
pattern, not the pipeline's normalized name key. `B & R PLUMBING` vs `B & R Plumbing Inc`
normalize to different keys, so it is likely **absent**, not ambiguous — a different bucket
with a different fix. Do not act on the "bindable" claim without re-checking against the
real key function.

---

## Summary

| item | outcome |
|---|---|
| Duplicate entities | **Does not exist.** 0 UBI collisions across 853 name-variant groups. No work. |
| 30 phone-sharing groups | Corporate-family lane; that table is empty because its loader was never built |
| Silent ambiguous bucket | **Real**, located to `registry-observations.ts:802-809`; two shapes proposed, B recommended first |
| `B & R PLUMBING` "bindable" | Retracted — measured with `LIKE`, not the normalized key |
