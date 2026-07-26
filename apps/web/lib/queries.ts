import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";
import {
  evaluateGate,
  latestBrief,
  latestExtraction,
  latestVerification,
  type DecisionBrief,
  type GateResult,
  type ModelExtraction,
  type VerifierResult,
} from "@otn/intelligence";

/**
 * Read-side queries for the §16 pages and §17 APIs. Every account-facing
 * query takes the session's accountProfileId — account isolation lives here,
 * not in the UI (spec §17: apply account/role authorization to every query).
 */

// ── Accounts ─────────────────────────────────────────────────────────────────

export interface AccountView {
  id: string;
  key: string;
  name: string;
  capabilities: unknown;
  territory: unknown;
  exclusions: unknown;
  delivery: {
    priority_review_min?: number;
    weekly_digest_min?: number;
    /** P2.1 easy-win config. Every field is optional: the block itself is
     * optional per account, and a pre-calibration account may carry none of it.
     * Mirrors `delivery.easy_win` in config/account-profiles.yaml. */
    easy_win?: {
      home_lon?: number | null;
      home_lat?: number | null;
      radius_km?: number | null;
      radius_bands_mi?: number[] | null;
      max_age_days?: number | null;
      min_valuation_usd?: number | null;
      max_valuation_usd?: number | null;
    };
  };
}

export async function accountByKey(db: Db, key: string): Promise<AccountView | null> {
  const res = await db.execute(sql`
    SELECT id, key, name, capabilities_json, territory_json, exclusions_json, delivery_config_json
    FROM account_profiles WHERE key = ${key} AND active = true`);
  const r = res.rows[0] as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    id: r["id"] as string,
    key: r["key"] as string,
    name: r["name"] as string,
    capabilities: r["capabilities_json"],
    territory: r["territory_json"],
    exclusions: r["exclusions_json"],
    delivery: (r["delivery_config_json"] as AccountView["delivery"]) ?? {},
  };
}

export async function listAccounts(db: Db): Promise<{ key: string; name: string }[]> {
  const res = await db.execute(
    sql`SELECT key, name FROM account_profiles WHERE active = true ORDER BY name`,
  );
  return res.rows as { key: string; name: string }[];
}

export async function accountRules(
  db: Db,
  accountProfileId: string,
): Promise<{ ruleType: string; version: number; effectiveAt: string; rule: unknown }[]> {
  const res = await db.execute(sql`
    SELECT DISTINCT ON (rule_type) rule_type, version, effective_at, rule_json
    FROM account_rules WHERE account_profile_id = ${accountProfileId}
    ORDER BY rule_type, version DESC`);
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    ruleType: r["rule_type"] as string,
    version: r["version"] as number,
    effectiveAt: r["effective_at"] as string,
    rule: r["rule_json"],
  }));
}

// ── Opportunities ────────────────────────────────────────────────────────────

export interface OpportunityListItem {
  id: string;
  projectId: string;
  projectName: string;
  county: string;
  permittingJurisdiction: string;
  stage: string;
  score: number | null;
  route: string | null;
  state: string;
  campusBlock: string | null;
  lastMaterialChangeAt: string | null;
}

/** Batch3 #2 — filterable/sortable/paginated list for 1,000+-item accounts. */
export interface OpportunityListFilter {
  /** Band/state; "all" includes archive; omitted = everything except archive. */
  state?: string;
  county?: string;
  stage?: string;
  /** Case-insensitive match on project name, jurisdiction, or address. */
  q?: string;
  campusOnly?: boolean;
  sort?: "score" | "recent";
  limit?: number;
  offset?: number;
}

export async function listOpportunities(
  db: Db,
  accountProfileId: string,
  opts: OpportunityListFilter = {},
): Promise<{ items: OpportunityListItem[]; total: number }> {
  const limit = Math.min(opts.limit ?? 100, 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const stateFilter =
    opts.state === "all"
      ? sql``
      : opts.state
        ? sql`AND o.state = ${opts.state}`
        : sql`AND o.state != 'archive'`;
  const countyFilter = opts.county ? sql`AND p.county = ${opts.county}` : sql``;
  const stageFilter = opts.stage ? sql`AND p.current_stage = ${opts.stage}` : sql``;
  const campusFilter = opts.campusOnly ? sql`AND p.campus_block IS NOT NULL` : sql``;
  const qFilter = opts.q
    ? sql`AND (p.canonical_name ILIKE ${"%" + opts.q + "%"}
          OR p.permitting_jurisdiction ILIKE ${"%" + opts.q + "%"}
          OR p.address_normalized ILIKE ${"%" + opts.q + "%"})`
    : sql``;
  const order =
    opts.sort === "recent"
      ? sql`o.last_material_change_at DESC NULLS LAST`
      : sql`o.current_score DESC NULLS LAST`;
  const res = await db.execute(sql`
    SELECT o.id, o.project_id, p.canonical_name, p.county, p.permitting_jurisdiction,
      p.current_stage, o.current_score, o.route, o.state, p.campus_block,
      o.last_material_change_at, count(*) OVER () AS total
    FROM opportunities o
    JOIN projects p ON p.id = o.project_id
    WHERE o.account_profile_id = ${accountProfileId}
      ${stateFilter} ${countyFilter} ${stageFilter} ${campusFilter} ${qFilter}
    ORDER BY ${order}
    LIMIT ${limit} OFFSET ${offset}`);
  const rows = res.rows as Record<string, unknown>[];
  return {
    total: rows.length > 0 ? Number(rows[0]!["total"]) : 0,
    items: rows.map((r) => ({
      id: r["id"] as string,
      projectId: r["project_id"] as string,
      projectName: r["canonical_name"] as string,
      county: r["county"] as string,
      permittingJurisdiction: r["permitting_jurisdiction"] as string,
      stage: r["current_stage"] as string,
      score: r["current_score"] as number | null,
      route: r["route"] as string | null,
      state: r["state"] as string,
      campusBlock: (r["campus_block"] as string | null) ?? null,
      lastMaterialChangeAt: (r["last_material_change_at"] as string | null) ?? null,
    })),
  };
}

export interface EvidenceView {
  id: string;
  factPath: string;
  evidenceText: string;
  pageOrSection: string | null;
  sourceUrl: string;
  authorityGrade: string;
  retrievedAt: string;
  sourceName: string;
}

export interface TimelineEvent {
  eventType: string;
  eventDate: string | null;
  observedAt: string;
  resultingStage: string | null;
  materialChange: boolean;
  confirmed: boolean;
  sourceUrl: string | null;
}

export interface RoleView {
  name: string;
  role: string | null;
  confirmed: boolean;
}

export interface OpportunityDetail {
  id: string;
  state: string;
  route: string | null;
  score: number | null;
  scoreVersion: string | null;
  rationale: unknown;
  project: {
    id: string;
    name: string;
    county: string;
    permittingJurisdiction: string;
    city: string | null;
    address: string | null;
    parcels: unknown;
    stage: string;
    lastMaterialChangeAt: string | null;
    maxUnits: number | null;
    maxValuation: number | null;
    campusBlock: string | null;
    /** Concatenated title/description text of active records (bid-window classify input). */
    bidText: string;
    /** Latest stated permit issue date across active records (never inferred). */
    latestIssueDate: string | null;
  };
  /** Phase-1 corroboration jsonb ({sources, stageDepth, contradictions}) or null (unknown ≠ zero). */
  corroboration: {
    sources?: string[];
    stageDepth?: number;
    contradictions?: { field: string; values: unknown[]; recordIds: string[] }[];
  } | null;
  roles: RoleView[];
  evidence: EvidenceView[];
  timeline: TimelineEvent[];
  extraction: ModelExtraction | null;
  verification: { status: string; result: VerifierResult | null } | null;
  gate: GateResult | null;
  /** Verified narrative brief (model prose over the memo), or null when none
   * has been generated (no key / not yet run). The deterministic memo panel
   * is always present regardless. */
  brief: DecisionBrief | null;
  nextAction: string;
}

/** §16 "Recommended next action" — deterministic, derived from stored state. */
function recommendNextAction(
  state: string,
  gate: GateResult | null,
  extraction: ModelExtraction | null,
): string {
  if (state === "dismissed") return "Dismissed — no action.";
  if (gate?.status === "fail") {
    const failed = gate.checks.filter((c) => c.pass === false).map((c) => c.name);
    return `Not publishable yet — resolve: ${failed.join(", ")}.`;
  }
  if (gate?.status === "blocked_on_verifier") {
    return "Awaiting model verification (blocked without model keys) — facts shown are deterministic parses only.";
  }
  const missing = extraction?.missingCriticalFacts ?? [];
  if (missing.length > 0) {
    return `Verify missing critical facts before outreach: ${missing.join(", ")}.`;
  }
  if (state === "priority_review" || state === "promoted") {
    return "Review evidence and decide pursue/dismiss; all publication checks pass.";
  }
  return "Monitor for stage changes; include in weekly digest.";
}

export async function opportunityDetail(
  db: Db,
  opportunityId: string,
  accountProfileId: string,
): Promise<OpportunityDetail | null> {
  const res = await db.execute(sql`
    SELECT o.id, o.state, o.route, o.current_score, o.score_version, o.rationale_json,
      o.last_material_change_at,
      p.id AS project_id, p.canonical_name, p.county, p.permitting_jurisdiction, p.city,
      p.address_normalized, p.parcel_ids, p.current_stage, p.campus_block, p.corroboration,
      rec.max_units, rec.max_valuation, rec.bid_text, rec.latest_issue_date
    FROM opportunities o
    JOIN projects p ON p.id = o.project_id
    LEFT JOIN LATERAL (
      SELECT max((sr.normalized_json->>'units')::numeric)::float AS max_units,
        max((sr.normalized_json->>'valuationUsd')::numeric)::float AS max_valuation,
        lower(string_agg(concat_ws(' ',
          sr.normalized_json->>'title', left(sr.normalized_json->>'description', 800)), ' ')) AS bid_text,
        max(sr.normalized_json->>'issueDate') FILTER (
          WHERE sr.normalized_json->>'issueDate' ~ '^\d{4}-\d{2}-\d{2}') AS latest_issue_date
      FROM record_resolutions rr JOIN source_records sr ON sr.id = rr.source_record_id
      WHERE rr.project_id = p.id AND rr.status = 'active'
    ) rec ON true
    WHERE o.id = ${opportunityId} AND o.account_profile_id = ${accountProfileId}`);
  const r = res.rows[0] as Record<string, unknown> | undefined;
  if (!r) return null;
  const projectId = r["project_id"] as string;

  const [roles, evidence, timeline, extraction, verification, gate, brief] = await Promise.all([
    projectRoles(db, projectId),
    projectEvidence(db, projectId, { accountProfileId }),
    projectTimeline(db, projectId),
    latestExtraction(db, projectId),
    latestVerification(db, projectId),
    evaluateGate(db, opportunityId),
    latestBrief(db, opportunityId, accountProfileId, projectId),
  ]);

  const state = r["state"] as string;
  return {
    id: r["id"] as string,
    state,
    route: r["route"] as string | null,
    score: r["current_score"] as number | null,
    scoreVersion: r["score_version"] as string | null,
    rationale: r["rationale_json"],
    project: {
      id: projectId,
      name: r["canonical_name"] as string,
      county: r["county"] as string,
      permittingJurisdiction: r["permitting_jurisdiction"] as string,
      city: (r["city"] as string | null) ?? null,
      address: (r["address_normalized"] as string | null) ?? null,
      parcels: r["parcel_ids"],
      stage: r["current_stage"] as string,
      lastMaterialChangeAt: (r["last_material_change_at"] as string | null) ?? null,
      maxUnits: r["max_units"] === null ? null : Number(r["max_units"]),
      maxValuation: r["max_valuation"] === null ? null : Number(r["max_valuation"]),
      campusBlock: (r["campus_block"] as string | null) ?? null,
      bidText: (r["bid_text"] as string | null) ?? (r["canonical_name"] as string).toLowerCase(),
      latestIssueDate: (r["latest_issue_date"] as string | null) ?? null,
    },
    corroboration: (r["corroboration"] as OpportunityDetail["corroboration"]) ?? null,
    roles,
    evidence,
    timeline,
    extraction: extraction?.extraction ?? null,
    verification: verification
      ? { status: verification.status, result: verification.result }
      : null,
    gate,
    brief,
    nextAction: recommendNextAction(state, gate, extraction?.extraction ?? null),
  };
}

/** #1 — sibling projects of an active campus (same derived campus_block). */
export interface CampusView {
  block: string;
  siblings: { id: string; name: string; stage: string }[];
}

export async function campusSiblings(
  db: Db,
  projectId: string,
  campusBlock: string | null,
): Promise<CampusView | null> {
  if (!campusBlock) return null;
  const res = await db.execute(sql`
    SELECT id, canonical_name, current_stage FROM projects
    WHERE campus_block = ${campusBlock} AND id != ${projectId}
    ORDER BY first_seen_at ASC LIMIT 25`);
  const block = campusBlock.includes(":") ? campusBlock.split(":")[1]! : campusBlock;
  return {
    block,
    siblings: (res.rows as { id: string; canonical_name: string; current_stage: string }[]).map(
      (r) => ({ id: r.id, name: r.canonical_name, stage: r.current_stage }),
    ),
  };
}

// ── Projects ─────────────────────────────────────────────────────────────────

export async function accountHasProject(
  db: Db,
  accountProfileId: string,
  projectId: string,
): Promise<boolean> {
  const res = await db.execute(sql`
    SELECT 1 FROM opportunities
    WHERE account_profile_id = ${accountProfileId} AND project_id = ${projectId} LIMIT 1`);
  return res.rows.length > 0;
}

export async function projectRoles(db: Db, projectId: string): Promise<RoleView[]> {
  const res = await db.execute(sql`
    SELECT DISTINCT o.canonical_name, pr.role, pr.confirmed
    FROM project_roles pr JOIN organizations o ON o.id = pr.organization_id
    WHERE pr.project_id = ${projectId}`);
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    name: r["canonical_name"] as string,
    role: (r["role"] as string | null) ?? null,
    confirmed: Boolean(r["confirmed"]),
  }));
}

export async function projectEvidence(
  db: Db,
  projectId: string,
  viewer: { accountProfileId: string | null } = { accountProfileId: null },
): Promise<EvidenceView[]> {
  // Account isolation, defense in depth: private-source evidence is visible
  // only to the owning account even if a private record ever reaches the
  // shared graph (today the resolver keeps them out entirely).
  const res = await db.execute(sql`
    SELECT ei.id, ei.fact_path, ei.evidence_text, ei.page_or_section, ei.source_url,
      ei.authority_grade, ra.retrieved_at, s.name AS source_name
    FROM record_resolutions rr
    JOIN evidence_items ei ON ei.source_record_id = rr.source_record_id
    JOIN raw_artifacts ra ON ra.id = ei.raw_artifact_id
    JOIN sources s ON s.id = ra.source_id
    WHERE rr.project_id = ${projectId} AND rr.status = 'active'
      AND (s.account_profile_id IS NULL OR s.account_profile_id = ${viewer.accountProfileId})
    ORDER BY ei.fact_path
    LIMIT 200`);
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    id: r["id"] as string,
    factPath: r["fact_path"] as string,
    evidenceText: r["evidence_text"] as string,
    pageOrSection: (r["page_or_section"] as string | null) ?? null,
    sourceUrl: r["source_url"] as string,
    authorityGrade: r["authority_grade"] as string,
    retrievedAt: r["retrieved_at"] as string,
    sourceName: r["source_name"] as string,
  }));
}

export async function projectTimeline(db: Db, projectId: string): Promise<TimelineEvent[]> {
  const res = await db.execute(sql`
    SELECT pe.event_type, pe.event_date, pe.observed_at, pe.resulting_stage,
      pe.material_change, pe.confirmed, sr.normalized_json->>'sourceUrl' AS source_url
    FROM project_events pe
    JOIN source_records sr ON sr.id = pe.source_record_id
    WHERE pe.project_id = ${projectId}
    ORDER BY COALESCE(pe.event_date, pe.observed_at) DESC
    LIMIT 100`);
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    eventType: r["event_type"] as string,
    eventDate: (r["event_date"] as string | null) ?? null,
    observedAt: r["observed_at"] as string,
    resultingStage: (r["resulting_stage"] as string | null) ?? null,
    materialChange: Boolean(r["material_change"]),
    confirmed: Boolean(r["confirmed"]),
    sourceUrl: (r["source_url"] as string | null) ?? null,
  }));
}

export interface ProjectDetail {
  id: string;
  name: string;
  county: string;
  permittingJurisdiction: string;
  city: string | null;
  address: string | null;
  parcels: unknown;
  stage: string;
  developmentName: string | null;
  records: {
    id: string;
    externalId: string;
    recordType: string;
    title: string | null;
    sourceUrl: string | null;
    sourceName: string;
    lastSeenAt: string;
  }[];
  roles: RoleView[];
  evidence: EvidenceView[];
  timeline: TimelineEvent[];
}

export async function projectDetail(db: Db, projectId: string): Promise<ProjectDetail | null> {
  const res = await db.execute(sql`
    SELECT p.id, p.canonical_name, p.county, p.permitting_jurisdiction, p.city,
      p.address_normalized, p.parcel_ids, p.current_stage, d.canonical_name AS development_name
    FROM projects p
    LEFT JOIN developments d ON d.id = p.development_id
    WHERE p.id = ${projectId}`);
  const r = res.rows[0] as Record<string, unknown> | undefined;
  if (!r) return null;

  const recordsRes = await db.execute(sql`
    SELECT sr.id, sr.external_id, sr.record_type, sr.normalized_json->>'title' AS title,
      sr.normalized_json->>'sourceUrl' AS source_url, s.name AS source_name, sr.last_seen_at
    FROM record_resolutions rr
    JOIN source_records sr ON sr.id = rr.source_record_id
    JOIN sources s ON s.id = sr.source_id
    WHERE rr.project_id = ${projectId} AND rr.status = 'active'
    ORDER BY sr.last_seen_at DESC`);

  const [roles, evidence, timeline] = await Promise.all([
    projectRoles(db, projectId),
    projectEvidence(db, projectId),
    projectTimeline(db, projectId),
  ]);

  return {
    id: r["id"] as string,
    name: r["canonical_name"] as string,
    county: r["county"] as string,
    permittingJurisdiction: r["permitting_jurisdiction"] as string,
    city: (r["city"] as string | null) ?? null,
    address: (r["address_normalized"] as string | null) ?? null,
    parcels: r["parcel_ids"],
    stage: r["current_stage"] as string,
    developmentName: (r["development_name"] as string | null) ?? null,
    records: (recordsRes.rows as Record<string, unknown>[]).map((rec) => ({
      id: rec["id"] as string,
      externalId: rec["external_id"] as string,
      recordType: rec["record_type"] as string,
      title: (rec["title"] as string | null) ?? null,
      sourceUrl: (rec["source_url"] as string | null) ?? null,
      sourceName: rec["source_name"] as string,
      lastSeenAt: rec["last_seen_at"] as string,
    })),
    roles,
    evidence,
    timeline,
  };
}

// ── Digests & feedback ───────────────────────────────────────────────────────

export async function listDigests(
  db: Db,
  accountProfileId: string,
): Promise<
  { id: string; deliveryType: string; periodStart: string; periodEnd: string; status: string; sentAt: string | null }[]
> {
  const res = await db.execute(sql`
    SELECT id, delivery_type, period_start, period_end, status, sent_at
    FROM deliveries WHERE account_profile_id = ${accountProfileId}
    ORDER BY period_start DESC LIMIT 100`);
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    id: r["id"] as string,
    deliveryType: r["delivery_type"] as string,
    periodStart: r["period_start"] as string,
    periodEnd: r["period_end"] as string,
    status: r["status"] as string,
    sentAt: (r["sent_at"] as string | null) ?? null,
  }));
}

export async function listAccountFeedback(
  db: Db,
  accountProfileId: string,
): Promise<Record<string, unknown>[]> {
  const res = await db.execute(sql`
    SELECT f.id, f.opportunity_id, p.canonical_name, f.user_id, f.relevant,
      f.new_to_customer, f.timely, f.worth_pursuing, f.disposition_reason, f.notes, f.created_at
    FROM feedback f
    JOIN opportunities o ON o.id = f.opportunity_id
    JOIN projects p ON p.id = o.project_id
    WHERE o.account_profile_id = ${accountProfileId}
    ORDER BY f.created_at DESC LIMIT 200`);
  return res.rows as Record<string, unknown>[];
}

// ── Admin ────────────────────────────────────────────────────────────────────

export interface SourceAdminView {
  id: string;
  key: string;
  name: string;
  authority: string;
  county: string | null;
  enabled: boolean;
  freshnessState: string;
  lastSuccessAt: string | null;
  lastRun: {
    id: string;
    status: string;
    startedAt: string;
    parsedCount: number;
    rejectedCount: number;
    errorCount: number;
  } | null;
  recordCount: number;
}

export async function listSourcesAdmin(db: Db): Promise<SourceAdminView[]> {
  const res = await db.execute(sql`
    SELECT s.id, s.key, s.name, s.authority, s.county, s.enabled,
      COALESCE(ce.freshness_state, 'amber') AS freshness_state, ce.last_success_at,
      lr.id AS run_id, lr.status AS run_status, lr.started_at, lr.parsed_count,
      lr.rejected_count, lr.error_count,
      (SELECT count(*) FROM source_records sr WHERE sr.source_id = s.id) AS record_count
    FROM sources s
    LEFT JOIN coverage_entries ce ON ce.source_id = s.id
    LEFT JOIN LATERAL (
      SELECT id, status, started_at, parsed_count, rejected_count, error_count
      FROM source_runs WHERE source_id = s.id ORDER BY started_at DESC LIMIT 1
    ) lr ON true
    ORDER BY s.key`);
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    id: r["id"] as string,
    key: r["key"] as string,
    name: r["name"] as string,
    authority: r["authority"] as string,
    county: (r["county"] as string | null) ?? null,
    enabled: Boolean(r["enabled"]),
    freshnessState: r["freshness_state"] as string,
    lastSuccessAt: (r["last_success_at"] as string | null) ?? null,
    lastRun: r["run_id"]
      ? {
          id: r["run_id"] as string,
          status: r["run_status"] as string,
          startedAt: r["started_at"] as string,
          parsedCount: Number(r["parsed_count"]),
          rejectedCount: Number(r["rejected_count"]),
          errorCount: Number(r["error_count"]),
        }
      : null,
    recordCount: Number(r["record_count"]),
  }));
}

export async function sourceRunDetail(db: Db, runId: string): Promise<Record<string, unknown> | null> {
  const res = await db.execute(sql`
    SELECT sr.*, s.key AS source_key, s.name AS source_name,
      (SELECT count(*) FROM raw_artifacts ra WHERE ra.source_run_id = sr.id) AS artifact_count
    FROM source_runs sr JOIN sources s ON s.id = sr.source_id
    WHERE sr.id = ${runId}`);
  return (res.rows[0] as Record<string, unknown> | undefined) ?? null;
}

export async function listCoverage(db: Db): Promise<Record<string, unknown>[]> {
  const res = await db.execute(sql`
    SELECT ce.county, ce.permitting_jurisdiction, ce.status, ce.freshness_state,
      ce.last_success_at, ce.record_types, ce.notes, s.key AS source_key, s.name AS source_name
    FROM coverage_entries ce JOIN sources s ON s.id = ce.source_id
    ORDER BY ce.county NULLS LAST, s.key`);
  return res.rows as Record<string, unknown>[];
}

/** #3 — geometry coverage: per-county project geometry fill with provenance
 * split (record-derived vs Census-geocoded inference) + the geocodable and
 * attempted-but-unlocated backlogs. */
export interface GeometryCoverageRow {
  county: string;
  projects: number;
  withGeometry: number;
  fromRecords: number;
  fromGeocoder: number;
  geocodableBacklog: number;
  attemptedNoLocation: number;
}

export async function geometryCoverage(db: Db): Promise<GeometryCoverageRow[]> {
  const res = await db.execute(sql`
    SELECT county,
      count(*) AS projects,
      count(geometry) AS with_geometry,
      count(*) FILTER (WHERE geometry_source = 'source_record') AS from_records,
      count(*) FILTER (WHERE geometry_source = 'census_geocoder') AS from_geocoder,
      count(*) FILTER (WHERE geometry IS NULL AND address_normalized IS NOT NULL
        AND geocode_meta_json IS NULL) AS geocodable_backlog,
      count(*) FILTER (WHERE geometry IS NULL AND geocode_meta_json IS NOT NULL) AS attempted_no_location
    FROM projects
    WHERE permitting_jurisdiction != 'Test Jurisdiction'
    GROUP BY county ORDER BY county`);
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    county: r["county"] as string,
    projects: Number(r["projects"]),
    withGeometry: Number(r["with_geometry"]),
    fromRecords: Number(r["from_records"]),
    fromGeocoder: Number(r["from_geocoder"]),
    geocodableBacklog: Number(r["geocodable_backlog"]),
    attemptedNoLocation: Number(r["attempted_no_location"]),
  }));
}

// ── Private bid invitations (M4.6 — account-scoped, access-audited) ──────────

export interface InvitationView {
  recordId: string;
  externalId: string;
  title: string | null;
  scope: string | null;
  status: string | null;
  stage: string;
  address: string | null;
  county: string | null;
  bidDueDate: string | null;
  generalContractor: string | null;
  platform: string | null;
  receivedAt: string | null;
}

/**
 * The account's own bid invitations (records from ITS private sources only —
 * the SQL is scoped by sources.account_profile_id, so no other account's
 * inbox is reachable from here). Every call appends artifact_access_log rows
 * (spec §20: audit access to customer invitation artifacts).
 */
export async function listAccountInvitations(
  db: Db,
  accountProfileId: string,
  accessedBy: string,
): Promise<InvitationView[]> {
  const res = await db.execute(sql`
    SELECT sr.id, sr.external_id, sr.raw_artifact_id,
      sr.normalized_json->>'title' AS title,
      sr.normalized_json->>'description' AS scope,
      sr.normalized_json->>'statusRaw' AS status,
      sr.normalized_json->>'normalizedStage' AS stage,
      sr.normalized_json->>'addressRaw' AS address,
      sr.normalized_json->>'county' AS county,
      sr.raw_fields_json->>'bid_due_date' AS bid_due_date,
      sr.raw_fields_json->>'general_contractor' AS gc,
      sr.raw_fields_json->>'platform' AS platform,
      sr.raw_fields_json->>'received_at' AS received_at
    FROM source_records sr
    JOIN sources s ON s.id = sr.source_id
    WHERE s.account_profile_id = ${accountProfileId}
      AND sr.record_type = 'bid_invitation'
    ORDER BY sr.last_seen_at DESC
    LIMIT 200`);
  const rows = res.rows as Record<string, unknown>[];

  // Spec §20 access audit — one row per distinct private artifact read.
  const artifactIds = [...new Set(rows.map((r) => r["raw_artifact_id"] as string))];
  for (const rawArtifactId of artifactIds) {
    await db.execute(sql`
      INSERT INTO artifact_access_log (raw_artifact_id, account_profile_id, accessed_by, purpose)
      VALUES (${rawArtifactId}, ${accountProfileId}, ${accessedBy}, 'invitation_list_view')`);
  }

  return rows.map((r) => ({
    recordId: r["id"] as string,
    externalId: r["external_id"] as string,
    title: (r["title"] as string | null) ?? null,
    scope: (r["scope"] as string | null) ?? null,
    status: (r["status"] as string | null) ?? null,
    stage: (r["stage"] as string | null) ?? "unknown",
    address: (r["address"] as string | null) ?? null,
    county: (r["county"] as string | null) ?? null,
    bidDueDate: (r["bid_due_date"] as string | null) ?? null,
    generalContractor: (r["gc"] as string | null) ?? null,
    platform: (r["platform"] as string | null) ?? null,
    receivedAt: (r["received_at"] as string | null) ?? null,
  }));
}
