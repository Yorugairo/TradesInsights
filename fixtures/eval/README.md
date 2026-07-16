# Labeled evaluation set (M4.1)

`eval-set.v1.jsonl` — 200 labeled examples from the live corpus (frozen 2026-07-16):
125 positives (50 Lacey Glass at Home / 25 Lacey Glass Commercial / 50 Solis Interiors) and
75 hard negatives, split 150 dev / 50 holdout (stratified within every category).

Each example freezes the exact `ProjectFeatures` the scorer saw plus the labeling clock
(`frozenAt`, injected as the scoring `now`), so `pnpm eval:run` is a deterministic replay:
same set + same rule versions → identical metrics, forever.

## Provenance and labeling method

- Candidates are generated reproducibly by `pnpm eval:build` (stable ordering, no randomness);
  category filters live in `apps/worker/src/cli/eval-build.ts`.
- Labels were assigned by internal review of each example's stored evidence text against the
  written account rules (`config/account-profiles.yaml`, spec §12) — the same method as the
  M3.8 reviewed samples. **Labels follow the rules as currently written**; where those rules
  are provisional (Solis package size, At Home minimum job size), so are the labels.
- Case-by-case reviewer rejections are recorded in `review-exclusions.v1.json`
  (`account:projectId` → reason) and applied at generation time, so every judgment call is
  auditable.
- Customer calibration (spec §22) revises labels by publishing `eval-set.v2.jsonl` — never by
  editing v1.

## Positive / hard-negative definitions

- **positive** — per the written account rules this project deserves the account's attention
  (weekly digest band or better). The recall gate (≥80%, spec §19) counts positives reaching
  `weekly_digest` or `priority_review`.
- **hard_negative** — superficially attractive (right keywords, high valuation, nearby
  geography) but not a real opportunity for that account: wrong trade (site work, MEP/fire,
  reroofs), out of territory (King for At Home), demolition-only, oversized for capacity,
  below minimum package, or non-building actions. The priority-precision gate (≥90%) counts
  hard negatives leaking into `priority_review` against the system.

## Categories

| Account | Positives | Hard negatives |
|---|---|---|
| lacey_glass_at_home | sfr_new (42), subdivision_cluster (8) | ah_out_of_territory (5), ah_small_work (10) |
| lacey_glass_commercial | commercial_glazing (3), commercial_building_alteration (22) | site_field_work (10), demo_only (8), mep_fire_only (7) |
| solis_interiors | interior_ti (50) | si_non_interior_trade (12), si_oversized_new_multifamily (10), si_residential_small (8), si_non_building (5) |

Explicit-glazing vocabulary is rare in the corpus (3 projects at sampling time) — the
commercial_building_alteration bucket carries the remainder of the Commercial positives.
