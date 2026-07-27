-- Data quality, Phase 1 — give `project_events` the UNIQUE index its writer
-- needs, and remove the duplicates written while it had none.
--
-- `emitEvent` (packages/resolution/src/resolver.ts) is a bare INSERT. The table
-- has carried only two NON-unique indexes since 0000_init
-- (`project_events_project_ix`, `project_events_type_ix`), so nothing has ever
-- stopped the same event being written twice. Measured live 2026-07-27:
--
--   total rows                                            44,111
--   surplus on (project, record, type, event_date)          2,997   (6.8%)
--   surplus on that key PLUS observed_at                    2,861
--
-- THE DIFFERENCE OF 136 IS THE WHOLE DESIGN OF THIS INDEX. `observed_at` MUST
-- be in the key. `applyRecordUpdates` legitimately re-emits an event for a
-- record whose content drifted — a Seattle application becoming an issued
-- permit on the same row — and that second write is a real stage change with a
-- later `observed_at`. Key on the four columns alone and those 136 rows are
-- destroyed as if they were duplicates; key on five and they survive, while the
-- 2,861 same-instant repeats collapse. Every one of the 2,861 groups holds
-- exactly two rows (groups = surplus), and 2,661 of them are byte-identical
-- down to `prior_stage` / `resulting_stage` / `material_change`.
--
-- `event_date` is NULLABLE (383 rows) and Postgres treats NULLs as distinct in a
-- unique index by default, which would let those rows duplicate freely. Hence
-- NULLS NOT DISTINCT — available from PG 15; local dev is 16.4 and production
-- is 17.6, both verified before writing this.
--
-- Pairing note: this migration and the `.onConflictDoNothing()` on `emitEvent`
-- ship together and neither is complete alone. The clause without the index
-- fails outright ("no unique or exclusion constraint matching the ON CONFLICT
-- specification"); the index without the clause turns a duplicate write from a
-- silent extra row into a raised error. Together they also make `emitEvent`
-- idempotent, which removes the reason `resolveRecord` could not be retried
-- after a partial write.

-- Keep the lowest `id` in each group. The choice is arbitrary — `id` is a random
-- uuid — but harmless: the rows are byte-identical in 2,661 of the 2,861 groups,
-- and in the remainder they differ only in stage fields, where the first write
-- is the correct one.
DELETE FROM project_events pe
USING (
  SELECT id,
         row_number() OVER (
           PARTITION BY project_id, source_record_id, event_type, event_date, observed_at
           ORDER BY id
         ) AS rn
  FROM project_events
) d
WHERE pe.id = d.id
  AND d.rn > 1;

-- IF NOT EXISTS so a re-run against an environment that already has the index is
-- a no-op rather than an error.
CREATE UNIQUE INDEX IF NOT EXISTS project_events_dedupe_ux
  ON project_events (project_id, source_record_id, event_type, event_date, observed_at)
  NULLS NOT DISTINCT;
