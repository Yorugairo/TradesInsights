-- Brand-vs-enterprise identity — pin the operating brand an org resolves to.
--
-- `registry_ref` points at a LEGAL ENTITY (a UBI). One entity routinely trades
-- under several separately-marketed brands, each with its OWN L&I contractor
-- licence: UBI 600443607 holds APOLLHC867J1 (Apollo Heating & A/C),
-- APOLLMC795NR (Apollo Mechanical Contractors) and APOLLSM006J6 (Apollo Sheet
-- Metal Inc).
--
-- Insights models the operating brand — that is what a permit names and who you
-- actually call — so several org rows may legitimately share one `registry_ref`.
-- This column records WHICH brand each one is, so that:
--   * the accept-side backfeed stamps only that brand's licence instead of the
--     entity's whole licence array (which fused distinct brands into one org via
--     the resolver's strong-key collapse), and
--   * two spelling variants of the SAME brand still collapse, because they
--     resolve to the same licence.
--
-- The licence is the natural key here, not a surrogate: it is what L&I issues
-- per brand and what the strong-key collapse already matches on.
--
-- NULLABLE ON PURPOSE: a binding made at enterprise level (UBI strong-key match
-- with no name hit) has no known brand. Unknown stays null — inferring one would
-- silently fuse two brands.
--
-- Additive and idempotent (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT
-- EXISTS). No backfill: rows bound before this ships keep the licences they
-- already hold; this governs future accepts.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS registry_brand_ref text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS organizations_registry_brand_ref_ix
  ON organizations (registry_brand_ref);
