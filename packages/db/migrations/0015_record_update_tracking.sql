-- Stage-change follow-through: record_resolutions tracks WHICH content
-- version of the record has been applied to the project graph. A record whose
-- source status later changes (Seattle application -> issued permit updates
-- the SAME row) is re-processed by applyRecordUpdates when its
-- normalized_fingerprint no longer matches. NULL means "never reconciled
-- since this column existed" - the first pass sweeps and heals history.
ALTER TABLE record_resolutions ADD COLUMN processed_fingerprint text;
CREATE INDEX record_resolutions_unprocessed_ix
  ON record_resolutions (status)
  WHERE status = 'active';
