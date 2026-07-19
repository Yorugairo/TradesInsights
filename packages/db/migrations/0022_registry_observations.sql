-- Integration seam increment 3 — the reviewed observation queue between
-- Insights and the One Trade Network registry (both directions), plus a cached
-- public-identity snapshot on bound organizations.
--
-- Every cross-system enrichment is an OBSERVATION with a deterministic trust
-- score; nothing binds identity, reaches a customer's bucket, or exports to the
-- registry until it is accepted (by the operator, or by a rule whose reviewed
-- accept-history has earned auto-accept). Decisions feed the per-rule accept
-- rate, so scoring improves deterministically with each review pass.
CREATE TABLE registry_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- binding_name_match | phone_adoption | alias_export | trade_export
  observation_type text NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  registry_entity_id text NOT NULL,
  -- Which deterministic rule produced this observation (accept-rate bucket).
  rule_key text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  trust_score double precision NOT NULL,
  trust_components_json jsonb NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  decided_by text,
  decided_at timestamptz,
  decision_note text,
  -- Stamped when an accepted export-type observation lands in registry_partner.
  exported_at timestamptz,
  -- Stamped when an accepted observation materializes locally (bind / contact).
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX registry_observations_review_ix
  ON registry_observations (status, trust_score DESC) WHERE status = 'pending';
CREATE INDEX registry_observations_org_ix ON registry_observations (organization_id);
CREATE INDEX registry_observations_rule_ix ON registry_observations (rule_key) WHERE decided_at IS NOT NULL;

-- Cached PUBLIC identity snapshot from the registry contract view, stamped at
-- bind time (name, licenses, phone, locality + snapshot time). Display cache
-- only — the registry stays the identity authority; refreshed on rebind.
ALTER TABLE organizations ADD COLUMN registry_identity_json jsonb;
