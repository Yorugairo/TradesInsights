-- P1.4 — join point for the customer's One Trade Network registry database.
-- Populated ONLY by a future authorized import (never scraped); upgrades
-- name-matched organizations to verified contractor identities. All P1
-- features function without it. (ubi / contractor_registration exist since M0.)
ALTER TABLE organizations ADD COLUMN registry_ref text;
CREATE INDEX organizations_registry_ref_ix ON organizations (registry_ref)
  WHERE registry_ref IS NOT NULL;
