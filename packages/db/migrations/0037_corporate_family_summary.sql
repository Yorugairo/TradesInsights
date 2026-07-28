-- Materialised corporate-family snapshot.
--
-- The derivation needs the ENTIRE registry identity view — 72,952 rows,
-- 5.2s warm / 29-79s cold across the seam — which is why deriving per request
-- made /app/admin/corporate-families a 109-second page and tipped the cockpit
-- past statement_timeout into a 500. A process cache fixed the steady state
-- but still paid the full cold derivation after every deploy. The nightly
-- maintenance chain now derives once and persists here; the web reads tables.
--
-- ADDITIVE ONLY, NO BACKFILL: the first maintenance run populates both tables.
-- Until then the web falls back to the on-demand derivation, exactly as before
-- this migration existed.
--
-- PRIVACY: family groups and pairs carry PRINCIPAL NAMES — private individuals
-- (owner decision 2026-07-23). These tables live in the `insights` schema and
-- are read only by admin-gated pages. Never expose them through
-- `insights_public`, an export, or a digest.
--
-- A failed derivation writes NOTHING (the job is transactional and skips on a
-- seam outage), so the previous snapshot stands and `derived_at` going stale
-- is the signal — a stale honest number beats a fresh fake zero.

CREATE TABLE IF NOT EXISTS corporate_family_summary (
  -- Single-row table: the CHECK makes "replace the snapshot" an UPSERT on
  -- id = 1 rather than a delete/insert race.
  id integer PRIMARY KEY CHECK (id = 1),
  family_count integer NOT NULL,
  pairs_new integer NOT NULL,
  pairs_strong integer NOT NULL,
  -- FamilyGroup[] — what the families page renders.
  families_json jsonb NOT NULL,
  -- Groups dropped for exceeding MAX_FAMILY_ENTITIES (agent-filter regression
  -- stays visible, never silently truncated).
  dropped_json jsonb NOT NULL,
  -- RegistryIdentityRow[] trimmed to entities the pages display (~3k of 73k).
  rows_json jsonb NOT NULL,
  derived_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS corporate_family_pairs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  verdict text NOT NULL,
  already_bound boolean NOT NULL,
  -- The whole PrincipalPersonPair; verdict/already_bound are extracted for
  -- cheap filtering without opening the blob.
  pair_json jsonb NOT NULL,
  derived_at timestamptz NOT NULL
);
