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

/** One unmatched permit type and how many projects carry it. */
export interface UnmatchedPermitType {
  permitType: string;
  projects: number;
}

/** Top-N size for the residue report — enough to see the shape, short enough to log. */
const TOP_UNMATCHED = 15;

export interface ProjectTradesSummary {
  distinctPermitTypes: number;
  permitTypesMatched: number;
  projectsTagged: number;
  /**
   * The permit types this run saw and could not map, largest first.
   *
   * REPORTING ONLY — nothing here changes what gets tagged. It exists because
   * "83% of projects have no trade_codes" is unreadable as a metric: measured
   * 2026-07-28, that 13,537 decomposes into 3,126 projects with no public
   * permit type at all and ~12,470 whose types are `BUILDING`, `RIGHT-OF-WAY`,
   * `NEW STRUCTURE`, `REMODEL` and letter codes like `BF`/`BK` — generic
   * classes carrying NO trade signal. The number is mostly legitimate.
   *
   * Reading this list as a to-do would be the mistake: teaching the matcher
   * that `BUILDING` means drywall would poison every market aggregate. What it
   * is for is spotting the day a real trade vocabulary starts arriving unmapped
   * — and for ranking the cryptic codes worth decoding against an official
   * jurisdiction domain table (never by guessing).
   */
  topUnmatched: UnmatchedPermitType[];
  /**
   * Projects with no public permit type on ANY active public-source resolution.
   * Untaggable by construction, not by failure — the denominator that makes the
   * NULL count honest.
   */
  untaggableProjects: number;
}

export async function deriveProjectTrades(
  db: Db,
  matcher: TradeMatcher,
  opts: { logger?: { info: (obj: unknown, msg?: string) => void } } = {},
): Promise<ProjectTradesSummary> {
  // GROUP BY, not DISTINCT: the same scan now also carries how many projects
  // each type covers, which is what makes the unmatched residue rankable. The
  // matching loop below reads only `permit_type`, exactly as before.
  const typesRes = await db.execute(sql`
    SELECT upper(sr.normalized_json ->> 'permitType') AS permit_type,
           count(DISTINCT rr.project_id)::int AS projects
    FROM record_resolutions rr
    JOIN source_records sr ON sr.id = rr.source_record_id
    JOIN sources s ON s.id = sr.source_id AND s.account_profile_id IS NULL
    WHERE rr.status = 'active' AND sr.normalized_json ->> 'permitType' IS NOT NULL
    GROUP BY 1`);

  const mapping: Record<string, string[]> = {};
  const unmatched: UnmatchedPermitType[] = [];
  let matched = 0;
  for (const r of typesRes.rows as { permit_type: string; projects: number }[]) {
    const codes = matcher.match(r.permit_type);
    if (codes.length === 0) {
      unmatched.push({ permitType: r.permit_type, projects: Number(r.projects) });
      continue;
    }
    mapping[r.permit_type] = codes;
    matched += 1;
  }
  unmatched.sort((a, b) => b.projects - a.projects || a.permitType.localeCompare(b.permitType));

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

  // A project with no public permit type on any active resolution can never be
  // tagged, whatever the vocabulary says. Counting it separately is the whole
  // difference between "83% untagged" and "83% untagged, of which this many
  // were never taggable".
  const untaggableRes = await db.execute(sql`
    SELECT count(*)::int AS n
    FROM projects p
    WHERE NOT EXISTS (
      SELECT 1
      FROM record_resolutions rr
      JOIN source_records sr ON sr.id = rr.source_record_id
      JOIN sources s ON s.id = sr.source_id AND s.account_profile_id IS NULL
      WHERE rr.project_id = p.id
        AND rr.status = 'active'
        AND sr.normalized_json ->> 'permitType' IS NOT NULL)`);

  const summary: ProjectTradesSummary = {
    distinctPermitTypes: typesRes.rows.length,
    permitTypesMatched: matched,
    projectsTagged,
    topUnmatched: unmatched.slice(0, TOP_UNMATCHED),
    untaggableProjects: Number((untaggableRes.rows[0] as { n: number } | undefined)?.n ?? 0),
  };
  opts.logger?.info(summary, "project trades derived");
  return summary;
}
