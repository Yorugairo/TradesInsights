-- Part E co-location — move every Insights table from public → insights.
-- (otn-trades-cockpit-insights-colocation plan, WS-1 Task 2)
--
-- This is ENVIRONMENT SURGERY, not a numbered drizzle migration: the local
-- Docker DB runs it once before the hosted cutover; the hosted DB never needs
-- it (fresh provision creates tables inside `insights` directly because the
-- connection contract puts `insights` first in search_path). Idempotent: every
-- ALTER is guarded by to_regclass, so re-runs — and accidental runs against an
-- already-provisioned hosted DB — no-op.
--
-- Table census (47) generated mechanically:
--   * 46 pgTable declarations in packages/db/src/schema.ts (declaration order)
--   * stage_lag_stats — raw SQL, packages/db/migrations/0018_stage_lag_stats.sql
-- Sequences, indexes, PKs, and FKs follow their tables automatically.
-- The `pgboss` and `drizzle` schemas are deliberately untouched (pg-boss
-- self-manages; the drizzle journal keeps recording in
-- drizzle.__drizzle_migrations). No views exist locally to move.
--
-- Usage (local Docker):
--   docker exec -i <postgres-container> psql -U otn -d otn -v ON_ERROR_STOP=1 \
--     < scripts/migrate-to-insights-schema.sql

CREATE SCHEMA IF NOT EXISTS insights;

DO $$
DECLARE
  tbl text;
  moved int := 0;
  skipped int := 0;
  tables text[] := ARRAY[
    -- packages/db/src/schema.ts (46, declaration order)
    'sources',
    'source_runs',
    'raw_artifacts',
    'source_records',
    'evidence_items',
    'developments',
    'projects',
    'action_tokens',
    'project_external_ids',
    'project_events',
    'organizations',
    'organization_aliases',
    'project_roles',
    'account_profiles',
    'account_rules',
    'account_capacity_snapshots',
    'opportunities',
    'opportunity_evidence',
    'opportunity_decision_memos',
    'feedback',
    'pursuits',
    'pursuit_transitions',
    'pursuit_tasks',
    'pursuit_notes',
    'inbound_messages',
    'bid_invitations',
    'bid_invitation_events',
    'bid_documents',
    'account_organization_relationships',
    'organization_contacts',
    'relationship_interactions',
    'opportunity_outcomes',
    'roi_events',
    'research_time_entries',
    'account_suppressions',
    'claim_corrections',
    'deliveries',
    'delivery_items',
    'coverage_entries',
    'record_resolutions',
    'resolution_reviews',
    'artifact_access_log',
    'alerts',
    'organization_identifiers',
    'registry_observations',
    'model_runs',
    -- raw-SQL migrations outside schema.ts (1)
    'stage_lag_stats'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    IF to_regclass('public.' || tbl) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I SET SCHEMA insights', tbl);
      moved := moved + 1;
    ELSE
      skipped := skipped + 1;
    END IF;
  END LOOP;
  RAISE NOTICE 'migrate-to-insights-schema: moved=% already-moved-or-absent=%', moved, skipped;
END $$;

-- Post-condition: the full census must now live in `insights`. Fails loudly on
-- a census drift or a run against the wrong database. (>= because later
-- migrations may add tables beyond the 47 this script knows about.)
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n
    FROM information_schema.tables
   WHERE table_schema = 'insights' AND table_type = 'BASE TABLE';
  IF n < 47 THEN
    RAISE EXCEPTION 'expected >= 47 base tables in schema insights, found %', n;
  END IF;
  RAISE NOTICE 'migrate-to-insights-schema: post-condition OK (% base tables in insights)', n;
END $$;
