-- Cross-platform identity graph, Phases 0+1 — organization alias capture.
--
-- `organization_aliases` has existed since 0000_init but had NO writer and no
-- unique constraint, so it sat at 0 rows. The resolver collapses name variants
-- of one company onto a single organization ("Southwest Plumbing LLC" and
-- "SW Plumbing") and then DISCARDS the loser, which means the binding matcher
-- only ever sees `organizations.canonical_name` — an org whose canonical name
-- drifted from its L&I registration can never match its registry entity.
--
-- Capturing every name a company was seen under turns each variant into a match
-- key. The resolver re-sees the same name on every republished record, so the
-- write path is INSERT ... ON CONFLICT DO NOTHING and needs this unique index to
-- dedupe on. Deduplication is per (organization, exact raw alias): the same
-- string on one org is one row; the same string on a DIFFERENT org is a
-- legitimately separate observation and is kept.
--
-- IF NOT EXISTS so a re-run against an environment that already has the index
-- is a no-op rather than an error.
CREATE UNIQUE INDEX IF NOT EXISTS organization_aliases_org_alias_ux
  ON organization_aliases (organization_id, alias);
