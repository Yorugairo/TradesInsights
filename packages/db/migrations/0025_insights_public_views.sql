-- insights_public — the cockpit contract surface (Part E co-location, WS-3).
-- The mirror image of the registry's registry_public seam: the deployed One
-- Trade Network cockpit reads THESE five read-only, account-keyed views and
-- never touches insights.* base tables. All views are definer-style
-- (security_invoker = false) and explicitly schema-qualified.
--
-- PII hard rules enforced here (carried from seam governance + spec §20):
--   * Account-private sources (insights.sources.account_profile_id IS NOT NULL
--     — customer bid inboxes) NEVER feed a view: valuations, roles, and league
--     rollups all join through sources and require account_profile_id IS NULL.
--     (bid_invitations / inbound_messages / bid_documents appear in NO view —
--     their §20 access-audit requirement cannot be met by a view.)
--   * Homeowner / individual names never surface: GC + league rows require an
--     entity token in the name (conservative SQL port of
--     packages/intelligence/src/org-activity.ts looksLikeEntity — the ≥4-token
--     arm is deliberately DROPPED because without splitOrgNameAddress a fused
--     "PERSON NAME 123 MAIN ST" would pass it), exclude placeholder names, and
--     exclude names carrying 3+ consecutive digits (address-in-name tell).
--     Failing closed drops some legitimate businesses from cockpit intel; that
--     is the intended trade.
--   * Contact data is the GLOBAL public-business phone only
--     (organization_contacts.account_profile_id IS NULL AND source_type =
--     'public_business') — customer-supplied contacts stay out.
--   * county + permitting_jurisdiction stay present on every opportunity row.
--
-- Deviation of record (plan Task 8): no easy_win flag / bid-window note columns.
-- Both are digest-computed (geo radius + account easy_win config / stage-lag
-- narrative in packages/delivery) and are NOT stored per-opportunity; a SQL
-- re-derivation would fork that logic and could contradict the email. The
-- digest view instead DISCLOSES stored counts (items, review queue, suppressed)
-- from deliveries.metadata_json — withheld is disclosed, never hidden.

CREATE SCHEMA IF NOT EXISTS insights_public;

-- Least-privilege reader (NOLOGIN; login roles are granted INTO it hosted-side).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'insights_cockpit_reader') THEN
    CREATE ROLE insights_cockpit_reader NOLOGIN;
  END IF;
END $$;

-- 1) Account meta: identity, digest thresholds, band counts, latest movement.
CREATE OR REPLACE VIEW insights_public.cockpit_account_v1
  WITH (security_invoker = false) AS
SELECT
  a.key  AS account_key,
  a.name AS account_name,
  (a.delivery_config_json ->> 'priority_review_min')::float AS priority_review_min,
  (a.delivery_config_json ->> 'weekly_digest_min')::float   AS weekly_digest_min,
  count(o.id) FILTER (WHERE o.state <> 'archive')           AS opportunities_active,
  count(o.id) FILTER (WHERE o.state = 'priority_review')    AS opportunities_priority,
  count(o.id) FILTER (WHERE o.state = 'promoted')           AS opportunities_promoted,
  count(o.id) FILTER (WHERE o.state = 'new')                AS opportunities_new,
  count(o.id) FILTER (WHERE o.state = 'dismissed')          AS opportunities_dismissed,
  max(o.last_material_change_at)                            AS last_scored_at
FROM insights.account_profiles a
LEFT JOIN insights.opportunities o ON o.account_profile_id = a.id
WHERE a.active = true
GROUP BY a.id, a.key, a.name, a.delivery_config_json;

-- 2) Opportunities: the listOpportunities join (apps/web/lib/queries.ts) plus
--    the digest's strongest-role GC pick (packages/delivery/src/digest.ts
--    generalContractor: primary_contractor > applicant > owner, verified =
--    organizations.verified_at, global public-business phone) under the PII
--    guards above. Archive rows are excluded (cockpit v1 shows live bands).
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
  gc.gc_phone
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
    -- Business-entity gate (fail closed; see header).
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

-- 3) Digest status: the latest delivery per account with DISCLOSED withheld
--    counts (mirrors packages/delivery/src/deliver.ts metadata_json shape:
--    suppressed {gateFailed, blockedOnVerifier, customerSuppressed},
--    candidateCount, items[], reviewQueue[]).
CREATE OR REPLACE VIEW insights_public.cockpit_digest_status_v1
  WITH (security_invoker = false) AS
SELECT DISTINCT ON (a.key)
  a.key            AS account_key,
  d.delivery_type,
  d.status,
  d.period_start,
  d.period_end,
  d.sent_at,
  jsonb_array_length(COALESCE(d.metadata_json -> 'items', '[]'::jsonb))       AS item_count,
  jsonb_array_length(COALESCE(d.metadata_json -> 'reviewQueue', '[]'::jsonb)) AS review_queue_count,
  COALESCE((d.metadata_json -> 'suppressed' ->> 'gateFailed')::int, 0)        AS suppressed_gate_failed,
  COALESCE((d.metadata_json -> 'suppressed' ->> 'blockedOnVerifier')::int, 0) AS suppressed_blocked_on_verifier,
  COALESCE((d.metadata_json -> 'suppressed' ->> 'customerSuppressed')::int, 0) AS suppressed_customer,
  (d.metadata_json ->> 'candidateCount')::int                                 AS candidate_count
FROM insights.deliveries d
JOIN insights.account_profiles a ON a.id = d.account_profile_id AND a.active = true
ORDER BY a.key, d.period_end DESC, d.sent_at DESC NULLS LAST;

-- 4) Pursuits board summary (the account's own workflow rows).
CREATE OR REPLACE VIEW insights_public.cockpit_pursuits_v1
  WITH (security_invoker = false) AS
SELECT
  a.key              AS account_key,
  pu.id              AS pursuit_id,
  pu.opportunity_id,
  p.canonical_name   AS project_name,
  p.county,
  pu.state,
  pu.priority,
  pu.estimated_contract_value,
  pu.next_action_at,
  pu.opened_at,
  pu.closed_at,
  pu.updated_at
FROM insights.pursuits pu
JOIN insights.account_profiles a ON a.id = pu.account_profile_id AND a.active = true
JOIN insights.opportunities o ON o.id = pu.opportunity_id
JOIN insights.projects p ON p.id = o.project_id;

-- 5) GC league: per-organization rollup (conservative SQL port of
--    packages/intelligence/src/org-activity.ts — variant grouping by
--    orgNameKey/splitOrgNameAddress stays TS-side; ungrouped rows may
--    undercount a business split across name variants, never overexpose).
--    Business orgs only; public-source roles only; ≥2 projects noise floor.
CREATE OR REPLACE VIEW insights_public.cockpit_gc_league_v1
  WITH (security_invoker = false) AS
WITH proj_val AS (
  SELECT rr.project_id, max((sr.normalized_json ->> 'valuationUsd')::numeric) AS v
  FROM insights.record_resolutions rr
  JOIN insights.source_records sr ON sr.id = rr.source_record_id
  JOIN insights.sources s ON s.id = sr.source_id AND s.account_profile_id IS NULL
  WHERE rr.status = 'active' AND sr.normalized_json ->> 'valuationUsd' IS NOT NULL
  GROUP BY rr.project_id
)
SELECT
  acct.key AS account_key,
  og.canonical_name AS gc_name,
  (og.verified_at IS NOT NULL) AS verified,
  (SELECT oc.phone
     FROM insights.organization_contacts oc
    WHERE oc.organization_id = og.id
      AND oc.account_profile_id IS NULL
      AND oc.source_type = 'public_business'
      AND oc.phone IS NOT NULL
    ORDER BY oc.phone
    LIMIT 1) AS phone,
  (og.registry_identity_json ->> 'google_rating')::float AS rating,
  count(DISTINCT pr.project_id) AS projects,
  count(DISTINCT pr.project_id) FILTER (
    WHERE pr.last_seen_at >= now() - interval '90 days') AS projects_90d,
  count(DISTINCT opp.project_id) AS relevant_projects,
  sum(pv.v)::float AS stated_valuation_total,
  max(pv.v)::float AS stated_valuation_max,
  max(pr.last_seen_at) AS latest_activity_at
FROM insights.account_profiles acct
JOIN insights.project_roles pr
  ON pr.role IN ('applicant', 'owner', 'primary_contractor', 'contractor')
JOIN insights.organizations og ON og.id = pr.organization_id
JOIN insights.source_records psr ON psr.id = pr.source_record_id
JOIN insights.sources ps ON ps.id = psr.source_id AND ps.account_profile_id IS NULL
JOIN insights.projects p ON p.id = pr.project_id
  AND p.permitting_jurisdiction <> 'Test Jurisdiction'
LEFT JOIN proj_val pv ON pv.project_id = pr.project_id
LEFT JOIN insights.opportunities opp ON opp.project_id = pr.project_id
  AND opp.account_profile_id = acct.id
  AND opp.state <> 'archive'
WHERE acct.active = true
  AND og.canonical_name ~* '(LLC|INC|CORP|COMPANY|CO\.|LP|LLP|PLLC|LTD|GROUP|CONSTRUCTION|BUILDERS|HOMES|DEVELOPMENT|ELECTRIC|PLUMBING|MECHANICAL|ROOFING|SERVICES|ENTERPRISES|ASSOCIATES|PARTNERS|CITY OF|COUNTY|DISTRICT|AUTHORITY|CHURCH|SCHOOL)'
  AND og.canonical_name !~* '^(NO |NOT |N/A|NA$|UNKNOWN|NONE|OWNER$|SAME AS|TBD|SEE |APPLICANT$|PER PLANS)'
  AND og.canonical_name !~ '[0-9]{3,}'
GROUP BY acct.key, og.id, og.canonical_name, og.verified_at, og.registry_identity_json
HAVING count(DISTINCT pr.project_id) >= 2;

-- Grants: the reader sees exactly the five views — nothing else.
GRANT USAGE ON SCHEMA insights_public TO insights_cockpit_reader;
GRANT SELECT ON
  insights_public.cockpit_account_v1,
  insights_public.cockpit_opportunities_v1,
  insights_public.cockpit_digest_status_v1,
  insights_public.cockpit_pursuits_v1,
  insights_public.cockpit_gc_league_v1
TO insights_cockpit_reader;
