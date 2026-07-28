-- Data hygiene round 2, part 2 of 2: cockpit_opportunities_v1 reads
-- organizations.name_quality instead of re-deriving it from two regexes.
--
-- APPLY ORDER MATTERS, AND THIS FILE IS WRITTEN SO IT CANNOT BITE.
-- The intended sequence is 0039 → `pnpm orgs:backfill-quality` → 0040. If 0040
-- lands on a database whose rows are still unstamped, a naive predicate
-- (`name_quality <> 'junk'`) would evaluate to NULL for every organization and
-- silently empty the GC-name column across the whole cockpit. So the predicate
-- below FALLS BACK to the original regexes whenever name_quality IS NULL: an
-- unbackfilled row behaves EXACTLY as it does today, and a stamped row is
-- decided by the column. Ordering becomes a preference, not a hazard.
--
-- THE STRICT SWAP IS DELIBERATELY NOT HERE. The obvious next step — replacing
-- the whole gate with `name_quality = 'business'` — would also drop the entity-
-- token regex, and that is a different, larger decision: 3,528 of 6,220
-- organizations are 'person_or_unknown', so the two predicates are not
-- equivalent and the swap must be argued from a stamped production table, not
-- from a plan. Round 3, once prod has carried the column for a while.
--
-- CREATE OR REPLACE VIEW rules (0026 header): every existing column keeps its
-- name, type and position. This migration changes a WHERE clause only — the
-- SELECT list is byte-identical to 0027, corroboration columns included.
--
-- The three sibling views that carry the same copy-pasted predicate
-- (cockpit_gc_league_v1 from 0025, cockpit_orgs_v1 from 0028) are intentionally
-- untouched this round: one view proves the column in production before the
-- rest follow. Migrations 0025/0028 remain their definition until then.
--> statement-breakpoint
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
  COALESCE(ew.easy_wins ? o.id::text, false) AS is_easy_win,
  -- Corroboration (Phase 1): derived by the maintenance pass; NULL until derived
  -- (never a fabricated count). has_contradiction FALSE means "none detected".
  (p.corroboration ->> 'sourceCount')::int   AS corroborated_source_count,
  (p.corroboration ->> 'stageDepth')::int    AS stage_depth,
  COALESCE(jsonb_array_length(p.corroboration -> 'contradictions') > 0, false) AS has_contradiction
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
    -- Business-entity gate (fail closed; see 0025 header). Unchanged: a GC lead
    -- needs a company to call, so a sole proprietor's own name is excluded here
    -- and nowhere else.
    AND og.canonical_name ~* '(LLC|INC|CORP|COMPANY|CO\.|LP|LLP|PLLC|LTD|GROUP|CONSTRUCTION|BUILDERS|HOMES|DEVELOPMENT|ELECTRIC|PLUMBING|MECHANICAL|ROOFING|SERVICES|ENTERPRISES|ASSOCIATES|PARTNERS|CITY OF|COUNTY|DISTRICT|AUTHORITY|CHURCH|SCHOOL)'
    -- Junk gate, now DATA (0039). The CASE is the safety property described in
    -- this file's header: unstamped rows fall back to the exact predicates they
    -- were filtered by before, so applying this migration ahead of the backfill
    -- changes no row's visibility.
    AND CASE
          WHEN og.name_quality IS NULL THEN
            og.canonical_name !~* '^(NO |NOT |N/A|NA$|UNKNOWN|NONE|OWNER$|SAME AS|TBD|SEE |APPLICANT$|PER PLANS)'
            AND og.canonical_name !~ '[0-9]{3,}'
          ELSE og.name_quality <> 'junk'
        END
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
--> statement-breakpoint
GRANT SELECT ON insights_public.cockpit_opportunities_v1 TO insights_cockpit_reader;
