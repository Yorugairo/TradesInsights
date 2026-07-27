import { sql } from "drizzle-orm";
import { withConnectionRetry, type Db } from "@otn/db";
import { getActiveAccounts, latestRules } from "./accounts.js";
import { warmGcEntityIds } from "./warm-network.js";
import {
  assessCapacity,
  effectiveCapacitySnapshot,
  type CapacityAssessment,
  type CapacitySnapshot,
} from "./capacity.js";
import {
  SCORING_ALGORITHM_VERSION,
  hasRouter,
  routeProject,
  type AccountScoringInput,
  type ProjectFeatures,
  type RouteResult,
} from "./scoring.js";

/** Public-work signal for the capacity hard-exclusion (mirrors scoring.ts). */
const PUBLIC_WORK_RE = /\b(school district|city of|county|wsdot|public works|port of|fire district)\b/;

function bandFor(
  score: number,
  delivery: { priority_review_min?: number; weekly_digest_min?: number },
): RouteResult["state"] {
  if (score >= (delivery.priority_review_min ?? 80)) return "priority_review";
  if (score >= (delivery.weekly_digest_min ?? 65)) return "weekly_digest";
  return "archive";
}

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
  /** Opportunities archived because their (project, account) pair stopped routing. */
  deroutedArchived: number;
  byAccount: Record<
    string,
    { total: number; priority: number; digest: number; archive: number; derouted: number }
  >;
}

type AccountBucket = ScoreRunSummary["byAccount"][string];

function bucketFor(summary: ScoreRunSummary, accountKey: string): AccountBucket {
  return (summary.byAccount[accountKey] ??= {
    total: 0, priority: 0, digest: 0, archive: 0, derouted: 0,
  });
}

/**
 * Set-based feature rollup for scoring. Exported so the M4 eval builder can
 * snapshot the exact features the scorer sees (frozen into the eval set for
 * reproducibility). `projectIds` limits the rollup; omitted = whole corpus.
 */
export async function loadFeatures(db: Db, projectIds?: string[]): Promise<ProjectFeatures[]> {
  const filter =
    projectIds && projectIds.length > 0
      ? sql`AND p.id IN (${sql.join(
          projectIds.map((id) => sql`${id}`),
          sql`, `,
        )})`
      : sql``;
  const res = await db.execute(sql`
    SELECT
      p.id,
      p.county,
      p.permitting_jurisdiction,
      p.city,
      p.current_stage,
      COALESCE(dev.member_count, 1) AS cluster_size,
      COALESCE(vel.has_velocity, false) AS has_velocity,
      p.campus_block,
      p.corroboration,
      COALESCE(rec.text, lower(p.canonical_name)) AS text,
      rec.max_units,
      rec.max_valuation,
      COALESCE(ev.a_grade, 0) AS a_grade,
      orgs.orgs AS orgs,
      evt.last_material_at,
      app.applied_at
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
        lower(string_agg(rec_text.t, ' ')) AS text,
        json_agg(lower(rec_text.t)) AS records,
        max((sr.normalized_json->>'units')::numeric)::float AS max_units,
        max((sr.normalized_json->>'valuationUsd')::numeric)::float AS max_valuation
      FROM record_resolutions rr
      JOIN source_records sr ON sr.id = rr.source_record_id
      CROSS JOIN LATERAL (
        SELECT concat_ws(' ',
          sr.normalized_json->>'title',
          left(sr.normalized_json->>'description', 800),
          sr.normalized_json->>'permitType',
          sr.normalized_json->>'applicationType',
          sr.normalized_json->>'documentType') AS t
      ) rec_text
      WHERE rr.project_id = p.id AND rr.status = 'active'
    ) rec ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS a_grade
      FROM record_resolutions rr
      JOIN evidence_items ei ON ei.source_record_id = rr.source_record_id
      WHERE rr.project_id = p.id AND rr.status = 'active' AND ei.authority_grade = 'A'
    ) ev ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(json_agg(json_build_object(
        'name', o.canonical_name, 'role', pr.role,
        'registryRef', o.registry_ref,
        'registryVerified', (o.registry_ref IS NOT NULL),
        -- WS-B — enriched contract fields cached on the identity snapshot; feed
        -- the score-neutral gc_quality/trade_match signals (null when unbound).
        'googleRating', (o.registry_identity_json->>'google_rating')::numeric,
        'googleReviewCount', (o.registry_identity_json->>'google_review_count')::int,
        'tradeCodes', o.registry_identity_json->'trade_codes')), '[]'::json) AS orgs
      FROM project_roles pr JOIN organizations o ON o.id = pr.organization_id
      WHERE pr.project_id = p.id
    ) orgs ON true
    LEFT JOIN LATERAL (
      SELECT max(COALESCE(pe.event_date, pe.observed_at)) AS last_material_at
      FROM project_events pe WHERE pe.project_id = p.id
    ) evt ON true
    -- v1.12.0 — when the application was FILED, for the application-stage
    -- freshness gradient (scoring.ts appliedFreshness). Same derivation as
    -- migrations/0029_market_aggregates.sql: earliest CONFIRMED permit_applied
    -- event. Unconfirmed events are excluded on purpose — an unverified filing
    -- date would silently age a live opportunity out of the priority band.
    LEFT JOIN LATERAL (
      SELECT min(pe.event_date) AS applied_at
      FROM project_events pe
      WHERE pe.project_id = p.id AND pe.confirmed AND pe.resulting_stage = 'permit_applied'
    ) app ON true
    WHERE p.permitting_jurisdiction != 'Test Jurisdiction' ${filter}`);

  return (res.rows as Record<string, unknown>[]).map((r) => {
    const records = Array.isArray(r["records"])
      ? (r["records"] as (string | null)[]).filter((s): s is string => Boolean(s))
      : [];
    return {
      projectId: r["id"] as string,
      county: r["county"] as string,
      permittingJurisdiction: r["permitting_jurisdiction"] as string,
      city: (r["city"] as string | null) ?? null,
      stage: r["current_stage"] as string,
      text: (r["text"] as string) ?? "",
      ...(records.length > 0 ? { records } : {}),
      maxUnits: r["max_units"] === null ? null : Number(r["max_units"]),
      maxValuation: r["max_valuation"] === null ? null : Number(r["max_valuation"]),
      clusterSize: Number(r["cluster_size"] ?? 1),
      hasVelocitySignal: Boolean(r["has_velocity"]),
      // Derived active-campus membership (#1) — conditional spread keeps the
      // field absent (not undefined) under exactOptionalPropertyTypes.
      ...(r["campus_block"] ? { campusBlock: r["campus_block"] as string } : {}),
      // Phase 1 flywheel — corroboration (score-neutral signals only). Absent
      // when the derivation has not run for this project.
      ...(r["corroboration"]
        ? (() => {
            const c = r["corroboration"] as {
              sourceCount?: number;
              stageDepth?: number;
              contradictions?: unknown[];
            };
            return {
              corroborationSourceCount: c.sourceCount ?? null,
              corroborationStageDepth: c.stageDepth ?? null,
              hasFactContradiction: (c.contradictions?.length ?? 0) > 0,
            };
          })()
        : {}),
      orgs:
        (r["orgs"] as {
          name: string;
          role: string | null;
          registryRef?: string | null;
          registryVerified?: boolean;
          googleRating?: number | null;
          googleReviewCount?: number | null;
          tradeCodes?: string[] | null;
        }[]) ?? [],
      aGradeEvidence: Number(r["a_grade"] ?? 0),
      lastMaterialChangeAt: r["last_material_at"] ? new Date(r["last_material_at"] as string) : null,
      // Conditional spread, like campusBlock above: the field stays ABSENT rather
      // than undefined under exactOptionalPropertyTypes, which is also what keeps
      // frozen eval examples byte-identical (appliedFreshness treats absent as 1).
      ...(r["applied_at"] ? { appliedAt: new Date(r["applied_at"] as string) } : {}),
    };
  });
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
    // WS-W — the account's warm network of active, registry-bound GCs in
    // territory (empty until orgs are bound; adds only a score-neutral signal).
    const warmGcRefs = await warmGcEntityIds(db, a.id, a.territory);
    // WS-B — the account's configured trades (capabilities; Solis: drywall/
    // painting) drive the score-neutral `trade_match` signal only.
    inputs.push({
      key: a.key,
      territory: a.territory,
      weights,
      delivery: a.delivery,
      warmGcRefs,
      trades: a.capabilities,
    });
    ids.set(a.key, a.id);
    const versions: Record<string, number> = {};
    for (const [type, rule] of rules) versions[type] = rule.version;
    ruleVersions.set(a.key, versions);
  }
  return { inputs, ids, ruleVersions };
}

/**
 * S0 (§5) — fold the effective capacity snapshot into the deterministic score.
 * Capacity is a multiplier over the §12 score with a recorded explanation; a
 * missing snapshot (factor 1) leaves the score untouched, so accounts without a
 * snapshot behave exactly as before. The adjusted score is re-banded against the
 * account's own thresholds — so the same project lands in a different band under
 * a different snapshot without ever rewriting a prior delivered score.
 */
function applyCapacity(
  r: RouteResult,
  f: ProjectFeatures,
  snap: CapacitySnapshot | null,
  delivery: { priority_review_min?: number; weekly_digest_min?: number },
): { score: number; state: RouteResult["state"]; capacity: CapacityAssessment } {
  const capacity = assessCapacity(
    { valuationUsd: f.maxValuation, isPublicWork: PUBLIC_WORK_RE.test(f.text) },
    snap,
  );
  const score = Math.round(r.score * capacity.priorityFactor * 10) / 10;
  return { score, state: bandFor(score, delivery), capacity };
}

async function upsertOpportunity(
  db: Db,
  accountProfileId: string,
  f: ProjectFeatures,
  r: RouteResult,
  ruleVersions: Record<string, number>,
  adjusted: { score: number; state: RouteResult["state"]; capacity: CapacityAssessment },
): Promise<void> {
  const rationale = {
    algorithmVersion: SCORING_ALGORITHM_VERSION,
    ruleVersions,
    components: r.components,
    signals: r.signals,
    route: r.route,
    baseScore: r.score,
    capacity: {
      assessment: adjusted.capacity.assessment,
      priorityFactor: adjusted.capacity.priorityFactor,
      explanation: adjusted.capacity.explanation,
      provisional: adjusted.capacity.provisional,
    },
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
      (${accountProfileId}, ${f.projectId}, ${adjusted.score}, ${scoreVersion}, ${r.route}, ${adjusted.state},
       CASE WHEN ${adjusted.state} != 'archive' THEN now() END,
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
      -- Wholesale replacement also clears any deroute marker a previous sweep
      -- stamped here: a pair that routes again is live again, and the marker
      -- must not outlive the condition it recorded.
      rationale_json = EXCLUDED.rationale_json`);
}

/**
 * De-routing (2026-07-26).
 *
 * `scoreAll` only ever wrote the pairs `routeProject` RETURNED. A project that
 * stopped routing to an account — territory edit, exclusion rule, keyword
 * reclassification — kept its `opportunities` row untouched at whatever score
 * and algorithmVersion it last had, forever. Found live in production:
 * opportunity 93054ce2 (solis_interiors, weekly_digest, score 72.5) still
 * carried algorithmVersion 1.9.0 three releases after 1.12.0, because the
 * project's shoreline/dock records no longer clear routeSolis's trade-fit gate.
 * It had never actually been sent (no delivery_items), but it sat in a delivery
 * state, so nothing but luck kept a retired model out of a customer's digest.
 *
 * Semantics chosen: ARCHIVE, with the reason recorded — not a new "stale" flag.
 * `archive` is already this system's word for "scored, not deliverable" (it is
 * what `bandFor` returns below the digest floor) and every delivery path already
 * honours it, so nothing downstream needs to learn a new state. The row is kept,
 * never deleted, and the reason is merged INTO the existing rationale so the last
 * real score stays auditable next to the note explaining why it stopped moving.
 *
 * `dismissed` and `promoted` are excluded: those are human decisions and the
 * sweep is not entitled to overturn one. A `promoted` row that no longer routes
 * therefore stays live by design — the delivery-side version guard
 * (`scoredByCurrentAlgorithm`) is what stops it going out stale, and it discloses
 * the withholding rather than silently dropping it.
 */
export const DEROUTE_REASON = "no_longer_routed";

/** Opportunity states the sweep may archive — manual decisions and rows already
 * archived are excluded. Kept as one list so the read filter and the write-time
 * re-check below can never drift apart. */
const SWEEPABLE_STATE_EXCLUSIONS = sql`('archive', 'dismissed', 'promoted')`;

export interface LiveOpportunityRow {
  id: string;
  accountProfileId: string;
  projectId: string;
}

/** Stable key for a (project, account) pair. `::` cannot occur inside a UUID, so
 * no two distinct pairs can collide on one key. */
function pairKey(accountProfileId: string, projectId: string): string {
  return `${accountProfileId}::${projectId}`;
}

/**
 * The sweepable rows this run proved are no longer routed. Pure, so the
 * selection rule is testable without a database.
 *
 * The `scoredProjectIds` condition is the safety property: the sweep can only
 * demote a pair whose project this run actually re-evaluated. A project outside
 * the run's scope — or one `loadFeatures` no longer returns at all — is left
 * alone, because not looking at something is not evidence about it.
 */
export function deroutedOpportunities(
  live: readonly LiveOpportunityRow[],
  routedPairs: ReadonlySet<string>,
  scoredProjectIds: ReadonlySet<string>,
): LiveOpportunityRow[] {
  return live.filter(
    (row) =>
      scoredProjectIds.has(row.projectId) &&
      !routedPairs.has(pairKey(row.accountProfileId, row.projectId)),
  );
}

async function loadSweepableOpportunities(
  db: Db,
  accountProfileIds: string[],
): Promise<LiveOpportunityRow[]> {
  if (accountProfileIds.length === 0) return [];
  const res = await db.execute(sql`
    SELECT id, account_profile_id, project_id
    FROM opportunities
    WHERE state NOT IN ${SWEEPABLE_STATE_EXCLUSIONS}
      AND account_profile_id IN (${sql.join(
        accountProfileIds.map((id) => sql`${id}`),
        sql`, `,
      )})`);
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    id: r["id"] as string,
    accountProfileId: r["account_profile_id"] as string,
    projectId: r["project_id"] as string,
  }));
}

/**
 * Archive the de-routed rows in one statement and report which ones actually
 * moved. The id list rides as a single jsonb parameter so a large sweep cannot
 * run into the bind-parameter ceiling.
 */
async function archiveDerouted(db: Db, ids: string[]): Promise<Set<string>> {
  const res = await db.execute(sql`
    UPDATE opportunities SET
      state = 'archive',
      -- Merge, never replace: the last real score's components/signals stay
      -- intact beside the note. A bare "state" on the right-hand side is the
      -- row's PRE-update value, so previousState records where it came from.
      -- The ::text casts are required, not decorative: jsonb_build_object is
      -- variadic "any", so a bare placeholder gives the planner nothing to infer
      -- from and it fails with 42P18 "could not determine data type".
      rationale_json = COALESCE(rationale_json, '{}'::jsonb) || jsonb_build_object(
        'deroute', jsonb_build_object(
          'reason', ${DEROUTE_REASON}::text,
          'archivedAt', now(),
          'previousState', state,
          'atAlgorithmVersion', ${SCORING_ALGORITHM_VERSION}::text))
    WHERE id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid)
      -- Re-assert the manual-state guard AT WRITE TIME. The sweep reads at the
      -- end of a run that can take minutes; an owner who promoted or dismissed
      -- a row in the meantime must win, and RETURNING tells us who did.
      AND state NOT IN ${SWEEPABLE_STATE_EXCLUSIONS}
    RETURNING id`);
  return new Set((res.rows as { id: string }[]).map((r) => r.id));
}

/**
 * `scoreAll` is a long SERIAL loop of one round trip per opportunity against a
 * Supavisor session-mode pooler. On 2026-07-26 a full rescore died partway with
 * "Connection terminated unexpectedly" after writing 31 of ~1,260 Solis rows,
 * leaving production on a MIX of algorithm versions — a worse state than either
 * the old or the new model, because half the list is ranked by rules the other
 * half is not. The loop has no resume, so a plain retry restarts from the top
 * and lands somewhere different every time.
 *
 * The retry helper that fixed it now lives in @otn/db, because the same fault
 * hit two other subsystems the following day. It also gained an important
 * capability there: it walks `cause` chains and `AggregateError.errors[]`, so a
 * driver error that merely WRAPS a connection fault is still recognised. The
 * copy that lived here matched only the top-level message and would have missed
 * exactly that shape.
 */
export async function scoreAll(
  db: Db,
  opts: {
    logger?: { info(o: unknown, m?: string): void };
    /**
     * Limit the run to these projects. Omitted = the whole corpus (the
     * production default). Scoping is safe for the de-route sweep by
     * construction: the sweep only considers pairs whose project this run
     * actually re-scored, so a narrow run can never archive work it never read.
     */
    projectIds?: string[];
  } = {},
): Promise<ScoreRunSummary> {
  const [features, accountData] = await Promise.all([
    loadFeatures(db, opts.projectIds),
    loadAccountInputs(db),
  ]);
  const summary: ScoreRunSummary = {
    projectsScored: 0,
    opportunities: 0,
    deroutedArchived: 0,
    byAccount: {},
  };

  // The capacity snapshot effective at scoring time, per account (§5). Loaded
  // once per run; a null snapshot leaves scores unchanged.
  const now = new Date();
  const deliveryByKey = new Map(accountData.inputs.map((i) => [i.key, i.delivery]));
  const snapshotByKey = new Map<string, CapacitySnapshot | null>();
  for (const [key, id] of accountData.ids) {
    snapshotByKey.set(key, await effectiveCapacitySnapshot(db, id, now));
  }

  // Everything this run re-scored, and every pair it found still routing. The
  // difference between them is what the sweep archives below.
  const scoredProjectIds = new Set(features.map((f) => f.projectId));
  const routedPairs = new Set<string>();

  for (const f of features) {
    summary.projectsScored++;
    const results = routeProject(f, accountData.inputs, now);
    for (const r of results) {
      const accountId = accountData.ids.get(r.accountKey)!;
      const adjusted = applyCapacity(
        r,
        f,
        snapshotByKey.get(r.accountKey) ?? null,
        deliveryByKey.get(r.accountKey) ?? {},
      );
      await withConnectionRetry(
        () =>
          upsertOpportunity(
            db,
            accountId,
            f,
            r,
            accountData.ruleVersions.get(r.accountKey) ?? {},
            adjusted,
          ),
        {
          onRetry: (attempt, err) =>
            opts.logger?.info(
              { attempt, projectId: f.projectId, account: r.accountKey, err: String(err) },
              "transient connection fault during upsert — retrying",
            ),
        },
      );
      routedPairs.add(pairKey(accountId, f.projectId));
      summary.opportunities++;
      const bucket = bucketFor(summary, r.accountKey);
      bucket.total++;
      if (adjusted.state === "priority_review") bucket.priority++;
      else if (adjusted.state === "weekly_digest") bucket.digest++;
      else bucket.archive++;
    }
  }

  // The de-route sweep runs only HERE, after every upsert has landed. A run that
  // throws partway never reaches it — which is the point: a half-finished pass
  // has no basis to claim anything stopped routing, it just stopped looking.
  const accountKeyById = new Map<string, string>();
  const evaluatedAccountIds: string[] = [];
  for (const [key, id] of accountData.ids) {
    accountKeyById.set(id, key);
    // Only accounts the scorer can actually route for. For an account with no
    // router, "nothing routed" is a config gap, not a verdict on the project.
    if (hasRouter(key)) evaluatedAccountIds.push(id);
  }
  const sweepable = await loadSweepableOpportunities(db, evaluatedAccountIds);
  const derouted = deroutedOpportunities(sweepable, routedPairs, scoredProjectIds);
  if (derouted.length > 0) {
    const archived = await withConnectionRetry(
      () => archiveDerouted(db, derouted.map((d) => d.id)),
      {
        onRetry: (attempt, err) =>
          opts.logger?.info(
            { attempt, candidates: derouted.length, err: String(err) },
            "transient connection fault during de-route sweep — retrying",
          ),
      },
    );
    for (const row of derouted) {
      if (!archived.has(row.id)) continue; // manual state won the race
      summary.deroutedArchived++;
      const key = accountKeyById.get(row.accountProfileId);
      if (key) bucketFor(summary, key).derouted++;
    }
    opts.logger?.info(
      {
        candidates: derouted.length,
        archived: summary.deroutedArchived,
        skippedManualState: derouted.length - summary.deroutedArchived,
        reason: DEROUTE_REASON,
      },
      "archived opportunities whose (project, account) pair stopped routing",
    );
  }

  opts.logger?.info(summary, "score run complete");
  return summary;
}
