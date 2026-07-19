-- Integration seam (One Trade Network) — provenance for the registry_ref binding.
-- registry_ref (migration 0016) records WHICH canonical registry entity an
-- organization resolved to; these two columns record HOW and WHEN, so a binding
-- is auditable and re-runnable (spec §10 "record resolver version/features/score").
-- Only strong-identifier exact matches (ubi / contractor_number) auto-bind; the
-- method is stored so a future review path can distinguish auto from human.
ALTER TABLE organizations ADD COLUMN registry_ref_method text;
ALTER TABLE organizations ADD COLUMN registry_linked_at timestamptz;
