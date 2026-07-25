# Plan: Light up the Google-confirmed queue, surface the contested places

## Summary

Tonight's re-score put Google identity on 1,679 more registry entities, but the
review queue cannot see it: 178 pending candidates hold payloads written before
the enrichment. This plan refreshes them, gives the 143 contested listings their
first surface, makes primary contractors findable in a 278-row queue, rescopes
the binding diagnostic, and fixes a latent ROI mislabel.

## User Story

As the reviewer working the registry queue, I want the strongest available
evidence — WA L&I and Google independently agreeing on a business's phone AND
name — to be visible on the candidates it applies to, so that the highest-confidence
binds are one click instead of buried.

## Problem → Solution

| Current | Desired |
|---|---|
| 178 candidates carry pre-enrichment payloads; 49 show as Google-confirmed | Payloads refreshed; up to 47 more promote to the confirmed band |
| 143 contested listings exist in no queue, no view, no UI | A contract view + review surface, with all claimants shown |
| 46 primary contractors buried in a 278-row queue | One-click grouping, mirroring the Google-confirmed button |
| Binding diagnostic labelled "re-run after enrichment" on a false premise | Rescoped to the buckets enrichment genuinely cannot move |
| ROI counts B/C-grade corroboration as "unsupported facts" | Counts only genuinely unsupported facts |

## Metadata
- **Complexity**: Medium
- **Source PRD**: N/A — continues `evidence-audit-person-refusal-google-rescore-plumbing.plan.md` (archived, complete)
- **Estimated files**: ~10 (2 registry, 8 Insights)
- **Order**: 1 → 3 → 2 → 4 → 5 (see Sequencing note)

---

## CORRECTION CARRIED FORWARD — read before Task 4

The archived plan said Task 3.1's value was measuring the **enrichment delta** to
scope targeted matching work. **That premise was wrong and is retired here.**

`google_name` is **not a match key**. The binding name index is built from
`canonicalName`, `aliases` and `brands` only
(`registry-observations.ts:647-662`). Google names feed three other things:

1. `classifyGoogleConfirmation` → the `google_confirmation` payload verdict
2. `registry_google_name` in the payload, as reviewer evidence
3. `classifyReviewTier` — `googleConfirmed` is worth 2 points, and tier 1 is ≥2

So enrichment moves **zero** rows out of the `no_registry_name_match` bucket. It
raises confidence on pairs already found; it never finds new ones.

**This is deliberate and should stay that way.** Google listing names are
user-editable and unverified. Promoting them to match keys would make a hijacked
or mis-edited listing a route to binding the wrong entity. Evidence is the
correct home for this signal.

---

## Measured baseline (2026-07-25 — verify, do NOT re-derive)

### The queue
| Measure | Value |
|---|---|
| Pending observations | 278 |
| Already Google-confirmed (tier 1) | 49 |
| Payloads with no `registry_google_name` | 178 |
| **Of those, entity NOW has google name + phone** | **47** |

### Regeneration is safe — verified, not assumed
`strict-bind:preview` reports `strictCandidates: 0` and `strictAutoBound: 0`.
That counter is computed in BOTH the dry-run and live paths
(`registry-observations.ts:1321-1332`, before the dry-run branch), so it is a
true reading: **an apply would auto-bind nothing.** It is a pure payload refresh.

The preview's other zeros are NOT evidence of "nothing to do" — dry-run skips
already-existing dedupe keys with `continue` (line 1339), and `rescored` is only
incremented on the live path (line 1412). The refresh mechanism is the
`ON CONFLICT (dedupe_key) DO UPDATE SET payload_json = EXCLUDED.payload_json …
WHERE registry_observations.status = 'pending'` at lines 1401-1407 — guarded so
decided rows are never resurrected.

### Contested listings
| Measure | Value |
|---|---|
| Contested links (`shared_profile` / `relationship_pending`) | 143 |
| **Visible in `google_place_review_v1`** | **0** |

They are invisible to every existing surface. This needs a new view, not a filter.

### Primary contractors
| Measure | Value |
|---|---|
| Primary-contractor orgs | 215 |
| Bound | **0** |
| Unbound WITH a pending candidate | 46 |
| Unbound with NO candidate | 169 |

`ReviewRow` carries no role field; the payload has only a `role_records` count.

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `packages/resolution/src/registry-observations.ts` | 1290-1345, 1395-1415 | The dry-run branch and the refresh upsert Task 1 depends on |
| P0 | `apps/web/app/app/admin/registry-review/actions.tsx` | 52-76, 162-190, 300-315 | `ReviewRow`, `selectTier`, and the EXISTING Google-confirmed button Task 3 mirrors |
| P0 | `packages/resolution/src/google-place-scrape.ts` | all | `classifyGoogleConfirmation` usage + SKIP_SAFE_READ, mirrored by Task 2's reader |
| P0 | `<registry>/apps/registry/supabase/migrations/20260726010000_google_place_scrape_contract_view.sql` | all | The contract-view + GRANT pattern Task 2 mirrors exactly |
| P1 | `apps/web/app/app/admin/google-place-review/{page,actions,batch-table}.tsx` | all | The review-surface pattern Task 2 mirrors |
| P1 | `apps/web/app/app/admin/registry-review/page.tsx` | 40-60, 200-215 | Where Task 3 adds the primary-contractor set |
| P2 | `packages/delivery/src/roi.ts` | 88-100 | Task 5's two-line change |

**Registry worktree**: `C:\Users\Snipe\Downloads\OneTradeNetwork` (branch
`codex/otn-app-extraction`), canonical app dir `apps/registry`. The nested
`.claude/worktrees/*` copies are being retired — do NOT add new work there.

---

## Patterns to Mirror

### CONTRACT_VIEW_AND_GRANT
// SOURCE: registry `20260726010000_google_place_scrape_contract_view.sql`
```sql
CREATE OR REPLACE VIEW registry_public.<name>
WITH (security_invoker = false) AS
SELECT ... WHERE ... AND e.status = 'active';

COMMENT ON VIEW registry_public.<name> IS '...';

-- Least-privilege read for the seam. Deliberately NO grant to
-- anon/authenticated/public.
GRANT USAGE ON SCHEMA registry_public TO otn_insights_reader;
GRANT SELECT ON registry_public.<name> TO otn_insights_reader;
```
A view replace can drop privileges — ALWAYS re-assert both GRANTs.

### SKIP_SAFE_READ
// SOURCE: `packages/resolution/google-place-scrape.ts:38-41, 76-84`
```ts
const UNDEFINED_TABLE = "42P01";
function isMissingRelation(err: unknown): boolean {
  return typeof err === "object" && err !== null &&
    (err as { code?: unknown }).code === UNDEFINED_TABLE;
}
```
Swallow ONLY 42P01 — a permission error must never look like "no data".

### CLIENT_BUNDLE_TYPE_ONLY_IMPORT
// SOURCE: `apps/web/app/app/admin/registry-review/actions.tsx:71-76`
> This is a "use client" component, so a VALUE import from that barrel pulls the
> whole server module graph — including `pg` — into the browser bundle and the
> build fails on node-only requires. Types are erased at compile time and stay safe.

Tier labels are restated locally rather than imported. Task 2 and 3 must obey this.

### ONE_CLICK_GROUPING
// SOURCE: `registry-review/actions.tsx:175, 304-313`
```tsx
const googleConfirmedRows = useMemo(() => rows.filter((r) => r.googleConfirmed), [rows]);
...
<button onClick={() => setSelected(new Set(googleConfirmedRows.map((r) => r.id)))}>
  L&amp;I + Google confirmed ({googleConfirmedRows.length})
</button>
```

---

## Files to Change

| File | Action | Task |
|---|---|---|
| `apps/web/app/app/admin/registry-review/page.tsx` | UPDATE | 3 — fetch primary-contractor org set |
| `apps/web/app/app/admin/registry-review/actions.tsx` | UPDATE | 3 — `ReviewRow.primaryContractor` + button |
| `<registry>/apps/registry/supabase/migrations/20260727010000_google_place_contested_view.sql` | CREATE | 2 |
| `packages/resolution/src/google-place-contested.ts` | CREATE | 2 — reader |
| `packages/resolution/src/google-place-contested.test.ts` | CREATE | 2 |
| `packages/resolution/src/index.ts` | UPDATE | 2 — barrel |
| `apps/web/app/app/admin/google-place-contested/{page,actions}.tsx` | CREATE | 2 — surface |
| `apps/worker/src/cli/binding-audit.ts` | CREATE | 4 |
| `packages/delivery/src/roi.ts` | UPDATE | 5 |

## NOT Building

- **`google_name` as a match key.** Deliberate — see the correction above.
- **No auto-resolution of contested places.** A human picks the owner; the code
  only presents the claimants. Two companies cannot own one listing, and guessing
  is worse than showing the conflict.
- **No auto-binding widening.** `evaluateStrictBind` untouched. Verified 0 strict
  candidates pending, and that must stay a separate owner decision.
- **No person-shape refusal.** Still gated on the full L&I load (roadmap P6).
- **No re-scrape.** All observations already exist.

---

## Sequencing note

Tasks 1 and 3 both concern the same queue, but they are **independent** and Task 3
does NOT require regeneration. Task 3 fetches primary-contractor org IDs at render
time rather than stamping them into the payload — deliberately, because a role can
change after an observation is generated, and a frozen copy would go stale while
the live query cannot. Do Task 1 first only because it is a single command with
immediate visible payoff.

---

## Step-by-Step Tasks

### Task 1: Refresh the stale payloads
- **ACTION**: Run `pnpm --filter @otn/worker strict-bind:apply`.
- **IMPLEMENT**: No code. This is an operational step whose safety was verified
  above (`strictCandidates: 0` ⇒ nothing auto-binds).
- **VALIDATE**: `rescored` > 0 in the output. Then re-run the baseline query:
  ```sql
  SELECT count(*) FILTER (WHERE payload_json->>'google_confirmation' = 'phone_and_name')
    FROM insights.registry_observations WHERE status = 'pending';
  ```
  EXPECT: rises from 49 toward ~96 (47 candidates are eligible; the true figure is
  however many actually score `phone_and_name` rather than `phone_only`/`name_only`).
  Confirm in the UI that the existing "L&I + Google confirmed (N)" button shows the
  higher count.
- **GOTCHA**: Do NOT report the eligible count as the achieved count. 47 is a
  ceiling, not a promise — `classifyGoogleConfirmation` decides each one.
- **GOTCHA**: If `rescored` is 0, stop and investigate before doing anything else;
  it means the refresh path did not fire and the premise of this task is wrong.

### Task 2: Surface the 143 contested listings
- **ACTION**: Registry contract view + Insights reader + admin page.
- **IMPLEMENT (registry)**: `registry_public.google_place_contested_v1`, one row
  per contested link: `entity_id`, `entity_name`, `google_place_id`,
  `scraped_name`, `scraped_phone`, `lni_name`, `lni_phone`, `link_status`,
  `competing_entity_ids` (from `evidence`), `shared_licence_count`. Filter
  `match_method = 'otn_insights_phone_and_name' AND relationship_type =
  'shared_profile' AND link_status = 'relationship_pending'`.
- **IMPLEMENT (Insights)**: `google-place-contested.ts` exporting
  `GOOGLE_PLACE_CONTESTED_VIEW`, `loadContestedPlaces(pool)`, and a pure
  `groupByPlace(rows)` that collapses claimants under one place id — the reviewer
  decides per PLACE, not per link.
- **IMPLEMENT (UI)**: read-only admin page grouping claimants per place, showing
  each claimant's L&I name/phone against the single Google listing. **No accept
  action in this task** — presenting the conflict is the deliverable.
- **MIRROR**: CONTRACT_VIEW_AND_GRANT, SKIP_SAFE_READ, CLIENT_BUNDLE_TYPE_ONLY_IMPORT.
- **GOTCHA**: `competing_entity_ids` lives inside the `evidence` jsonb the loader
  wrote; it is not a column. Extract with `evidence->'competing_entity_ids'`.
- **GOTCHA**: 143 links do NOT mean 143 decisions — they cluster onto far fewer
  place ids. Group before counting, and report both numbers.
- **VALIDATE**: view returns 143 rows; grouped count is lower and is the number of
  human decisions; page renders; as `otn_insights`, `registry_internal` still
  denies with 42501.

### Task 3: Primary-contractor lane in the review queue
- **ACTION**: Add `primaryContractor` to `ReviewRow` and a grouping button.
- **IMPLEMENT**: In `page.tsx`, one query for the org IDs holding a
  `primary_contractor` role:
  ```sql
  SELECT DISTINCT organization_id FROM project_roles WHERE role = 'primary_contractor'
  ```
  Build a `Set`, set `primaryContractor` per row. In `actions.tsx` add
  `primaryContractorRows` via `useMemo` and a button beside the Google-confirmed
  one.
- **MIRROR**: ONE_CLICK_GROUPING, exactly — same `useMemo` + `setSelected` shape.
- **GOTCHA**: `actions.tsx` is `"use client"`. Do the query in `page.tsx` (server)
  and pass a plain boolean; never import a value from `@otn/resolution` there.
- **GOTCHA**: expect ~46 rows, not 215. The other 169 primary contractors have no
  pending candidate at all — Task 4 explains why, and no UI can conjure them.
- **VALIDATE**: button count equals the measured 46; selecting it selects exactly
  those rows.

### Task 4: Binding diagnostic (rescoped)
- **ACTION**: `apps/worker/src/cli/binding-audit.ts` — read-only. Bucket the 169
  primary-contractor orgs with no candidate: `person_shaped` · `prefix_noise`
  (`TENANT:`, leading `*`) · `generic` · `no_registry_name_match` ·
  `ambiguous_multi_match`.
- **WHY**: MEASURE_BEFORE_CHANGING. "Improve matching" is unfalsifiable; "38 of
  169 are prefix noise" is a task. The split decides whether targeted matching work
  is worth building at all.
- **GOTCHA**: Do NOT frame any bucket as enrichment-addressable. Per the correction
  above, `google_name` is not a match key, so no amount of Google data moves
  `no_registry_name_match`. Retire that framing wherever it appears.
- **GOTCHA**: reuse `isPersonShapedOrgName` for the `person_shaped` bucket — do not
  write a second person test.
- **VALIDATE**: buckets sum to exactly 169; print 10 sample names per bucket.

### Task 5: Fix the ROI unsupported-facts mislabel
- **ACTION**: `roi.ts:95-98` counts `oe.confirmed = false` as "unsupported facts".
- **IMPLEMENT**: `confirmed = false` means "linked, real evidence, not A-grade" —
  legitimate corroboration, not an unsupported fact. Count genuinely unsupported
  facts instead: opportunities whose linked evidence includes NO confirmed row.
  Update the comment, which currently claims "gate keeps this 0".
- **GOTCHA**: today every evidence row is grade A so the metric reads 0 either way.
  This is latent, not live — it breaks the first time a B or C source lands, and
  the failure mode is a quality metric that alarms on healthy data.
- **VALIDATE**: `vitest` on delivery; metric still 0 against current data (all
  grade A), and a synthetic B-grade row does NOT count as unsupported.

---

## Testing Strategy

| Test | Input | Expected | Edge? |
|---|---|---|---|
| `groupByPlace` collapses claimants | 3 links, 1 place | 1 group, 3 claimants | |
| `groupByPlace` keeps places separate | 2 links, 2 places | 2 groups | |
| contested reader skip-safe | view absent (42P01) | `[]`, no throw | ✓ |
| contested reader rethrows | permission error (42501) | throws | ✓ |
| primary-contractor filter | mixed rows | only role-holders selected | |
| ROI unsupported | all grade-A evidence | 0 | |
| ROI unsupported | a B-grade linked row | still 0 (corroboration ≠ unsupported) | ✓ |

### Edge Cases Checklist
- [ ] Contested place where a claimant was since bound elsewhere
- [ ] Empty contested set (all resolved) → page renders empty, not error
- [ ] Zero primary contractors in queue → button hidden, mirroring Google-confirmed
- [ ] `rescored` = 0 on Task 1 → treated as a failure signal, not a no-op

---

## Validation Commands

### Static Analysis
```bash
npx tsc --noEmit -p packages/resolution/tsconfig.json
```
EXPECT: zero errors (repeat for `packages/delivery`, `apps/worker`, `apps/web`)

### Unit Tests
```bash
npx vitest run packages/resolution packages/intelligence packages/delivery
```
EXPECT: all pass (465 green at plan time, plus new)

### Build (catches client-bundle violations)
```bash
pnpm --filter @otn/web build
```
EXPECT: success — a value import in a `"use client"` file fails HERE, not in tests

### Seam
```bash
pnpm --filter @otn/worker strict-bind:preview
```
EXPECT: still `strictAutoBound: 0` — no auto-binding was widened

### Manual
- [ ] "L&I + Google confirmed (N)" shows a higher N than 49
- [ ] Contested page lists every claimant per place with both names and phones
- [ ] As `otn_insights`: new view readable, `registry_internal` denies with 42501

---

## Acceptance Criteria
- [ ] Task 1: `rescored` > 0; confirmed band above 49; **nothing auto-bound**
- [ ] Task 2: 143 links surfaced, grouped by place; no accept action shipped
- [ ] Task 3: button count matches the measured 46
- [ ] Task 4: buckets sum to 169; no bucket framed as enrichment-addressable
- [ ] Task 5: B/C-grade corroboration no longer counts as unsupported
- [ ] `google_name` is still NOT a match key
- [ ] Types, lint, tests, and the web build all clean; both repos pushed

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Task 1 auto-binds something unexpected | **Low — measured 0** | High | `strictCandidates: 0` verified in both paths; re-check preview immediately before applying |
| Fewer than 47 promote, read as failure | Medium | Low | 47 is a ceiling; `classifyGoogleConfirmation` decides. State ceiling vs achieved separately |
| Client-bundle break in the new UI | Medium | Medium | Type-only imports; `pnpm --filter @otn/web build` is the gate that catches it |
| Contested view replace drops GRANTs | Medium | High | Re-assert both GRANTs in the same migration; verify as `otn_insights` |
| Contested count mistaken for decision count | High | Low | Group by place before reporting; publish both numbers |

## Notes

- **Task 1 is the cheapest win in the backlog** — one command, no code, and it
  delivers the thing originally asked for at the start of this workstream:
  *"I should be seeing 'L&I + Google Match! Direct name match on Google Profile!'"*
  The UI button already exists; only the data behind it is stale.
- **Task 2 is the largest** and creates no new capability for the owner beyond
  visibility — but 143 unresolved conflicts that no screen shows is exactly the
  state that quietly rots.
- **Task 5 is latent.** Skipping it is defensible today; it only bites when the
  first non-A source lands, which is also precisely when nobody will be looking
  for a metric-definition bug.
- Insights trunk `claude/tmux-install-320aiz`; registry trunk `release/trades-staging`.
  Never target `main`.
