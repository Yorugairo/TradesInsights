import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";
import { getActiveAccounts, latestRules } from "./accounts.js";
import {
  SCORING_ALGORITHM_VERSION,
  routeProject,
  type AccountScoringInput,
  type ProjectFeatures,
  type RouteResult,
} from "./scoring.js";

/**
 * M3.2 — batch routing/scoring over the project graph. Features are
 * set-based rollups of stored records/events/roles; scoring is pure; results
 * upsert into `opportunities` with the full component breakdown, rule
 * versions, and algorithm version in rationale_json (spec §12/§13: final
 * scores are deterministic calculations over stored components).
 */

export interface ScoreRunSummary {
  projectsScored: number;
  opportunities: number;
  byAccount: Record<string, { total: number; priority: number; digest: number; archive: number }>;
}

async function loadFeatures(db: Db): Promise<ProjectFeatures[]> {
  const res = await db.execute(sql`
    SELECT
      p.id,
      p.county,
      p.permitting_jurisdiction,
      p.city,
      p.current_stage,
      COALESCE(dev.member_count, 1) AS cluster_size,
      COALESCE(vel.has_velocity, false) AS has_velocity,
      COALESCE(rec.text, lower(p.canonical_name)) AS text,
      rec.max_units,
      rec.max_valuation,
      COALESCE(ev.a_grade, 0) AS a_grade,
      orgs.orgs AS orgs,
      evt.last_material_at
    FROM projects p
    LEFT JOIN LATERAL (
      SELECT count(*) AS member_count FROM projects p2 WHERE p2.development_id = p.development_id AND p.development_id IS NOT NULL
    ) dev ON true
    LEFT JOIN LATERAL (
      SELECT true AS has_velocity FROM project_events pe
      WHERE pe.project_id IN (SELECT p3.id FROM projects p3 WHERE p3.development_id = p.development_id)
        AND pe.event_type = 'cluster_velocity' LIMIT 1
    ) vel ON true
    LEFT JOIN LATERAL (
      SELECT
        lower(string_agg(
          concat_ws(' ',
            sr.normalized_json->>'title',
            left(sr.normalized_json->>'description', 800),
            sr.normalized_json->>'permitType',
            sr.normalized_json->>'applicationType',
            sr.normalized_json->>'documentType'
          ), ' ')) AS text,
        max((sr.normalized_json->>'units')::numeric)::float AS max_units,
        max((sr.normalized_json->>'valuationUsd')::numeric)::float AS max_valuation
      FROM record_resolutions rr
      JOIN source_records sr ON sr.id = rr.source_record_id
      WHERE rr.project_id = p.id AND rr.status = 'active'
    ) rec ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS a_grade
      FROM record_resolutions rr
      JOIN evidence_items ei ON ei.source_record_id = rr.source_record_id
      WHERE rr.project_id = p.id AND rr.status = 'active' AND ei.authority_grade = 'A'
    ) ev ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(json_agg(json_build_object('name', o.canonical_name, 'role', pr.role)), '[]'::json) AS orgs
      FROM project_roles pr JOIN organizations o ON o.id = pr.organization_id
      WHERE pr.project_id = p.id
    ) orgs ON true
    LEFT JOIN LATERAL (
      SELECT max(COALESCE(pe.event_date, pe.observed_at)) AS last_material_at
      FROM project_events pe WHERE pe.project_id = p.id
    ) evt ON true
    WHERE p.permitting_jurisdiction != 'Test Jurisdiction'`);

  return (res.rows as Record<string, unknown>[]).map((r) => ({
    projectId: r["id"] as string,
    county: r["county"] as string,
    permittingJurisdiction: r["permitting_jurisdiction"] as string,
    city: (r["city"] as string | null) ?? null,
    stage: r["current_stage"] as string,
    text: (r["text"] as string) ?? "",
    maxUnits: r["max_units"] === null ? null : Number(r["max_units"]),
    maxValuation: r["max_valuation"] === null ? null : Number(r["max_valuation"]),
    clusterSize: Number(r["cluster_size"] ?? 1),
    hasVelocitySignal: Boolean(r["has_velocity"]),
    orgs: (r["orgs"] as { name: string; role: string | null }[]) ?? [],
    aGradeEvidence: Number(r["a_grade"] ?? 0),
    lastMaterialChangeAt: r["last_material_at"] ? new Date(r["last_material_at"] as string) : null,
  }));
}

async function loadAccountInputs(
  db: Db,
): Promise<{ inputs: AccountScoringInput[]; ids: Map<string, string>; ruleVersions: Map<string, Record<string, number>> }> {
  const accounts = await getActiveAccounts(db);
  const inputs: AccountScoringInput[] = [];
  const ids = new Map<string, string>();
  const ruleVersions = new Map<string, Record<string, number>>();
  for (const a of accounts) {
    const rules = await latestRules(db, a.id);
    const scoring = rules.get("scoring");
    const weightRows =
      (scoring?.rule["components"] as { component: string; weight: number }[] | undefined) ?? [];
    // Raw §12 integer weights (sum 100); components are 0–1 → score 0–100.
    const weights: Record<string, number> = {};
    for (const w of weightRows) weights[w.component] = w.weight;
    inputs.push({ key: a.key, territory: a.territory, weights, delivery: a.delivery });
    ids.set(a.key, a.id);
    const versions: Record<string, number> = {};
    for (const [type, rule] of rules) versions[type] = rule.version;
    ruleVersions.set(a.key, versions);
  }
  return { inputs, ids, ruleVersions };
}

async function upsertOpportunity(
  db: Db,
  accountProfileId: string,
  f: ProjectFeatures,
  r: RouteResult,
  ruleVersions: Record<string, number>,
): Promise<void> {
  const rationale = {
    algorithmVersion: SCORING_ALGORITHM_VERSION,
    ruleVersions,
    components: r.components,
    signals: r.signals,
    route: r.route,
  };
  const scoreVersion = `${SCORING_ALGORITHM_VERSION}+rules:${Object.entries(ruleVersions)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join(",")}`;
  await db.execute(sql`
    INSERT INTO opportunities
      (account_profile_id, project_id, current_score, score_version, route, state,
       first_qualified_at, last_material_change_at, rationale_json)
    VALUES
      (${accountProfileId}, ${f.projectId}, ${r.score}, ${scoreVersion}, ${r.route}, ${r.state},
       CASE WHEN ${r.state} != 'archive' THEN now() END,
       ${f.lastMaterialChangeAt?.toISOString() ?? null},
       ${JSON.stringify(rationale)})
    ON CONFLICT (account_profile_id, project_id) DO UPDATE SET
      current_score = EXCLUDED.current_score,
      score_version = EXCLUDED.score_version,
      route = EXCLUDED.route,
      state = CASE
        -- Never silently un-archive a manual promotion or demote a dismissed one:
        -- manual states are sticky; band states track the score.
        WHEN opportunities.state IN ('dismissed', 'promoted') THEN opportunities.state
        ELSE EXCLUDED.state
      END,
      first_qualified_at = COALESCE(opportunities.first_qualified_at, EXCLUDED.first_qualified_at),
      last_material_change_at = EXCLUDED.last_material_change_at,
      rationale_json = EXCLUDED.rationale_json`);
}

export async function scoreAll(
  db: Db,
  opts: { logger?: { info(o: unknown, m?: string): void } } = {},
): Promise<ScoreRunSummary> {
  const [features, accountData] = await Promise.all([loadFeatures(db), loadAccountInputs(db)]);
  const summary: ScoreRunSummary = { projectsScored: 0, opportunities: 0, byAccount: {} };

  for (const f of features) {
    summary.projectsScored++;
    const results = routeProject(f, accountData.inputs);
    for (const r of results) {
      const accountId = accountData.ids.get(r.accountKey)!;
      await upsertOpportunity(db, accountId, f, r, accountData.ruleVersions.get(r.accountKey) ?? {});
      summary.opportunities++;
      const bucket = (summary.byAccount[r.accountKey] ??= {
        total: 0, priority: 0, digest: 0, archive: 0,
      });
      bucket.total++;
      if (r.state === "priority_review") bucket.priority++;
      else if (r.state === "weekly_digest") bucket.digest++;
      else bucket.archive++;
    }
  }
  opts.logger?.info(summary, "score run complete");
  return summary;
}
