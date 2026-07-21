-- Easy-win parity (follow-up to 0025): surface the digest's OWN easy-win
-- determination in the cockpit, without re-deriving it.
--
-- The weekly digest computes easy wins (geo proximity bands × the account's
-- easy_win config, packages/delivery/src/digest.ts) and — as of the paired
-- deliver.ts change — persists the chosen opportunity ids in
-- deliveries.metadata_json->'easyWins'. This replaces cockpit_opportunities_v1
-- to add `is_easy_win`, computed by membership in the LATEST weekly delivery's
-- stored list. The email and the cockpit therefore agree BY CONSTRUCTION (one
-- source of truth); the view never forks the geo math. Between digests the flag
-- reflects the last delivery — the same easy wins the customer was last shown.
--
-- CREATE OR REPLACE appends `is_easy_win` at the end of the column list (the
-- only shape CREATE OR REPLACE VIEW permits); every prior column keeps its
-- name, type, and position.

CREATE OR REPLACE VIEW insights_public.cockpit_opportunities_v1
  WITH (security_invoker = false) AS
SELECT
  a.key                      AS account_key,
  o.id                       AS opportunity_id,
  o.project_id,
  p.canonical_name           AS project_name,
  p.county,
  p.permitting_jurisdiction,
  p.city,
  p.current_stage            AS stage,
  o.state,
  o.route,
  o.current_score            AS score,
  o.score_version,
  rec.max_valuation,
  o.first_qualified_at,
  o.last_material_change_at,
  gc.gc_name,
  gc.gc_verified,
  gc.gc_phone,
  COALESCE(ew.easy_wins ? o.id::text, false) AS is_easy_win
FROM insights.opportunities o
JOIN insights.account_profiles a ON a.id = o.account_profile_id AND a.active = true
JOIN insights.projects p ON p.id = o.project_id
LEFT JOIN LATERAL (
  -- Stated valuation from ACTIVE resolutions of PUBLIC sources only.
  SELECT max((sr.normalized_json ->> 'valuationUsd')::numeric)::float AS max_valuation
  FROM insights.record_resolutions rr
  JOIN insights.source_records sr ON sr.id = rr.source_record_id
  JOIN insights.sources s ON s.id = sr.source_id AND s.account_profile_id IS NULL
  WHERE rr.project_id = p.id AND rr.status = 'active'
) rec ON true
LEFT JOIN LATERAL (
  SELECT
    og.canonical_name              AS gc_name,
    (og.verified_at IS NOT NULL)   AS gc_verified,
    (SELECT oc.phone
       FROM insights.organization_contacts oc
      WHERE oc.organization_id = og.id
        AND oc.account_profile_id IS NULL
        AND oc.source_type = 'public_business'
        AND oc.phone IS NOT NULL
      ORDER BY oc.phone
      LIMIT 1)                     AS gc_phone
  FROM insights.project_roles pr
  JOIN insights.organizations og ON og.id = pr.organization_id
  JOIN insights.source_records psr ON psr.id = pr.source_record_id
  JOIN insights.sources ps ON ps.id = psr.source_id AND ps.account_profile_id IS NULL
  WHERE pr.project_id = p.id
    AND pr.role IN ('primary_contractor', 'applicant', 'owner')
    -- Business-entity gate (fail closed; see 0025 header).
    AND og.canonical_name ~* '(LLC|INC|CORP|COMPANY|CO\.|LP|LLP|PLLC|LTD|GROUP|CONSTRUCTION|BUILDERS|HOMES|DEVELOPMENT|ELECTRIC|PLUMBING|MECHANICAL|ROOFING|SERVICES|ENTERPRISES|ASSOCIATES|PARTNERS|CITY OF|COUNTY|DISTRICT|AUTHORITY|CHURCH|SCHOOL)'
    AND og.canonical_name !~* '^(NO |NOT |N/A|NA$|UNKNOWN|NONE|OWNER$|SAME AS|TBD|SEE |APPLICANT$|PER PLANS)'
    AND og.canonical_name !~ '[0-9]{3,}'
  ORDER BY CASE pr.role
      WHEN 'primary_contractor' THEN 1
      WHEN 'applicant' THEN 2
      ELSE 3 END,
    og.canonical_name
  LIMIT 1
) gc ON true
LEFT JOIN LATERAL (
  -- Easy-win membership as computed + persisted by the LATEST weekly digest.
  SELECT d.metadata_json -> 'easyWins' AS easy_wins
  FROM insights.deliveries d
  WHERE d.account_profile_id = o.account_profile_id
    AND d.delivery_type = 'weekly_digest'
  ORDER BY d.period_end DESC, d.sent_at DESC NULLS LAST
  LIMIT 1
) ew ON true
WHERE o.state <> 'archive'
  -- The opportunity must be grounded in at least one active PUBLIC-source
  -- resolution (a project known only through private material never surfaces).
  AND EXISTS (
    SELECT 1
    FROM insights.record_resolutions rr2
    JOIN insights.source_records sr2 ON sr2.id = rr2.source_record_id
    JOIN insights.sources s2 ON s2.id = sr2.source_id
    WHERE rr2.project_id = p.id
      AND rr2.status = 'active'
      AND s2.account_profile_id IS NULL
  );

-- The reader's SELECT grant on the view survives CREATE OR REPLACE; re-assert
-- for clarity/idempotency.
GRANT SELECT ON insights_public.cockpit_opportunities_v1 TO insights_cockpit_reader;
