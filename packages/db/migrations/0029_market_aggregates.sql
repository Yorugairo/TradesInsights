-- 0029 — Market aggregates (flywheel Phase 3, C1/C2).
--
-- projects.trade_codes: DERIVED per-project trade tags from the SHARED registry
-- vocabulary (registry_public.trades_taxonomy_v1) matched over PUBLIC records'
-- permitType ONLY (packages/resolution/src/project-trades.ts — description
-- mentions are excluded so a GC's building permit never counts as finish-trade
-- demand). Reset-then-derived nightly; NULL = no authoritative match, never 0.
--
-- Two public aggregate views for the registry's market pages (pSEO) and the
-- claimed-tenant teaser. Small-n rules (Registry Score sample-gate precedent):
--   market_demand_v1  — a county×trade combo must carry ≥5 projects across the
--     window before ANY of its monthly rows serve (combo-level gate; monthly
--     rows within a qualifying combo are served so the trend line is honest).
--   market_permit_speed_v1 — a jurisdiction needs ≥5 complete
--     application→issue samples before its median serves.
-- Consumers must disclose the basis ("based on permit volume via OTN Insights")
-- — the registry pSEO gate pins that copy.

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "trade_codes" jsonb;

CREATE OR REPLACE VIEW insights_public.market_demand_v1
  WITH (security_invoker = false) AS
WITH tagged AS (
  SELECT p.id, p.county, t.code AS trade_code,
    date_trunc('month', p.first_seen_at)::date AS month
  FROM insights.projects p
  CROSS JOIN LATERAL jsonb_array_elements_text(p.trade_codes) AS t(code)
  WHERE p.trade_codes IS NOT NULL
    AND p.county IS NOT NULL
    AND p.permitting_jurisdiction <> 'Test Jurisdiction'
),
combo AS (
  SELECT county, trade_code
  FROM tagged
  GROUP BY county, trade_code
  HAVING count(DISTINCT id) >= 5
)
SELECT tg.county, tg.trade_code, tg.month, count(DISTINCT tg.id) AS projects
FROM tagged tg
JOIN combo c ON c.county = tg.county AND c.trade_code = tg.trade_code
GROUP BY tg.county, tg.trade_code, tg.month;

CREATE OR REPLACE VIEW insights_public.market_permit_speed_v1
  WITH (security_invoker = false) AS
WITH samples AS (
  SELECT p.id, p.permitting_jurisdiction, p.county,
    (SELECT min(e.observed_at) FROM insights.project_events e
      WHERE e.project_id = p.id AND e.confirmed AND e.resulting_stage = 'permit_applied') AS applied_at,
    (SELECT min(e.observed_at) FROM insights.project_events e
      WHERE e.project_id = p.id AND e.confirmed AND e.resulting_stage = 'permit_issued') AS issued_at
  FROM insights.projects p
  WHERE p.permitting_jurisdiction <> 'Test Jurisdiction'
)
SELECT permitting_jurisdiction, county,
  count(*) AS samples,
  percentile_cont(0.5) WITHIN GROUP (
    ORDER BY extract(epoch FROM issued_at - applied_at) / 86400.0)::float AS median_days_to_issue
FROM samples
WHERE applied_at IS NOT NULL AND issued_at IS NOT NULL AND issued_at > applied_at
GROUP BY permitting_jurisdiction, county
HAVING count(*) >= 5;

GRANT SELECT ON insights_public.market_demand_v1 TO insights_cockpit_reader;
GRANT SELECT ON insights_public.market_permit_speed_v1 TO insights_cockpit_reader;
