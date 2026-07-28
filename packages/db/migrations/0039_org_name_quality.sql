-- Data hygiene round 2, part 1 of 2: make org-name quality DATA instead of a
-- predicate copied into every view that needs it.
--
-- WHAT WAS WRONG. "Is this string a company" is a business rule with exactly one
-- correct answer, and it existed in five places: the same three regexes appear
-- verbatim in 0025 (twice — cockpit_opportunities_v1 and cockpit_gc_league_v1),
-- 0026, 0027 and 0028, plus a TypeScript transcription in
-- packages/intelligence/src/org-activity.ts. Nothing type-checks a view body, so
-- the four SQL copies could drift silently and no test would notice. Worse, a
-- consumer that simply forgot the predicate silently shipped "SAME AS OWNER" to
-- a customer as a general contractor's name.
--
-- WHAT THIS DOES. `organizations.name_quality` carries the classification,
-- stamped at write time by the resolver (packages/resolution/src/
-- org-name-quality.ts is now the ONLY definition) and backfilled once by
-- `pnpm orgs:backfill-quality`. Consumers read a column.
--
-- NULLABLE ON PURPOSE, AND IT STAYS THAT WAY THIS ROUND. NULL means "not yet
-- classified", which is a true statement about a 6,220-row table the instant
-- this migration lands and before the backfill runs. Migration 0040 is written
-- so a NULL row behaves EXACTLY as it does today; making the column NOT NULL
-- would force a backfill inside the migration and turn an ordering mistake into
-- a data-loss incident instead of a no-op.
--
-- THE THREE TIERS, AND WHY THE MIDDLE ONE EXISTS. Measured against production
-- 2026-07-28: of 6,220 organizations, ~57 are junk placeholders and ~3,528 fail
-- the business-entity gate WITHOUT being junk — sole proprietors and owners who
-- pulled their own permits. Those 3,528 are legitimate rows. Collapsing them
-- into a two-state good/bad column is exactly the mistake this column exists to
-- prevent: 'person_or_unknown' is excluded from a GC-NAME lateral (a lead needs
-- a company to call) and from nothing else.
--
-- NO DELETIONS, EVER. Junk organizations keep their rows and their evidence.
-- This flags; it does not destroy.
--> statement-breakpoint
-- Column and CHECK in ONE statement so re-running is a true no-op: with
-- `ADD COLUMN IF NOT EXISTS`, an existing column skips the constraint too.
-- Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, so splitting them would make
-- the second half fail on any replay.
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "name_quality" text
  CONSTRAINT "organizations_name_quality_ck"
  CHECK ("name_quality" IN ('business', 'person_or_unknown', 'junk'));
--> statement-breakpoint
-- Partial index: the only tier anyone SEARCHES for is the small one. The audit
-- sweep asks "does any junk-named org carry a registry binding or an account
-- relationship" and that question must stay cheap as the table grows; the other
-- two tiers are read per-row through the primary key, never scanned by value.
CREATE INDEX IF NOT EXISTS "organizations_name_quality_junk_ix"
  ON "organizations" ("name_quality")
  WHERE "name_quality" = 'junk';
