-- Registry integration (docs/integration-one-trade-network.md Part I):
-- public-business contact rows (e.g. phone/website adopted from the One Trade
-- Network registry / Google profile) are GLOBAL facts, not account-scoped —
-- every paying account may see them in the login-locked CRM. Customer-supplied
-- contacts remain account-scoped: NULL account_profile_id is allowed ONLY for
-- source_type = 'public_business', enforced in the DB, not just app code.
ALTER TABLE organization_contacts ALTER COLUMN account_profile_id DROP NOT NULL;
ALTER TABLE organization_contacts ADD CONSTRAINT organization_contacts_account_scope_check
  CHECK (account_profile_id IS NOT NULL OR source_type = 'public_business');
