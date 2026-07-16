import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";
import {
  decideInclusion,
  evaluateGate,
  latestExtraction,
  latestVerification,
  type GateResult,
  type InclusionDecision,
} from "@otn/intelligence";

/**
 * Weekly digest (spec §18). Only opportunities that pass the full §15
 * publication gate may enter a digest; everything else is counted and
 * disclosed in the coverage/caveat section, never silently dropped. "New" is
 * a delivery-history fact, not a scoring fact: an opportunity is new only on
 * its first-ever inclusion for that account — an unchanged repeated project
 * is never labeled new (spec §18).
 */

export interface DigestItem {
  opportunityId: string;
  /** M4.3/M4.4 — auto items enter customer sections; review_required items
   * are withheld into the reviewQueue (count disclosed in section 5). */
  inclusion: InclusionDecision;
  projectId: string;
  projectName: string;
  stage: string;
  county: string;
  jurisdiction: string;
  score: number | null;
  route: string | null;
  isNew: boolean;
  whatChanged: string;
  whyItFits: string;
  confirmedFacts: string[];
  inferences: string[];
  missingCriticalFacts: string[];
  nextAction: string;
  sourceLinks: { url: string; label: string }[];
  eventIds: string[];
}

export interface CoverageCaveat {
  sourceKey: string;
  sourceName: string;
  freshnessState: string;
}

export interface DigestModel {
  accountProfileId: string;
  accountKey: string;
  accountName: string;
  periodStart: Date;
  periodEnd: Date;
  sections: {
    priorityNew: DigestItem[];
    stageChanges: DigestItem[];
    missingFacts: DigestItem[];
    monitoring: DigestItem[];
    coverage: CoverageCaveat[];
  };
  /** Gate-passing items withheld from automation for a human decision. */
  reviewQueue: DigestItem[];
  suppressed: { gateFailed: number; blockedOnVerifier: number };
  ruleVersions: Record<string, number>;
  candidateCount: number;
}

interface CandidateRow {
  id: string;
  project_id: string;
  canonical_name: string;
  county: string;
  permitting_jurisdiction: string;
  current_stage: string;
  current_score: number | null;
  route: string | null;
  state: string;
  rationale_json: { signals?: string[]; route?: string } | null;
  text: string;
  max_valuation: number | null;
}

async function loadCandidates(db: Db, accountProfileId: string): Promise<CandidateRow[]> {
  const res = await db.execute(sql`
    SELECT o.id, o.project_id, p.canonical_name, p.county, p.permitting_jurisdiction,
      p.current_stage, o.current_score, o.route, o.state, o.rationale_json,
      COALESCE(rec.text, lower(p.canonical_name)) AS text, rec.max_valuation
    FROM opportunities o JOIN projects p ON p.id = o.project_id
    LEFT JOIN LATERAL (
      SELECT lower(string_agg(concat_ws(' ',
          sr.normalized_json->>'title', left(sr.normalized_json->>'description', 800)), ' ')) AS text,
        max((sr.normalized_json->>'valuationUsd')::numeric)::float AS max_valuation
      FROM record_resolutions rr JOIN source_records sr ON sr.id = rr.source_record_id
      WHERE rr.project_id = p.id AND rr.status = 'active'
    ) rec ON true
    WHERE o.account_profile_id = ${accountProfileId}
      AND o.state IN ('priority_review', 'weekly_digest', 'promoted')
    ORDER BY o.current_score DESC NULLS LAST
    LIMIT 500`);
  return res.rows as unknown as CandidateRow[];
}

/** Opportunity IDs this account has ever been sent (any prior delivery). */
async function previouslyDelivered(db: Db, accountProfileId: string): Promise<Set<string>> {
  const res = await db.execute(sql`
    SELECT DISTINCT di.opportunity_id
    FROM delivery_items di JOIN deliveries d ON d.id = di.delivery_id
    WHERE d.account_profile_id = ${accountProfileId}`);
  return new Set((res.rows as { opportunity_id: string }[]).map((r) => r.opportunity_id));
}

async function materialEventsInPeriod(
  db: Db,
  projectId: string,
  start: Date,
  end: Date,
): Promise<{ id: string; eventType: string; at: string; resultingStage: string | null }[]> {
  const res = await db.execute(sql`
    SELECT id, event_type, COALESCE(event_date, observed_at) AS at, resulting_stage
    FROM project_events
    WHERE project_id = ${projectId} AND material_change = true
      AND COALESCE(event_date, observed_at) >= ${start.toISOString()}
      AND COALESCE(event_date, observed_at) < ${end.toISOString()}
    ORDER BY COALESCE(event_date, observed_at) DESC`);
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    id: r["id"] as string,
    eventType: r["event_type"] as string,
    at: r["at"] as string,
    resultingStage: (r["resulting_stage"] as string | null) ?? null,
  }));
}

async function sourceLinks(db: Db, projectId: string): Promise<{ url: string; label: string }[]> {
  const res = await db.execute(sql`
    SELECT DISTINCT ei.source_url, s.name
    FROM record_resolutions rr
    JOIN evidence_items ei ON ei.source_record_id = rr.source_record_id
    JOIN raw_artifacts ra ON ra.id = ei.raw_artifact_id
    JOIN sources s ON s.id = ra.source_id
    WHERE rr.project_id = ${projectId} AND rr.status = 'active'
    LIMIT 5`);
  return (res.rows as { source_url: string; name: string }[]).map((r) => ({
    url: r.source_url,
    label: r.name,
  }));
}

function nextAction(item: { isNew: boolean; missing: string[]; state: string }): string {
  if (item.missing.length > 0) {
    return `Verify missing critical facts before outreach: ${item.missing.join(", ")}.`;
  }
  if (item.state === "priority_review" || item.state === "promoted") {
    return "Review evidence and decide pursue/dismiss.";
  }
  return "Monitor for stage changes.";
}

async function buildItem(
  db: Db,
  c: CandidateRow,
  opts: { isNew: boolean; periodStart: Date; periodEnd: Date; gate: GateResult },
): Promise<DigestItem> {
  const [events, links, extraction, verification] = await Promise.all([
    materialEventsInPeriod(db, c.project_id, opts.periodStart, opts.periodEnd),
    sourceLinks(db, c.project_id),
    latestExtraction(db, c.project_id),
    latestVerification(db, c.project_id),
  ]);
  const inclusion = decideInclusion({
    gate: opts.gate,
    extraction: extraction?.extraction ?? null,
    verification: verification
      ? { status: verification.status, result: verification.result }
      : null,
    route: c.route,
    state: c.state,
    maxValuation: c.max_valuation === null ? null : Number(c.max_valuation),
    stage: c.current_stage,
    text: c.text ?? "",
  });
  const facts = extraction?.extraction.facts ?? [];
  const inferences = extraction?.extraction.inferences ?? [];
  const missing = extraction?.extraction.missingCriticalFacts ?? [];

  const whatChanged =
    events.length > 0
      ? events
          .map((e) => `${e.eventType}${e.resultingStage ? ` → ${e.resultingStage}` : ""} (${e.at.slice(0, 10)})`)
          .join("; ")
      : opts.isNew
        ? "first time in your digest"
        : "no change since your last digest";

  const signals = c.rationale_json?.signals ?? [];
  const whyItFits = [c.route ? `route: ${c.route}` : null, signals.length ? `signals: ${signals.join(", ")}` : null]
    .filter(Boolean)
    .join(" · ");

  return {
    opportunityId: c.id,
    inclusion,
    projectId: c.project_id,
    projectName: c.canonical_name,
    stage: c.current_stage,
    county: c.county,
    jurisdiction: c.permitting_jurisdiction,
    score: c.current_score,
    route: c.route,
    isNew: opts.isNew,
    whatChanged,
    whyItFits: whyItFits || "matched account routing rules",
    confirmedFacts: facts.map((f) => `${f.path} = ${JSON.stringify(f.value)}`),
    inferences: inferences.map((i) => `[inference] ${i.type} = ${JSON.stringify(i.value)} (${i.reason})`),
    missingCriticalFacts: missing,
    nextAction: nextAction({ isNew: opts.isNew, missing, state: c.state }),
    sourceLinks: links,
    eventIds: events.map((e) => e.id),
  };
}

async function coverageCaveats(db: Db): Promise<CoverageCaveat[]> {
  const res = await db.execute(sql`
    SELECT s.key, s.name, ce.freshness_state
    FROM coverage_entries ce JOIN sources s ON s.id = ce.source_id
    WHERE ce.freshness_state != 'green' AND ce.status = 'enabled'
    ORDER BY s.key`);
  return (res.rows as { key: string; name: string; freshness_state: string }[]).map((r) => ({
    sourceKey: r.key,
    sourceName: r.name,
    freshnessState: r.freshness_state,
  }));
}

async function accountInfo(
  db: Db,
  accountProfileId: string,
): Promise<{ key: string; name: string; ruleVersions: Record<string, number> }> {
  const res = await db.execute(
    sql`SELECT key, name FROM account_profiles WHERE id = ${accountProfileId}`,
  );
  const row = res.rows[0] as { key: string; name: string } | undefined;
  if (!row) throw new Error(`account ${accountProfileId} not found`);
  const rules = await db.execute(sql`
    SELECT rule_type, max(version) AS version FROM account_rules
    WHERE account_profile_id = ${accountProfileId} GROUP BY rule_type`);
  const ruleVersions: Record<string, number> = {};
  for (const r of rules.rows as { rule_type: string; version: number }[]) {
    ruleVersions[r.rule_type] = Number(r.version);
  }
  return { key: row.key, name: row.name, ruleVersions };
}

export async function buildDigest(
  db: Db,
  accountProfileId: string,
  period: { start: Date; end: Date },
): Promise<DigestModel> {
  const account = await accountInfo(db, accountProfileId);
  const [candidates, delivered, coverage] = await Promise.all([
    loadCandidates(db, accountProfileId),
    previouslyDelivered(db, accountProfileId),
    coverageCaveats(db),
  ]);

  const sections: DigestModel["sections"] = {
    priorityNew: [],
    stageChanges: [],
    missingFacts: [],
    monitoring: [],
    coverage,
  };
  const reviewQueue: DigestItem[] = [];
  const suppressed = { gateFailed: 0, blockedOnVerifier: 0 };

  for (const c of candidates) {
    const gate: GateResult | null = await evaluateGate(db, c.id);
    if (!gate || gate.status !== "pass") {
      if (gate?.status === "blocked_on_verifier") suppressed.blockedOnVerifier++;
      else suppressed.gateFailed++;
      continue;
    }
    const isNew = !delivered.has(c.id);
    const item = await buildItem(db, c, {
      isNew,
      periodStart: period.start,
      periodEnd: period.end,
      gate,
    });

    // M4.3/M4.4 — controlled automation: only independently verified,
    // high-confidence, non-high-risk items enter customer sections; the rest
    // wait for a human (promote to include, dismiss to drop).
    if (item.inclusion.mode === "review_required") {
      reviewQueue.push(item);
      continue;
    }

    // Exclusive section order (spec §18): priority-new > stage change >
    // missing-fact queue > monitoring.
    if (isNew && (c.state === "priority_review" || c.state === "promoted")) {
      sections.priorityNew.push(item);
    } else if (item.eventIds.length > 0) {
      sections.stageChanges.push(item);
    } else if (item.missingCriticalFacts.length > 0) {
      sections.missingFacts.push(item);
    } else {
      sections.monitoring.push(item);
    }
  }

  return {
    accountProfileId,
    accountKey: account.key,
    accountName: account.name,
    periodStart: period.start,
    periodEnd: period.end,
    sections,
    reviewQueue,
    suppressed,
    ruleVersions: account.ruleVersions,
    candidateCount: candidates.length,
  };
}
