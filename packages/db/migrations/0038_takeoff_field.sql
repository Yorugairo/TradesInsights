-- CRM upgrade: takeoff scaffold + field communication (deck appendix A5/A6).
--
-- Four tables, additive only. Two design decisions worth recording here:
--
-- 1. `field_links` is NOT `action_tokens`. An action token authorizes exactly
--    one action once (used_at is the claim), and its `action` column carries a
--    CHECK from migration 0019. A field link is the opposite contract: the same
--    crew member opens the same job page all week, so validity is
--    not-expired-and-not-revoked, never single-use. Extending action_tokens
--    would have meant relaxing the invariant that makes one-tap email safe.
--
-- 2. `takeoff_lines.source` splits 'derived' from 'manual' because re-derive
--    REPLACES derived lines and must NEVER touch manual ones — the customer's
--    edits are the product. The column is the invariant's anchor, not metadata.
--
-- Quantities and money are double precision to match pursuits
-- (estimated_contract_value etc.) — no new numeric type mid-codebase.

CREATE TABLE IF NOT EXISTS takeoff_sheets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One live sheet per pursuit: get-or-create races resolve on this constraint.
  pursuit_id uuid NOT NULL UNIQUE REFERENCES pursuits(id),
  account_profile_id uuid NOT NULL REFERENCES account_profiles(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'final')),
  waste_pct double precision NOT NULL DEFAULT 10,
  overhead_pct double precision NOT NULL DEFAULT 0,
  margin_pct double precision NOT NULL DEFAULT 0,
  -- Snapshot of the evidence the derivation read (text hits, valuation, sqft),
  -- so "why does this sheet say 4,200 sqft" is answerable after the records move.
  derived_from_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS takeoff_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id uuid NOT NULL REFERENCES takeoff_sheets(id),
  assembly_key text NOT NULL,
  description text NOT NULL,
  qty double precision NOT NULL DEFAULT 0,
  unit text NOT NULL CHECK (unit IN ('sqft', 'lf', 'each', 'allowance')),
  unit_cost double precision NOT NULL DEFAULT 0,
  source text NOT NULL CHECK (source IN ('derived', 'manual')),
  -- The matched evidence snippet for derived lines ("4,200 sq ft TI" / the
  -- valuation figure). NULL on manual lines. This is what makes a derived
  -- quantity auditable instead of oracular.
  provenance text,
  sort integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS takeoff_lines_sheet_ix ON takeoff_lines (sheet_id, sort);

CREATE TABLE IF NOT EXISTS field_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pursuit_id uuid NOT NULL REFERENCES pursuits(id),
  account_profile_id uuid NOT NULL REFERENCES account_profiles(id),
  -- SHA-256 of the raw token; the raw value is shown exactly once at mint and
  -- never lands in the database (action_tokens precedent, migration 0017).
  token_hash text NOT NULL,
  -- Who the link was handed to ("Javier"). Display + revocation bookkeeping,
  -- not identity — the link IS the credential.
  label text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS field_links_hash_ux ON field_links (token_hash);
CREATE INDEX IF NOT EXISTS field_links_pursuit_ix ON field_links (pursuit_id);

CREATE TABLE IF NOT EXISTS field_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pursuit_id uuid NOT NULL REFERENCES pursuits(id),
  -- NULL = authored from the cockpit, not through a field link.
  link_id uuid REFERENCES field_links(id),
  entry_type text NOT NULL CHECK (entry_type IN ('daily_log', 'change_order', 'note')),
  body text NOT NULL,
  -- daily_log only: {boards, tapedLf, crewHours} — validated in the service.
  quantities_json jsonb,
  -- change_order only: the claimed extra, in dollars. An ESTIMATE until approved.
  amount double precision,
  -- Typed signature ("Javier R") — the field-approval affordance from deck A5.
  submitted_name text,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'approved', 'rejected')),
  decided_at timestamptz,
  decided_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS field_entries_pursuit_ix ON field_entries (pursuit_id, created_at);
