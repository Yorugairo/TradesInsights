-- Flywheel Phase 1 (plan: registry-insights-flywheel-phases-1-4):
-- (1) projects.corroboration — derived cross-reference summary (distinct PUBLIC
--     source count, lifecycle stage depth, same-field contradictions) computed by
--     the maintenance-chain corroboration pass. Rebuildable, like development_id.
--     NULL until derived — never a fabricated zero.
-- (2) decision_labels — an append-only label ledger: EVERY human opportunity
--     decision (promote / dismiss / rescore, later pursuit_outcome) recorded with
--     a feature snapshot copied AT DECISION TIME, so §12.3 calibration runs on
--     what the human actually saw, not on later re-derivations.
-- (3) cockpit_opportunities_v1 — append the corroboration columns (CREATE OR
--     REPLACE permits appended columns only; all prior columns keep name/type/
--     position — see 0026 header).
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "corroboration" jsonb;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "decision_labels" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_profile_id" uuid NOT NULL REFERENCES "account_profiles"("id"),
  "opportunity_id" uuid NOT NULL REFERENCES "opportunities"("id"),
  "kind" text NOT NULL CONSTRAINT "decision_labels_kind_ck"
    CHECK ("kind" IN ('promote', 'dismiss', 'rescore', 'pursuit_outcome')),
  "decided_by" text NOT NULL,
  "decided_at" timestamptz NOT NULL DEFAULT now(),
  -- What the human saw when deciding: score, band/state, route, signals,
  -- county, stage, corroboration. Copied jsonb — deliberately denormalized.
  "snapshot" jsonb NOT NULL,
  "reason" text,
  "notes" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decision_labels_account_ix" ON "decision_labels" ("account_profile_id", "decided_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decision_labels_opportunity_ix" ON "decision_labels" ("opportunity_id");
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
--> statement-breakpoint
GRANT SELECT ON insights_public.cockpit_opportunities_v1 TO insights_cockpit_reader;
