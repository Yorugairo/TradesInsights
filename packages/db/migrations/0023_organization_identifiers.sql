-- Contractor identifiers harvested from PUBLIC source evidence (portal detail
-- pages, L&I-sourced feeds): phones, UBIs, license numbers, emails. Every row
-- carries the source record it came from (no claim without a source); values
-- are stored normalized beside the raw form. This is the supply side of
-- identifier-based registry matching (phone-exact, and strong-key ubi/license
-- backfeed onto organizations) — account-private artifacts are deliberately
-- excluded from this table by policy.
CREATE TABLE organization_identifiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  identifier_type text NOT NULL CHECK (identifier_type IN ('phone', 'ubi', 'contractor_number', 'email')),
  value_raw text,
  value_normalized text NOT NULL,
  source_record_id uuid NOT NULL REFERENCES source_records (id),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, identifier_type, value_normalized)
);
CREATE INDEX organization_identifiers_value_ix
  ON organization_identifiers (identifier_type, value_normalized);
CREATE INDEX organization_identifiers_org_ix
  ON organization_identifiers (organization_id);
