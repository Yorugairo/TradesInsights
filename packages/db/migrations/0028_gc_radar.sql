-- 0028 — GC Radar (flywheel Phase 2, B1): insights_public.cockpit_orgs_v1.
-- Per-organization dossier rows for the REGISTRY cockpit: org ⋈ cached registry
-- identity snapshot (license identifiers, Google rating/reviews, trade codes)
-- ⋈ permit velocity (12mo / 90d project counts from PUBLIC-source roles) ⋈ the
-- account's own opportunity overlap. Registry identity comes from the snapshot
-- cached at bind time (organizations.registry_identity_json) — the view never
-- reaches into registry_public.*, so the reader role needs zero new grants
-- beyond SELECT on this view.
--
-- PII rules carried verbatim from 0025 (see that header): business-entity name
-- gate (fail closed), public-source roles only, global public-business phone
-- only, ≥2-projects noise floor. Individuals and private-source-only orgs can
-- never appear.

CREATE OR REPLACE VIEW insights_public.cockpit_orgs_v1
  WITH (security_invoker = false) AS
SELECT
  acct.key                                                AS account_key,
  og.id                                                   AS organization_id,
  og.canonical_name                                       AS org_name,
  (og.verified_at IS NOT NULL)                            AS verified,
  (og.registry_ref IS NOT NULL)                           AS registry_linked,
  og.registry_identity_json ->> 'canonical_name'          AS registry_name,
  og.registry_identity_json ->> 'ubi'                     AS ubi,
  og.registry_identity_json -> 'contractor_numbers'       AS contractor_numbers,
  (og.registry_identity_json ->> 'google_rating')::float  AS google_rating,
  (og.registry_identity_json ->> 'google_review_count')::int AS google_review_count,
  og.registry_identity_json -> 'trade_codes'              AS trade_codes,
  (SELECT oc.phone
     FROM insights.organization_contacts oc
    WHERE oc.organization_id = og.id
      AND oc.account_profile_id IS NULL
      AND oc.source_type = 'public_business'
      AND oc.phone IS NOT NULL
    ORDER BY oc.phone
    LIMIT 1)                                              AS phone,
  count(DISTINCT pr.project_id)                           AS projects_total,
  count(DISTINCT pr.project_id) FILTER (
    WHERE pr.last_seen_at >= now() - interval '12 months') AS projects_12m,
  count(DISTINCT pr.project_id) FILTER (
    WHERE pr.last_seen_at >= now() - interval '90 days')   AS projects_90d,
  count(DISTINCT opp.id)                                  AS account_opportunities,
  max(pr.last_seen_at)                                    AS latest_activity_at,
  array_agg(DISTINCT p.county)                            AS counties
FROM insights.account_profiles acct
JOIN insights.project_roles pr
  ON pr.role IN ('applicant', 'owner', 'primary_contractor', 'contractor')
JOIN insights.organizations og ON og.id = pr.organization_id
JOIN insights.source_records psr ON psr.id = pr.source_record_id
JOIN insights.sources ps ON ps.id = psr.source_id AND ps.account_profile_id IS NULL
JOIN insights.projects p ON p.id = pr.project_id
  AND p.permitting_jurisdiction <> 'Test Jurisdiction'
LEFT JOIN insights.opportunities opp ON opp.project_id = pr.project_id
  AND opp.account_profile_id = acct.id
  AND opp.state <> 'archive'
WHERE acct.active = true
  AND og.canonical_name ~* '(LLC|INC|CORP|COMPANY|CO\.|LP|LLP|PLLC|LTD|GROUP|CONSTRUCTION|BUILDERS|HOMES|DEVELOPMENT|ELECTRIC|PLUMBING|MECHANICAL|ROOFING|SERVICES|ENTERPRISES|ASSOCIATES|PARTNERS|CITY OF|COUNTY|DISTRICT|AUTHORITY|CHURCH|SCHOOL)'
  AND og.canonical_name !~* '^(NO |NOT |N/A|NA$|UNKNOWN|NONE|OWNER$|SAME AS|TBD|SEE |APPLICANT$|PER PLANS)'
  AND og.canonical_name !~ '[0-9]{3,}'
GROUP BY acct.key, og.id, og.canonical_name, og.verified_at, og.registry_ref, og.registry_identity_json
HAVING count(DISTINCT pr.project_id) >= 2;

GRANT SELECT ON insights_public.cockpit_orgs_v1 TO insights_cockpit_reader;
