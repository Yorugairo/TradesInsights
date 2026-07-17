-- #3 geometry provenance. projects.geometry may now come from two places:
-- a resolved record's own geometry ('source_record') or the US Census
-- geocoder ('census_geocoder' — an INFERENCE from the address, never allowed
-- to overwrite record geometry). geocode_meta_json records the full geocode
-- attempt (matched address, match type, benchmark/vintage, county check, or
-- the no-match/ambiguous outcome so reruns skip already-attempted projects).
ALTER TABLE projects ADD COLUMN geometry_source text;
ALTER TABLE projects ADD COLUMN geocode_meta_json jsonb;
-- Existing geometry (if any) predates the geocoder and can only have come
-- from a record.
UPDATE projects SET geometry_source = 'source_record' WHERE geometry IS NOT NULL;
