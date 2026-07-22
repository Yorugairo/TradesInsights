-- Flywheel Phase 4 (4B.4 + root-domain enablement) — identifier lanes.
--
-- 1. Admit 'root_domain' as an identifier class: the registered-website root
--    domain, normalized on write (scheme/www/path stripped, platform hosts
--    rejected). Supply side of the binding_domain_match review rule, which
--    reads the registry contract column trades_identity_v1.root_domain.
-- 2. Provenance: identifier rows have so far always carried the source record
--    they came from ("no claim without a source"). Phase 4's accept-side
--    backfeed adds a second legitimate origin — a HUMAN-accepted registry
--    binding stamping the entity's strong keys (UBI / contractor number) onto
--    the org so the nightly strong-key link and WS-B.4 fire for later records.
--    Those rows have no source record; `provenance = 'registry_accept'` says
--    why, and the row CHECK keeps source_record_id mandatory for ordinary
--    source-evidence rows (the invariant is narrowed, not dropped).
ALTER TABLE organization_identifiers
  DROP CONSTRAINT IF EXISTS organization_identifiers_identifier_type_check;
--> statement-breakpoint
ALTER TABLE organization_identifiers
  ADD CONSTRAINT organization_identifiers_identifier_type_check
  CHECK (identifier_type IN ('phone', 'ubi', 'contractor_number', 'email', 'address', 'source_entity_id', 'root_domain'));
--> statement-breakpoint
ALTER TABLE organization_identifiers
  ADD COLUMN IF NOT EXISTS provenance text NOT NULL DEFAULT 'source_evidence';
--> statement-breakpoint
ALTER TABLE organization_identifiers
  DROP CONSTRAINT IF EXISTS organization_identifiers_provenance_check;
--> statement-breakpoint
ALTER TABLE organization_identifiers
  ADD CONSTRAINT organization_identifiers_provenance_check
  CHECK (provenance IN ('source_evidence', 'registry_accept'));
--> statement-breakpoint
ALTER TABLE organization_identifiers
  ALTER COLUMN source_record_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE organization_identifiers
  DROP CONSTRAINT IF EXISTS organization_identifiers_source_evidence_record_check;
--> statement-breakpoint
ALTER TABLE organization_identifiers
  ADD CONSTRAINT organization_identifiers_source_evidence_record_check
  CHECK (provenance <> 'source_evidence' OR source_record_id IS NOT NULL);
