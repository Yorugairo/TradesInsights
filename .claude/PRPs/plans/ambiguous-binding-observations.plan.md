# Plan: Surface unbindable orgs — Phase B (measure) then Phase A (queue)

Self-contained spec. Everything below was measured or read from source on 2026-07-25;
nothing here needs re-deriving after a compact.

## Summary

An org whose name matches several registry entities produces **no record of any kind** —
it is not bound, not queued, not counted. Fix in two phases:

- **Phase B — measure.** Persist the binding-audit buckets so the gap is countable and
  trendable. No decision surface, no governed path touched, zero risk.
- **Phase A — queue.** Emit one review-only observation per candidate so a human can
  actually resolve the ambiguity.

## Why B before A

1. **B is zero-risk and immediate.** It writes to a new table nothing else reads. A
   touches `registry-observations.ts`, the code that decides what auto-binds.
2. **B sizes A.** A needs a fan-out cap, and the right cap depends on the real
   distribution of candidate counts — which today is known only for one example
   (FASTSIGNS = 16). B measures the whole population first, so the cap is chosen from
   data rather than from the worst anecdote.
3. **B is the safety net for A.** With B in place, A's effect is measurable: the
   ambiguous bucket should shrink as rows get resolved. Without it, A ships blind.
4. **B keeps working if A stalls.** The gap stops being invisible either way.

---

# Phase B — persist the binding gap

## Task B1: the measurement table

```sql
CREATE TABLE IF NOT EXISTS insights.org_binding_gap (
  run_id          uuid        NOT NULL,
  organization_id uuid        NOT NULL,
  reason          text        NOT NULL,   -- ambiguous_name | absent_from_registry |
                                          -- person_shaped | generic | near_match_fixable | ...
  candidate_count integer     NOT NULL DEFAULT 0,
  candidates_json jsonb       NOT NULL DEFAULT '[]'::jsonb,
  detail          text,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, organization_id)
);
CREATE INDEX IF NOT EXISTS org_binding_gap_reason_idx ON insights.org_binding_gap (reason, computed_at DESC);
CREATE INDEX IF NOT EXISTS org_binding_gap_org_idx    ON insights.org_binding_gap (organization_id, computed_at DESC);
```

- **SNAPSHOT PER RUN, NOT CURRENT-STATE.** `run_id` in the PK is the point: the complaint
  is that drift between manual audits is undetectable. One row per org per run makes the
  trend visible; a single current-state row would not.
- **NOT A DECISION SURFACE.** Nothing reads this to bind anything. It records what the
  audit already computes and currently throws away. Keep it that way — the moment
  something binds off this table it needs the governed path's guarantees.

## Task B2: persist from the existing audit

- `apps/worker/src/cli/binding-audit.ts` already computes the buckets
  (prefix_noise / person_shaped / generic / exact_match_ambiguous /
  exact_match_no_candidate / near_match_fixable / absent_from_registry).
- Add a `--persist` flag that writes one row per unbound org with its bucket as `reason`,
  its candidate entity ids in `candidates_json`, and a single `run_id` for the run.
- **GOTCHA**: do not recompute the buckets in a second place. Persist what the audit
  already produces — a divergent second classifier is worse than no persistence.
- **VALIDATE**: `--persist` twice yields two distinct `run_id`s and identical bucket
  counts; the three known orgs appear with `reason='exact_match_ambiguous'`.

## Task B3: read the distribution (this feeds Phase A)

```sql
SELECT reason, count(*) AS orgs,
       round(avg(candidate_count),1) AS avg_candidates,
       max(candidate_count) AS worst,
       percentile_disc(0.95) WITHIN GROUP (ORDER BY candidate_count) AS p95
FROM insights.org_binding_gap
WHERE run_id = (SELECT run_id FROM insights.org_binding_gap ORDER BY computed_at DESC LIMIT 1)
GROUP BY reason ORDER BY orgs DESC;
```

**Use `p95` to choose Phase A's fan-out cap.** The cap of 5 proposed below is a placeholder
derived from a single example; replace it with a number this query justifies.

---

# Phase A — review-only observations for ambiguous matches

## The defect — exact location

`packages/resolution/src/registry-observations.ts:802-809`

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
1. `agreeing.length !== 1` → `hit` undefined, `ruleKey` stays `""` → no observation emitted.
2. `nameHits.length > 1` **and** `phones.size === 0` → branch never entered at all.

Verified: `B & R PLUMBING`, `PYE-BARKER FIRE & SAFETY LLC`, `FASTSIGNS` are all unbound
with **zero rows** in `insights.registry_observations`.

## Facts that shape the implementation (all verified)

| Fact | Source | Consequence |
|---|---|---|
| `registry_observations.registry_entity_id` is **NOT NULL** | information_schema | Cannot express "N candidates" in one row → one row per candidate |
| `evaluateStrictBind:149` = `ruleKey === "binding_name_exact" \|\| ruleKey === "binding_name_phone"` | source | A new rule key is strict-ineligible **by construction**. Do NOT edit this line. |
| `dedupeKey` is `` `bind:${org.id}:${hit.entityId}` `` (:1093) | source | Already org+entity scoped — N candidates give N distinct keys. No dedupe redesign. |
| `organization_id`, `rule_key`, `payload_json`, `trust_score`, `dedupe_key`, `status` all NOT NULL | information_schema | Every emitted row must populate these |
| FASTSIGNS matches **16** entities | measured | Fan-out cap required |
| Name rules also listed at **:947-948** and **:1535-1536** | source | Scoring + `classifyReviewTier` need a deliberate decision for the new rule |

## Implementation

### Task 1: add the rule key
- Add `export const AMBIGUOUS_NAME_RULE = "binding_name_ambiguous";` near
  `SINGLE_TOKEN_NAME_RULE` (:91).
- **GOTCHA**: do NOT add it to `evaluateStrictBind:149`. Its absence there is the
  safety property — it makes auto-binding impossible rather than merely disallowed.

### Task 2: emit one observation per candidate
- In the `:802` branch, when the ambiguity is NOT resolved to exactly one candidate,
  emit an observation for each candidate in `nameHits` instead of falling through.
- Also enter this path when `phones.size === 0` — today the `&& phones.size > 0`
  condition means a phone-less ambiguous org is never even considered.
- **GOTCHA**: the surrounding loop assumes ONE `hit` per org and pushes one observation
  (~:1093). Emitting N requires restructuring that push into a loop over candidates —
  this is the real work of the task, not the rule key.
- **CAP**: emit at most N candidates, ordered deterministically (e.g. by entity_id) so
  re-runs are stable. Record the true `candidate_count` in `payload_json` so a capped row
  never reads as "only N matched". Log what was dropped.
  **N comes from Task B3's p95, not from a guess.** FASTSIGNS' 16 is the worst case I
  happened to look at, not the distribution — if p95 is 3, a cap of 5 is already generous;
  if p95 is 12, a cap of 5 silently hides the majority of most orgs' candidates. Run B
  first and read the number.
- `dedupeKey` needs no change — `bind:${org.id}:${entityId}` is already unique per pair.

### Task 3: scoring and tier
- `:947-948` and `:1535-1536` list the name rules for scoring / `classifyReviewTier`.
  Decide explicitly whether `binding_name_ambiguous` participates.
- **Recommendation**: give it a LOW trust score and a review tier that sorts below
  unambiguous candidates. An ambiguous match is weaker evidence than an exact one, and
  the queue ordering should say so.

### Task 4: governance test
- Mirror the existing test in `packages/resolution/src/registry-observations.test.ts`
  that asserts `evaluateStrictBind` returns `strict: false` for `SINGLE_TOKEN_NAME_RULE`.
- Add the same assertion for `AMBIGUOUS_NAME_RULE`. This is the regression guard: if
  someone later adds the rule to the `:149` list, the test fails.

## Validation

```bash
cd C:/Users/Snipe/Downloads/TradesInsights
pnpm --filter @otn/resolution test    # governance test must pass
```

```sql
-- Before: 0. After: >0, and none accepted automatically.
SELECT o.canonical_name, count(r.id) AS observations,
       count(*) FILTER (WHERE r.status = 'accepted') AS auto_accepted
FROM insights.organizations o
LEFT JOIN insights.registry_observations r ON r.organization_id = o.id
WHERE o.canonical_name IN ('B & R PLUMBING','PYE-BARKER FIRE & SAFETY LLC','FASTSIGNS')
GROUP BY o.canonical_name;
```

**`auto_accepted` MUST be 0.** If any ambiguous observation auto-accepted, the strict gate
was breached and the change must be reverted.

## NOT building
- Any change to `evaluateStrictBind`. Its exclusion list is the safety property.
- Auto-binding or auto-merging of ambiguous candidates — governed path, human decides.
- Entity merges. Separately disproven: 853 suffix-variant name groups, **0 share a UBI**
  (`triage-followup-20260725.md`). There is no duplicate-entity population.

## Context worth keeping
- `B & R PLUMBING` may be **absent** rather than ambiguous — my earlier "matches exactly 1"
  used a SQL `LIKE`, not the pipeline's normalized name key. Re-check against the real key
  before assuming it lands in this bucket.
- Option B (a measurement table, not a decision surface) was the recommended first step in
  `triage-followup-20260725.md` as lower-risk. This plan is Option A, chosen by the owner.
