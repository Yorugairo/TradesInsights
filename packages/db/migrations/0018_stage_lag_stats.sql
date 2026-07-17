-- P3.1 — historical stage-lag statistics ("typically issues in ~N weeks").
-- Recomputed nightly from our own stored records (applicationDate→issueDate
-- pairs stated on the SAME record — never inferred across records). Always
-- surfaced as a labeled inference from historical lags, never a promise.
CREATE TABLE stage_lag_stats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  county text NOT NULL,
  permit_class text NOT NULL,
  from_stage text NOT NULL,
  to_stage text NOT NULL,
  n integer NOT NULL,
  p25_days double precision,
  median_days double precision,
  p75_days double precision,
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (county, permit_class, from_stage, to_stage)
);
