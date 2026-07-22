/**
 * Project trade derivation (flywheel Phase 3, C1) — stamp each project with the
 * trade codes its PUBLIC permit records evidence, using the SHARED registry
 * trade vocabulary (registry_public.trades_taxonomy_v1) via the same matcher
 * the observation loop uses. permitType matches ONLY — a permit's type IS its
 * trade; title/description mentions are org-evidence at best and are excluded
 * here so market aggregates never count a GC's building permit as drywall
 * demand. Skip-safe: with no taxonomy the caller passes the built-in fallback
 * matcher, byte-identical vocabulary semantics to the observation loop.
 *
 * Derived, idempotent, reset-then-derive (mirrors corroboration.ts): matching
 * happens in TS over the DISTINCT permitType strings (few hundred), then one
 * set-based UPDATE applies the mapping — no per-project round-trips.
 */
import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";
import type { TradeMatcher } from "./trade-taxonomy.js";

export interface ProjectTradesSummary {
  distinctPermitTypes: number;
  permitTypesMatched: number;
  projectsTagged: number;
}

export async function deriveProjectTrades(
  db: Db,
  matcher: TradeMatcher,
  opts: { logger?: { info: (obj: unknown, msg?: string) => void } } = {},
): Promise<ProjectTradesSummary> {
  const typesRes = await db.execute(sql`
    SELECT DISTINCT upper(sr.normalized_json ->> 'permitType') AS permit_type
    FROM record_resolutions rr
    JOIN source_records sr ON sr.id = rr.source_record_id
    JOIN sources s ON s.id = sr.source_id AND s.account_profile_id IS NULL
    WHERE rr.status = 'active' AND sr.normalized_json ->> 'permitType' IS NOT NULL`);

  const mapping: Record<string, string[]> = {};
  let matched = 0;
  for (const r of typesRes.rows as { permit_type: string }[]) {
    const codes = matcher.match(r.permit_type);
    if (codes.length === 0) continue;
    mapping[r.permit_type] = codes;
    matched += 1;
  }

  // Reset-then-derive: projects whose records no longer match carry no stale tags.
  await db.execute(sql`UPDATE projects SET trade_codes = NULL WHERE trade_codes IS NOT NULL`);

  let projectsTagged = 0;
  if (matched > 0) {
    const res = await db.execute(sql`
      WITH mapping AS (
        SELECT key AS permit_type, value AS codes
        FROM jsonb_each(${JSON.stringify(mapping)}::jsonb)
      ),
      proj AS (
        SELECT rr.project_id, jsonb_agg(DISTINCT c.code) AS codes
        FROM record_resolutions rr
        JOIN source_records sr ON sr.id = rr.source_record_id
        JOIN sources s ON s.id = sr.source_id AND s.account_profile_id IS NULL
        JOIN mapping m ON m.permit_type = upper(sr.normalized_json ->> 'permitType')
        CROSS JOIN LATERAL jsonb_array_elements_text(m.codes) AS c(code)
        WHERE rr.status = 'active'
        GROUP BY rr.project_id
      )
      UPDATE projects p
      SET trade_codes = proj.codes
      FROM proj
      WHERE p.id = proj.project_id`);
    projectsTagged = res.rowCount ?? 0;
  }

  const summary: ProjectTradesSummary = {
    distinctPermitTypes: typesRes.rows.length,
    permitTypesMatched: matched,
    projectsTagged,
  };
  opts.logger?.info(summary, "project trades derived");
  return summary;
}
