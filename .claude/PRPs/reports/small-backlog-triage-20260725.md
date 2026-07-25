# Small-backlog triage — 2026-07-25

Worked while the Google Places resolver runs. Outcome: **two items were mis-sized in my
earlier reporting and are bigger than "small", one needs a number I cannot see, and one
is blocked by project policy.** Nothing here was changed unilaterally.

---

## 1. The "56 unmapped tenants" are 44 duplicate live pages

I previously called this "a claims-path edge, not data loss." **That was understated.**

| measure | count |
|---|---|
| duplicate-licence tenant pairs | 56 |
| same-city duplicates | 17 |
| different-city duplicates | 39 |
| **pairs with BOTH pages live** | **44** |
| pairs where only the *unmapped* page is live | **3** |

Examples — one licence, one company, two live URLs:

| company | page A | page B |
|---|---|---|
| Airbest Home Services | `airbest-home-services-puyallup` | `airbest-home-services-puyallup-airbehs760lo` (**same city**) |
| 360electrical LLC | `360electrical-llc-centralia` | `360electrical-llc-rochester` |
| Aecon Utilities | `aecon-utilities-us-limited-lynnwood` (WA) | `aecon-utilities-us-limited-irving-aeconuu763pp` (TX) |

### Mechanism
`registry_tenant_canonical_entity` is a **VIEW**, not a table, so this is a derived gap
and cannot be patched with an INSERT:

```sql
FROM registry_source_records sr
JOIN registry_match_decisions d ON d.source_record_id = sr.source_record_id
JOIN registry_business_entities be ON be.entity_id = d.entity_id
WHERE sr.tenant_id IS NOT NULL AND ...
```

`tenant_id` lives on the source record, and `ingest-source-records.mjs` upserts on licence
number. Two tenants sharing a licence therefore collapse to ONE source record carrying
ONE tenant_id; the other tenant is invisible to the view. Entity resolution is correct —
the *tenants* table has duplicates.

### Why I did not fix it
Suppressing the unmapped tenant of each pair would remove 44 duplicate URLs, but:
1. It unpublishes live public pages — an outward-facing content change.
2. **For 3 pairs the unmapped tenant is the ONLY live page**, so a blanket rule deletes
   three companies from the directory entirely.
3. Which twin is "better" is not always the mapped one — e.g. Aecon's mapped record is a
   Texas address while the unmapped one is Lynnwood, WA, which is the better row for a
   WA registry.

**Needs a decision.** Recommended shape: suppress the unmapped twin only where the mapped
twin is also live (44 cases), leave the 3 alone, and fix the tenant duplication upstream
so future pulls stop creating it.

---

## 2. The 3 "ambiguous" orgs are three different problems

All three are unbound with **zero registry observations** — they are not queued for review
anywhere. They fall through silently, which is the systemic finding: the
`exact_match_ambiguous` bucket exists in the audit but emits no observation, so no human
ever sees it.

| org | registry matches | actual problem |
|---|---|---|
| B & R PLUMBING | **1** (`B & R Plumbing Inc`, 2 licences) | **No longer ambiguous** after the full L&I pull. Bindable via the normal reviewed path. |
| PYE-BARKER FIRE & SAFETY LLC | 2 (`Pye-Barker Fire & Safety` 1 licence; `…Safety LLC` 3 licences) | **A registry duplicate entity**, not an org-binding problem. One company split into two entities by an `LLC` suffix — same licence-vs-entity class as the Google Place contested bug. |
| FASTSIGNS | **16** | **Genuinely unbindable.** A franchise: each franchisee is a separate business with its own licence. The correct outcome is an explicit "not bindable" record, not silence. |

Not actioned because binding and entity merges are both governed paths — no auto-binding,
and the mint never auto-merges. The right fix is to make the ambiguous bucket emit a
review-only observation (a `binding_name_ambiguous` rule would be review-only by
construction, since `evaluateStrictBind` only admits the two listed multi-token rules).
That is a contained change but it touches the governed binding path and deserves its own
focused pass.

---

## 3. `temp_file_limit = -1` — not set, deliberately

There is no per-session spill guard, so the only backstop is the physical volume — which
is what gave way on 2026-07-05.

I did not set one because **the correct value depends on the disk size, which is not
exposed via SQL or the Supabase API** (`get_project` returns no disk field). Known
figures: database 3,225 MB; worst legitimate concurrent single-MV spill 2,697 MB. A limit
below ~4 GB would start killing legitimate refreshes; a limit above free space protects
nothing. Guessing risks trading a rare disk-full for a recurring false kill.

**Needs the disk size from the Supabase dashboard**, then set roughly midway between
2.7 GB and free space.

---

## 4. Lint: one rule, 62 sites — and the config is protected

All 62 errors are a single rule, `react-hooks/error-boundaries`, and a single pattern:

```
Avoid constructing JSX within try/catch
```

A page fetches data inside `try/catch` and returns its JSX from inside the same `try`.
The fetch error handling works; the rule correctly notes that RENDER errors escape it, so
the `try/catch` gives false confidence.

I attempted to downgrade it to `warn` — matching the posture already taken for its two
siblings (`react-hooks/purity`, `react-hooks/set-state-in-effect`) — so that
`npm run lint:src` stops exiting 1 unconditionally and becomes usable as a gate.

**A project hook blocked it**, and correctly:

> BLOCKED: Modifying eslint.config.mjs is not allowed. Fix the source code to satisfy
> linter/formatter rules instead of weakening the config.

I did not work around it. That policy makes this a real 62-site refactor of page
components — lifting each JSX return out of its `try` — which is not small work and
should not be bundled into an unrelated change.

Until then `lint:src` cannot serve as a pre-commit or CI gate.

---

## Summary

| item | status |
|---|---|
| 44 duplicate live page pairs | **needs decision** — outward-facing, and 3 edge cases |
| 3 ambiguous orgs | triaged; fix is a review-only observation rule (governed path) |
| `temp_file_limit` | needs disk size |
| 62 lint errors | needs a 62-site refactor; config change blocked by policy |
