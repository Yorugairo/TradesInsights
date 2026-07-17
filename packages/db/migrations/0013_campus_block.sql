-- #1 campus surfacing: derived campus membership on projects. Stamped and
-- cleared by computeCampusVelocity (packages/resolution/src/velocity.ts) —
-- a rebuildable derived layer like development_id, never source data.
-- Format: '<county>:<parcel-block-prefix>', e.g. 'King:720232'.
ALTER TABLE projects ADD COLUMN campus_block text;
CREATE INDEX projects_campus_block_ix ON projects (campus_block) WHERE campus_block IS NOT NULL;
