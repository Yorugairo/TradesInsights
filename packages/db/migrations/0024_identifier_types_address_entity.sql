-- Widen organization_identifiers.identifier_type to admit two additive classes
-- harvested from PUBLIC source evidence:
--   'address'          normalized postal (mailing/business) address — a match
--                      key against the registry's L&I registered address, and
--                      the only identifier available for no-phone parties
--                      (owners, developers).
--   'source_entity_id' a source-namespaced entity id (e.g. "pierce_pals:462942"
--                      from PALS' applCustSysId) — exact same-source clustering,
--                      immune to name-string drift.
-- Storage, evidence linkage, and uniqueness are unchanged; only the CHECK set
-- grows. Idempotent: drop-if-exists then re-add.
ALTER TABLE organization_identifiers
  DROP CONSTRAINT IF EXISTS organization_identifiers_identifier_type_check;
ALTER TABLE organization_identifiers
  ADD CONSTRAINT organization_identifiers_identifier_type_check
  CHECK (identifier_type IN ('phone', 'ubi', 'contractor_number', 'email', 'address', 'source_entity_id'));
