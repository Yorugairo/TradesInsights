-- Make the binding gap countable. Phase B of the ambiguous-binding plan.
--
-- THE PROBLEM THIS SOLVES IS INVISIBILITY, NOT MATCHING. An organization whose
-- name matches several registry entities produces NO RECORD OF ANY KIND: it is
-- not bound, no observation is emitted (registry-observations.ts:802-809 leaves
-- `hit` undefined and `ruleKey` empty), so nothing queues it and nothing counts
-- it. `binding-audit` can compute the buckets on demand, but it only ever logged
-- them — so between two manual runs the gap could grow, shrink, or change shape
-- and no one could tell. With contractors added daily that blind spot compounds.
--
-- SNAPSHOT PER RUN, NOT CURRENT STATE. `run_id` leads the primary key on
-- purpose. A single current-state row per organization would answer "what is
-- wrong today" and destroy the answer to "is it getting better", which is the
-- actual complaint. One row per org per run makes the trend readable with a
-- GROUP BY and costs nothing but disk.
--
-- NOT A DECISION SURFACE. Nothing reads this table to bind, merge, or accept
-- anything; it records what the audit already computes and used to throw away.
-- Keep it that way. The moment something binds off this table it needs the
-- governed path's guarantees (trust scoring, dedupe key, review status,
-- strict-bind gate) and this table has none of them.
--
-- `candidates_json` CARRIES NAMES, NOT JUST IDS, because it has to. The registry
-- lives behind a different role: `registry_internal` denies the Insights role
-- outright (42501), so a registry entity id stored here can never be resolved to
-- a name by SQL from this database. Either the name is captured at write time or
-- the row is unreadable by a human. Shape: [{"entityId": "...", "name": "..."}].
--
-- `candidate_count` MEANS "COULD PLAUSIBLY BIND", AND ONLY THAT. Buckets that
-- short-circuit before the index lookup (prefix_noise, person_shaped, generic)
-- record 0. `absent_from_registry` also records 0 even when a best near-miss
-- exists below the similarity floor — that near-miss goes in `detail`, not in
-- the count. The count feeds the percentile that sizes Phase A's fan-out cap,
-- and padding it with things nothing would ever bind to would size that cap off
-- noise.
--
-- NO FOREIGN KEY TO organizations, deliberately. This is an append-only
-- measurement log; a deleted organization should leave its history intact rather
-- than silently rewrite what a past run observed.

CREATE TABLE IF NOT EXISTS "org_binding_gap" (
  run_id          uuid        NOT NULL,
  organization_id uuid        NOT NULL,
  -- prefix_noise | person_shaped | generic | exact_match_ambiguous |
  -- exact_match_no_candidate | near_match_fixable | absent_from_registry
  reason          text        NOT NULL,
  organization_name text      NOT NULL DEFAULT '',
  candidate_count integer     NOT NULL DEFAULT 0,
  candidates_json jsonb       NOT NULL DEFAULT '[]'::jsonb,
  detail          text,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, organization_id)
);

CREATE INDEX IF NOT EXISTS org_binding_gap_reason_idx
  ON org_binding_gap (reason, computed_at DESC);
CREATE INDEX IF NOT EXISTS org_binding_gap_org_idx
  ON org_binding_gap (organization_id, computed_at DESC);

COMMENT ON TABLE org_binding_gap IS
  'Append-only snapshot of why each unbound organization has no registry '
  'candidate, one row per organization per binding-audit run. Measurement only '
  '- nothing binds off this table.';
