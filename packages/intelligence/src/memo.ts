import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { stageOrder } from "@otn/resolution";
import type { Db } from "@otn/db";
import { latestRules } from "./accounts.js";
import { evaluateGate } from "./gate/gate.js";
import { permitClassOf, stageLagEstimate } from "./stage-lag.js";
import { latestExtraction, latestVerification } from "./gate/verify.js";

/**
 * S1 (strengthening addendum §3) — the opportunity decision memo. A deterministic
 * assembly over stored rows: score components (rationale_json), capacity (§5),
 * publication gate + independent verifier, and model extraction (facts vs
 * inferences vs missing). Prose fields have deterministic skeletons so the memo
 * is fully functional without model keys; richer narrative is a key-gated
 * enhancement. Invariants: the final score is the stored deterministic number
 * (prose never sets it); confirmed facts carry evidence; inferences are labeled;
 * `bidding_confirmed` is only ever surfaced when the stored stage says so (a
 * permit is never a bid); missing facts are never guessed.
 */

export type ProcurementState =
  | "unknown"
  | "relationship_radar"
  | "monitoring"
  | "bidding_confirmed"
  | "late_or_closed";

export interface DecisionMemoScoreComponent {
  key: string;
  value: number;
  weight: number;
  reason: string;
  evidenceIds: string[];
}

export interface DecisionMemo {
  opportunityId: string;
  accountProfileId: string;
  projectId: string;
  generatedAt: string;
  decisionVersion: number;

  summary: string;
  whatChanged: string;
  whyItFits: string;
  timingAssessment: string;
  recommendedAction: string;

  route: string | null;
  score: number | null;
  scoreComponents: DecisionMemoScoreComponent[];

  confirmedFacts: { path: string; value: unknown; evidenceIds: string[] }[];
  inferences: { type: string; value: unknown; confidence: number; reason: string; evidenceIds: string[] }[];
  missingCriticalFacts: { key: string; importance: "blocking" | "high" | "normal"; suggestedVerification: string }[];

  procurementState: ProcurementState;
  capacityAssessment: string;
  capacityExplanation: string | null;
  /** P2.4 — evidence-only outreach prep: bullets the owner copies into their
   * OWN call/text. Deterministic (roles/dates/valuations from stored rows);
   * never model prose, never sent anywhere by the system. */
  talkingPoints: string[];

  verifierStatus: "pending" | "passed" | "failed";
  verifierIssues: string[];
}

interface OppRow {
  id: string;
  account_profile_id: string;
  project_id: string;
  current_score: number | null;
  route: string | null;
  state: string;
  rationale_json: {
    components?: Record<string, number>;
    signals?: string[];
    capacity?: { assessment?: string; explanation?: string };
  } | null;
  canonical_name: string;
  county: string;
  permitting_jurisdiction: string;
  current_stage: string;
  last_material_at: string | null;
}

const COMPONENT_REASON: Record<string, string> = {
  product_fit: "match between the project's scope and the account's product line",
  repeatable_units_or_builder_value: "repeatable units / builder relationship value",
  division_08_system_fit: "fit for the account's Division 08 glazing systems",
  scale_value: "project scale and valuation",
  trade_fit: "fit for the account's interior trade scope",
  package_size_fit: "estimated package size vs the account's job-size range",
  timing: "trade-specific stage timing and recency",
  territory: "project falls in the account's territory",
  geography: "project falls in the account's territory",
  builder_developer_identified: "a named builder/developer is on the record",
  gc_developer_architect_known: "a named GC/developer/architect is on the record",
  evidence_quality: "presence of A-grade source evidence",
};

function procurementStateFor(stage: string, route: string | null): ProcurementState {
  if (stage === "bidding_confirmed") return "bidding_confirmed";
  if (route === "gc_relationship_radar") return "relationship_radar";
  if (stageOrder(stage) >= stageOrder("near_final")) return "late_or_closed";
  if (stageOrder(stage) >= stageOrder("permit_issued")) return "monitoring";
  return "unknown";
}

function timingAssessment(stage: string, lastAt: string | null): string {
  if (!lastAt) return `Stage ${stage}; no dated activity on record — timing not established.`;
  const days = Math.round((Date.now() - new Date(lastAt).getTime()) / 86_400_000);
  const window = days <= 180 ? "within the active window" : "older than 180 days — radar only";
  return `Stage ${stage}; last activity ${days} day${days === 1 ? "" : "s"} ago (${window}).`;
}

function recommendedAction(input: {
  state: string;
  missing: number;
  procurement: ProcurementState;
  capacity: string | undefined;
}): string {
  if (input.capacity === "excluded") return "Do not pursue — capacity exclusion (see capacity note).";
  if (input.procurement === "relationship_radar" || input.capacity === "likely_too_large")
    return "Track as a GC-relationship radar target, not a direct bid.";
  if (input.missing > 0) return "Verify the missing critical facts before outreach.";
  if (input.state === "priority_review" || input.state === "promoted")
    return "Review the evidence and decide pursue / dismiss.";
  return "Monitor for the next material stage change.";
}

async function loadOpp(db: Db, opportunityId: string): Promise<OppRow | null> {
  const res = await db.execute(sql`
    SELECT o.id, o.account_profile_id, o.project_id, o.current_score, o.route, o.state,
      o.rationale_json, p.canonical_name, p.county, p.permitting_jurisdiction, p.current_stage,
      (SELECT max(COALESCE(pe.event_date, pe.observed_at)) FROM project_events pe
        WHERE pe.project_id = p.id) AS last_material_at
    FROM opportunities o JOIN projects p ON p.id = o.project_id
    WHERE o.id = ${opportunityId}`);
  return (res.rows[0] as OppRow | undefined) ?? null;
}

/** P2.4 — deterministic outreach-prep bullets from stored roles/facts. */
async function talkingPointsFor(
  db: Db,
  projectId: string,
  o: { canonical_name: string; current_stage: string; last_material_at: string | null },
): Promise<string[]> {
  const roles = await db.execute(sql`
    SELECT org.canonical_name AS name, pr.role
    FROM project_roles pr JOIN organizations org ON org.id = pr.organization_id
    WHERE pr.project_id = ${projectId} AND pr.confirmed = true
    ORDER BY CASE pr.role WHEN 'primary_contractor' THEN 0 WHEN 'applicant' THEN 1
      WHEN 'owner' THEN 2 ELSE 3 END
    LIMIT 3`);
  const val = await db.execute(sql`
    SELECT max((sr.normalized_json->>'valuationUsd')::numeric) AS v,
      max(sr.normalized_json->>'issueDate') AS issued
    FROM record_resolutions rr JOIN source_records sr ON sr.id = rr.source_record_id
    WHERE rr.project_id = ${projectId} AND rr.status = 'active'`);
  const campus = await db.execute(
    sql`SELECT campus_block FROM projects WHERE id = ${projectId}`,
  );
  const v = (val.rows[0] as { v: string | null; issued: string | null } | undefined) ?? {
    v: null,
    issued: null,
  };
  const points: string[] = [];
  for (const r of roles.rows as { name: string; role: string }[]) {
    points.push(`${r.name} is on record as ${r.role.replaceAll("_", " ")}.`);
  }
  points.push(`Project stage: ${o.current_stage.replaceAll("_", " ")}${v.issued ? `, permit issued ${v.issued}` : ""}${o.last_material_at ? `, last movement ${o.last_material_at.slice(0, 10)}` : ""}.`);
  if (v.v !== null) points.push(`Stated valuation on record: $${Number(v.v).toLocaleString("en-US")}.`);
  const cb = (campus.rows[0] as { campus_block: string | null } | undefined)?.campus_block;
  if (cb) {
    points.push(`Part of an active campus (parcel block ${cb.split(":")[1] ?? cb}) — repeat work at one site.`);
  }
  return points;
}

async function whatChangedFor(db: Db, projectId: string): Promise<string> {
  const res = await db.execute(sql`
    SELECT event_type, resulting_stage, COALESCE(event_date, observed_at) AS at
    FROM project_events
    WHERE project_id = ${projectId} AND material_change = true
    ORDER BY COALESCE(event_date, observed_at) DESC LIMIT 1`);
  const e = res.rows[0] as { event_type: string; resulting_stage: string | null; at: string } | undefined;
  if (!e) return "No material change recorded.";
  return `${e.event_type}${e.resulting_stage ? ` → ${e.resulting_stage}` : ""} (${e.at.slice(0, 10)}).`;
}

/** Assemble the decision memo for one opportunity (deterministic; no persistence). */
export async function buildDecisionMemo(db: Db, opportunityId: string): Promise<DecisionMemo | null> {
  const o = await loadOpp(db, opportunityId);
  if (!o) return null;

  const [gate, extraction, verification, rules, whatChanged] = await Promise.all([
    evaluateGate(db, opportunityId),
    latestExtraction(db, o.project_id),
    latestVerification(db, o.project_id),
    latestRules(db, o.account_profile_id),
    whatChangedFor(db, o.project_id),
  ]);

  const weightRows =
    (rules.get("scoring")?.rule["components"] as { component: string; weight: number }[] | undefined) ?? [];
  const weightByKey = new Map(weightRows.map((w) => [w.component, w.weight]));
  const components = o.rationale_json?.components ?? {};
  const scoreComponents: DecisionMemoScoreComponent[] = Object.entries(components).map(([key, value]) => ({
    key,
    value,
    weight: weightByKey.get(key) ?? 0,
    reason: COMPONENT_REASON[key] ?? key,
    // Component scores are computed over many features, not a single citable
    // row — attributing specific evidence IDs would be fabrication.
    evidenceIds: [],
  }));

  const facts = extraction?.extraction.facts ?? [];
  const inferences = extraction?.extraction.inferences ?? [];
  const missing = extraction?.extraction.missingCriticalFacts ?? [];

  let verifierStatus: DecisionMemo["verifierStatus"] = "pending";
  const verifierIssues: string[] = [];
  if (gate?.status === "pass") verifierStatus = "passed";
  else if (gate?.status === "fail") {
    verifierStatus = "failed";
    for (const c of gate.checks) if (c.pass === false) verifierIssues.push(`${c.name}: ${c.detail}`);
  } else if (verification && verification.status !== "succeeded") {
    verifierIssues.push(`verification ${verification.status}`);
  }

  const procurementState = procurementStateFor(o.current_stage, o.route);
  const capacity = o.rationale_json?.capacity;
  const signals = o.rationale_json?.signals ?? [];
  const talkingPoints = await talkingPointsFor(db, o.project_id, o);

  // P3.1 — pre-issuance timing gets the historical lag estimate (labeled
  // inference; only when the sample floor is met).
  let lagNote = "";
  if (["permit_applied", "approved", "entitlement", "preapplication"].includes(o.current_stage)) {
    const cls = await db.execute(sql`
      SELECT sr.normalized_json->>'applicationType' AS a, sr.normalized_json->>'permitType' AS pt
      FROM record_resolutions rr JOIN source_records sr ON sr.id = rr.source_record_id
      WHERE rr.project_id = ${o.project_id} AND rr.status = 'active'
      ORDER BY sr.last_seen_at DESC LIMIT 1`);
    const row = cls.rows[0] as { a: string | null; pt: string | null } | undefined;
    if (row) {
      const est = await stageLagEstimate(db, o.county, permitClassOf(row.a, row.pt));
      if (est) {
        lagNote = ` Historically, ${permitClassOf(row.a, row.pt)} permits in ${o.county} issue ~${Math.round(est.medianDays / 7)} weeks after application (p25–p75 ${Math.round(est.p25Days)}–${Math.round(est.p75Days)} days, n=${est.n}) — an inference from past lags, not a promise.`;
      }
    }
  }

  return {
    opportunityId: o.id,
    accountProfileId: o.account_profile_id,
    projectId: o.project_id,
    generatedAt: new Date().toISOString(),
    decisionVersion: 0, // set by persistDecisionMemo
    summary: `${o.canonical_name} — ${o.current_stage}, ${o.county}/${o.permitting_jurisdiction}, score ${o.current_score ?? "—"}${o.route ? ` (${o.route})` : ""}.`,
    whatChanged,
    whyItFits: [o.route ? `route: ${o.route}` : null, signals.length ? `signals: ${signals.join(", ")}` : null]
      .filter(Boolean)
      .join(" · ") || "matched account routing rules",
    timingAssessment: timingAssessment(o.current_stage, o.last_material_at) + lagNote,
    recommendedAction: recommendedAction({
      state: o.state,
      missing: missing.length,
      procurement: procurementState,
      capacity: capacity?.assessment,
    }),
    route: o.route,
    score: o.current_score,
    scoreComponents,
    confirmedFacts: facts.map((f) => ({ path: f.path, value: f.value, evidenceIds: [f.evidenceId] })),
    inferences: inferences.map((i) => ({
      type: i.type, value: i.value, confidence: i.confidence, reason: i.reason, evidenceIds: i.evidenceIds,
    })),
    missingCriticalFacts: missing.map((key) => ({
      key,
      importance: "high" as const,
      suggestedVerification: "Confirm from an authoritative source before outreach.",
    })),
    procurementState,
    capacityAssessment: capacity?.assessment ?? "unknown",
    capacityExplanation: capacity?.explanation ?? null,
    talkingPoints,
    verifierStatus,
    verifierIssues,
  };
}

/** Content hash over the memo's semantic fields (excludes generatedAt/version). */
function memoContentHash(memo: DecisionMemo): string {
  const { generatedAt: _g, decisionVersion: _v, ...semantic } = memo;
  return createHash("sha256").update(JSON.stringify(semantic)).digest("hex");
}

export interface PersistedMemo {
  memo: DecisionMemo;
  decisionVersion: number;
  created: boolean;
}

/**
 * Build + persist a memo, writing a new version ONLY when the semantic content
 * changed (regenerate is idempotent — an unchanged opportunity does not mint a
 * new version). Returns the latest memo either way.
 */
export async function persistDecisionMemo(db: Db, opportunityId: string): Promise<PersistedMemo | null> {
  const built = await buildDecisionMemo(db, opportunityId);
  if (!built) return null;
  const hash = memoContentHash(built);

  const prev = await db.execute(sql`
    SELECT decision_version, content_hash, memo_json FROM opportunity_decision_memos
    WHERE opportunity_id = ${opportunityId} ORDER BY decision_version DESC LIMIT 1`);
  const prevRow = prev.rows[0] as
    | { decision_version: number; content_hash: string; memo_json: DecisionMemo }
    | undefined;

  if (prevRow && prevRow.content_hash === hash) {
    return { memo: prevRow.memo_json, decisionVersion: Number(prevRow.decision_version), created: false };
  }

  const nextVersion = (prevRow ? Number(prevRow.decision_version) : 0) + 1;
  const memo: DecisionMemo = { ...built, decisionVersion: nextVersion };
  await db.execute(sql`
    INSERT INTO opportunity_decision_memos (opportunity_id, decision_version, content_hash, memo_json)
    VALUES (${opportunityId}, ${nextVersion}, ${hash}, ${JSON.stringify(memo)})`);
  return { memo, decisionVersion: nextVersion, created: true };
}

/** Latest persisted memo, or null if none has been generated yet. */
export async function latestDecisionMemo(db: Db, opportunityId: string): Promise<DecisionMemo | null> {
  const res = await db.execute(sql`
    SELECT memo_json FROM opportunity_decision_memos
    WHERE opportunity_id = ${opportunityId} ORDER BY decision_version DESC LIMIT 1`);
  return (res.rows[0] as { memo_json: DecisionMemo } | undefined)?.memo_json ?? null;
}
