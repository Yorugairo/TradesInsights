import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";
import type { ModelExtraction } from "../extraction/contract.js";
import { latestExtraction, latestVerification } from "./verify.js";

/**
 * Spec §15 publication gate — every check is a deterministic query over
 * stored rows; the only model-dependent input is the independent verifier's
 * stored verdict. An opportunity may enter a digest only when every check
 * passes. Without model keys the gate reports `blocked_on_verifier` — a
 * visible blocked state, never a silent pass or fail.
 */

/** §15 "active/current for the relevant trade timing" window (days). */
const TIMING_WINDOW_DAYS = 180;

export interface GateCheck {
  name: string;
  /** null = cannot be evaluated yet (verifier blocked). */
  pass: boolean | null;
  detail: string;
}

export interface GateResult {
  opportunityId: string;
  projectId: string;
  accountProfileId: string;
  status: "pass" | "fail" | "blocked_on_verifier";
  publishable: boolean;
  checks: GateCheck[];
}

interface OpportunityRow {
  id: string;
  project_id: string;
  account_profile_id: string;
  current_score: number | null;
  state: string;
  weekly_digest_min: number;
}

async function loadOpportunity(db: Db, opportunityId: string): Promise<OpportunityRow | null> {
  const res = await db.execute(sql`
    SELECT o.id, o.project_id, o.account_profile_id, o.current_score, o.state,
      COALESCE((ap.delivery_config_json->>'weekly_digest_min')::float, 65) AS weekly_digest_min
    FROM opportunities o
    JOIN account_profiles ap ON ap.id = o.account_profile_id
    WHERE o.id = ${opportunityId}`);
  return (res.rows[0] as OpportunityRow | undefined) ?? null;
}

/** §15: "Source is healthy" / "Suppress any delivery supported only by a red source." */
async function checkSourceHealth(db: Db, projectId: string): Promise<GateCheck> {
  const res = await db.execute(sql`
    SELECT ce.freshness_state, count(*) AS n
    FROM record_resolutions rr
    JOIN source_records sr ON sr.id = rr.source_record_id
    JOIN coverage_entries ce ON ce.source_id = sr.source_id
    WHERE rr.project_id = ${projectId} AND rr.status = 'active'
    GROUP BY ce.freshness_state`);
  const states = (res.rows as { freshness_state: string; n: string | number }[]).map(
    (r) => r.freshness_state,
  );
  if (states.length === 0) {
    return { name: "source_health", pass: false, detail: "no supporting sources found" };
  }
  const nonRed = states.filter((s) => s !== "red");
  return nonRed.length > 0
    ? { name: "source_health", pass: true, detail: `supporting source states: ${states.join(", ")}` }
    : { name: "source_health", pass: false, detail: "supported only by red source(s) — suppressed" };
}

/** §15: "Project identity, geography, stage, and event date exist." */
async function checkIdentity(db: Db, projectId: string): Promise<GateCheck> {
  const res = await db.execute(sql`
    SELECT p.canonical_name, p.county, p.permitting_jurisdiction, p.current_stage,
      (SELECT count(*) FROM project_events pe
        WHERE pe.project_id = p.id AND COALESCE(pe.event_date, pe.observed_at) IS NOT NULL) AS dated_events
    FROM projects p WHERE p.id = ${projectId}`);
  const p = res.rows[0] as
    | { canonical_name: string; county: string; permitting_jurisdiction: string; current_stage: string; dated_events: string | number }
    | undefined;
  if (!p) return { name: "identity_complete", pass: false, detail: "project not found" };
  const missing: string[] = [];
  if (!p.canonical_name?.trim()) missing.push("identity");
  if (!p.county || !p.permitting_jurisdiction) missing.push("geography");
  if (!p.current_stage || p.current_stage === "unknown") missing.push("stage");
  if (Number(p.dated_events) === 0) missing.push("event date");
  return missing.length === 0
    ? { name: "identity_complete", pass: true, detail: "identity, geography, stage, event date present" }
    : { name: "identity_complete", pass: false, detail: `missing: ${missing.join(", ")}` };
}

/** §15: "At least one A-grade source supports the core event." */
/**
 * EXPORTED FOR THE EVIDENCE AUDIT ONLY. `evaluateGate` remains the entry point
 * for deciding whether anything may be delivered — this is exposed so the audit
 * can ask the gate's own question of linked evidence instead of reimplementing
 * it in SQL, which is how two surfaces start disagreeing about the same rule.
 */
export async function checkAGradeCoreEvent(db: Db, projectId: string): Promise<GateCheck> {
  // Core event = the most recent material event (falls back to the most
  // recent event of any kind when none is flagged material).
  const res = await db.execute(sql`
    WITH core AS (
      SELECT pe.source_record_id
      FROM project_events pe
      WHERE pe.project_id = ${projectId}
      ORDER BY pe.material_change DESC, COALESCE(pe.event_date, pe.observed_at) DESC
      LIMIT 1)
    SELECT
      (SELECT count(*) FROM core) AS has_event,
      (SELECT count(*) FROM evidence_items ei JOIN core c ON ei.source_record_id = c.source_record_id
        WHERE ei.authority_grade = 'A') AS a_grade`);
  const row = res.rows[0] as { has_event: string | number; a_grade: string | number };
  if (Number(row.has_event) === 0) {
    return { name: "a_grade_core_event", pass: false, detail: "no core event" };
  }
  return Number(row.a_grade) > 0
    ? { name: "a_grade_core_event", pass: true, detail: `${row.a_grade} A-grade evidence row(s) on core event` }
    : { name: "a_grade_core_event", pass: false, detail: "core event lacks A-grade evidence" };
}

/**
 * §15: "Every fact has evidence." Deterministic layer: every active record
 * backing the project carries evidence rows. Model layer (§11 grades): every
 * extracted fact cites evidence that exists, is never D-grade
 * (discovery-only), and C-grade only counts with non-C corroboration on the
 * same fact path.
 */
export async function checkFactsEvidenced(
  db: Db,
  projectId: string,
  extraction: ModelExtraction | null,
): Promise<GateCheck> {
  const bare = await db.execute(sql`
    SELECT count(*) AS n
    FROM record_resolutions rr
    WHERE rr.project_id = ${projectId} AND rr.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM evidence_items ei WHERE ei.source_record_id = rr.source_record_id)`);
  const bareCount = Number((bare.rows[0] as { n: string | number }).n);
  if (bareCount > 0) {
    return {
      name: "facts_evidenced",
      pass: false,
      detail: `${bareCount} supporting record(s) carry no evidence rows`,
    };
  }
  if (!extraction || extraction.facts.length === 0) {
    return { name: "facts_evidenced", pass: true, detail: "all supporting records evidenced; no model facts" };
  }

  const grades = await db.execute(sql`
    SELECT ei.id, ei.authority_grade, ei.fact_path
    FROM record_resolutions rr
    JOIN evidence_items ei ON ei.source_record_id = rr.source_record_id
    WHERE rr.project_id = ${projectId} AND rr.status = 'active'`);
  const byId = new Map(
    (grades.rows as { id: string; authority_grade: string; fact_path: string }[]).map((r) => [
      r.id,
      r,
    ]),
  );
  const problems: string[] = [];
  for (const fact of extraction.facts) {
    const ev = byId.get(fact.evidenceId);
    if (!ev) {
      problems.push(`${fact.path}: cited evidence no longer active on this project`);
      continue;
    }
    if (ev.authority_grade === "D") {
      problems.push(`${fact.path}: D-grade evidence is never customer-publishable`);
    } else if (ev.authority_grade === "C") {
      const corroborated = [...byId.values()].some(
        (o) => o.fact_path === ev.fact_path && o.id !== ev.id && o.authority_grade !== "C",
      );
      if (!corroborated) problems.push(`${fact.path}: C-grade evidence is never sufficient alone`);
    }
  }
  return problems.length === 0
    ? { name: "facts_evidenced", pass: true, detail: `${extraction.facts.length} model fact(s) evidenced within grade rules` }
    : { name: "facts_evidenced", pass: false, detail: problems.join("; ") };
}

/** §15: "Inferences are separately labeled." A fact not marked confirmed belongs in inferences. */
function checkInferencesLabeled(extraction: ModelExtraction | null): GateCheck {
  if (!extraction) {
    return { name: "inferences_labeled", pass: true, detail: "no model output — nothing mislabeled" };
  }
  const mislabeled = extraction.facts.filter((f) => !f.confirmed);
  return mislabeled.length === 0
    ? {
        name: "inferences_labeled",
        pass: true,
        detail: `${extraction.inferences.length} inference(s) separately labeled`,
      }
    : {
        name: "inferences_labeled",
        pass: false,
        detail: `unconfirmed claim(s) presented as facts: ${mislabeled.map((f) => f.path).join(", ")}`,
      };
}

/** §15: "No unresolved identity contradiction exists." */
async function checkNoContradiction(db: Db, projectId: string): Promise<GateCheck> {
  const res = await db.execute(sql`
    SELECT count(*) AS n FROM resolution_reviews rv
    WHERE rv.status = 'pending'
      AND (rv.candidate_project_id = ${projectId}
        OR rv.source_record_id IN (
          SELECT rr.source_record_id FROM record_resolutions rr
          WHERE rr.project_id = ${projectId} AND rr.status = 'active'))`);
  const n = Number((res.rows[0] as { n: string | number }).n);
  return n === 0
    ? { name: "no_identity_contradiction", pass: true, detail: "no pending identity reviews" }
    : { name: "no_identity_contradiction", pass: false, detail: `${n} pending identity review(s) touch this project` };
}

/** §15: "Record is active/current for the relevant trade timing." */
async function checkTiming(db: Db, projectId: string): Promise<GateCheck> {
  const res = await db.execute(sql`
    SELECT max(COALESCE(pe.event_date, pe.observed_at)) AS last_at
    FROM project_events pe WHERE pe.project_id = ${projectId}`);
  const lastAt = (res.rows[0] as { last_at: string | null }).last_at;
  if (!lastAt) return { name: "timing_current", pass: false, detail: "no dated events" };
  const ageDays = (Date.now() - new Date(lastAt).getTime()) / 86_400_000;
  return ageDays <= TIMING_WINDOW_DAYS
    ? { name: "timing_current", pass: true, detail: `last activity ${Math.round(ageDays)}d ago` }
    : {
        name: "timing_current",
        pass: false,
        detail: `stale: last activity ${Math.round(ageDays)}d ago (> ${TIMING_WINDOW_DAYS}d)`,
      };
}

/** §15: "Account score clears threshold." */
function checkScore(opp: OpportunityRow): GateCheck {
  if (opp.current_score === null) {
    return { name: "score_threshold", pass: false, detail: "no score recorded" };
  }
  return opp.current_score >= opp.weekly_digest_min
    ? {
        name: "score_threshold",
        pass: true,
        detail: `score ${opp.current_score} ≥ digest threshold ${opp.weekly_digest_min}`,
      }
    : {
        name: "score_threshold",
        pass: false,
        detail: `score ${opp.current_score} below digest threshold ${opp.weekly_digest_min}`,
      };
}

/**
 * §15: "Independent verifier passes." Requires a succeeded extraction AND a
 * succeeded verification whose verdicts are all supported. Missing or blocked
 * model runs yield pass=null → the gate reports blocked_on_verifier.
 */
async function checkVerifier(db: Db, projectId: string): Promise<GateCheck> {
  const extraction = await latestExtraction(db, projectId);
  if (!extraction) {
    return {
      name: "verifier",
      pass: null,
      detail: "no succeeded extraction — model pipeline blocked or not yet run",
    };
  }
  const verification = await latestVerification(db, projectId);
  if (!verification || verification.status === "blocked") {
    return { name: "verifier", pass: null, detail: "verification blocked or not yet run" };
  }
  if (verification.status !== "succeeded" || !verification.result) {
    return { name: "verifier", pass: false, detail: `latest verification ${verification.status}` };
  }
  const unsupported = verification.result.verdicts.filter((v) => !v.supported);
  return unsupported.length === 0
    ? { name: "verifier", pass: true, detail: `${verification.result.verdicts.length} verdict(s), all supported` }
    : {
        name: "verifier",
        pass: false,
        detail: `unsupported fact(s) rejected by verifier: ${unsupported.map((v) => v.path).join(", ")}`,
      };
}

export async function evaluateGate(db: Db, opportunityId: string): Promise<GateResult | null> {
  const opp = await loadOpportunity(db, opportunityId);
  if (!opp) return null;
  const projectId = opp.project_id;
  const extraction = (await latestExtraction(db, projectId))?.extraction ?? null;

  const checks: GateCheck[] = [
    await checkSourceHealth(db, projectId),
    await checkIdentity(db, projectId),
    await checkAGradeCoreEvent(db, projectId),
    await checkFactsEvidenced(db, projectId, extraction),
    checkInferencesLabeled(extraction),
    await checkNoContradiction(db, projectId),
    await checkTiming(db, projectId),
    checkScore(opp),
    await checkVerifier(db, projectId),
  ];

  const anyFail = checks.some((c) => c.pass === false);
  const anyBlocked = checks.some((c) => c.pass === null);
  const status = anyFail ? "fail" : anyBlocked ? "blocked_on_verifier" : "pass";
  return {
    opportunityId,
    projectId,
    accountProfileId: opp.account_profile_id,
    status,
    publishable: status === "pass",
    checks,
  };
}
