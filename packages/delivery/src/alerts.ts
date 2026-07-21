import { sql } from "drizzle-orm";
import nodemailer from "nodemailer";
import type { Db } from "@otn/db";
import { COMMERCIAL_BUYOUT_STAGES, bidTrackFor, classify, type ProjectFeatures } from "@otn/intelligence";

/**
 * M4.7 — operational alerts (spec §21: "spend, health, stale-source, and
 * delivery alerts"). Every condition is a deterministic query; every fired
 * alert is a row in `alerts` with an idempotency key scoped to its period,
 * so scheduled re-evaluation never spams. Email (Mailpit locally) is
 * best-effort on top of the durable rows.
 */

export const SPEND_WARNING_RATIO = 0.8;

/**
 * WS-C phase-change alert tuning.
 * - Only `priority_review` opportunities qualify — band() (scoring §15) routes a
 *   score into that state only once it clears the account's priority floor
 *   (80–100 by default), so the state IS the account-aware "high bar". This is an
 *   URGENT, single-opportunity alert; the weekly digest carries everything else.
 * - Fire only on stage changes DETECTED (observed) inside the lookback so the
 *   daily run alerts on FRESH phase changes and never re-mines ancient history.
 *   observed_at (not the possibly-backdated official event_date) is the honest
 *   "when we learned of it" clock, so a permit whose official date predates
 *   detection still alerts on the run that discovers it. A 2-day (vs 1-day)
 *   window tolerates a skipped nightly run; the `:${day}` idempotency key bounds
 *   re-alerts to at most one per opportunity/stage/day.
 * - Residential interior trades bid AFTER the permit issues; commercial buys out
 *   pre-issuance across COMMERCIAL_BUYOUT_STAGES (bid-window.ts, one source of truth).
 */
const PHASE_CHANGE_PRIORITY_STATE = "priority_review";
const PHASE_CHANGE_LOOKBACK_DAYS = 2;
const RESIDENTIAL_BID_WINDOW_STAGE = "permit_issued";

export interface AlertCandidate {
  alertType: "spend_budget" | "source_red" | "source_stale" | "delivery_unsent" | "phase_change";
  subjectKey: string;
  severity: "warning" | "critical";
  message: string;
  details: Record<string, unknown>;
  idempotencyKey: string;
}

export interface AlertsRunSummary {
  evaluated: { spend: boolean; sources: number; deliveries: number };
  fired: AlertCandidate[];
  deduped: number;
  emailed: boolean;
}

const CADENCE_DAYS: Record<string, number> = { daily: 1, weekly: 7, monthly: 31 };

export async function evaluateAlertConditions(
  db: Db,
  opts: {
    monthlyBudgetUsd: number | null;
    now?: Date;
    /** D4 — source key → keys it provides substitute coverage for. */
    substitutes?: Record<string, string[]>;
  } = { monthlyBudgetUsd: null },
): Promise<{ candidates: AlertCandidate[]; sourcesChecked: number; deliveriesChecked: number }> {
  const now = opts.now ?? new Date();
  const substitutes = opts.substitutes ?? {};
  const day = now.toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  const candidates: AlertCandidate[] = [];

  // 1. Model spend vs monthly budget (spec §13 limits made visible).
  if (opts.monthlyBudgetUsd !== null && opts.monthlyBudgetUsd > 0) {
    const res = await db.execute(sql`
      SELECT COALESCE(sum(cost_usd), 0) AS spent FROM model_runs
      WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'utc')`);
    const spent = Number((res.rows[0] as { spent: string | number }).spent);
    const ratio = spent / opts.monthlyBudgetUsd;
    if (ratio >= 1) {
      candidates.push({
        alertType: "spend_budget",
        subjectKey: "llm_monthly",
        severity: "critical",
        message: `LLM monthly budget exhausted: $${spent.toFixed(2)} of $${opts.monthlyBudgetUsd} — model jobs are now blocked`,
        details: { spent, budget: opts.monthlyBudgetUsd, ratio },
        idempotencyKey: `spend_budget:llm_monthly:${month}:100`,
      });
    } else if (ratio >= SPEND_WARNING_RATIO) {
      candidates.push({
        alertType: "spend_budget",
        subjectKey: "llm_monthly",
        severity: "warning",
        message: `LLM monthly spend at ${Math.round(ratio * 100)}%: $${spent.toFixed(2)} of $${opts.monthlyBudgetUsd}`,
        details: { spent, budget: opts.monthlyBudgetUsd, ratio },
        idempotencyKey: `spend_budget:llm_monthly:${month}:80`,
      });
    }
  }

  // 2 + 3. Source health: red state (critical, re-alerts daily while red) and
  // staleness beyond 2× cadence (warning).
  const sources = await db.execute(sql`
    SELECT s.key, s.cadence, ce.freshness_state, ce.last_success_at
    FROM sources s JOIN coverage_entries ce ON ce.source_id = s.id
    WHERE s.enabled = true`);
  const sourceRows = sources.rows as {
    key: string;
    cadence: string;
    freshness_state: string;
    last_success_at: string | null;
  }[];
  for (const s of sourceRows) {
    if (s.freshness_state === "red") {
      // D4 — a red source that is the substitute feed for access-blocked
      // sources takes their fallback down with it: name the now-uncovered
      // dependents so the concentration risk is visible, not hidden.
      const dependents = substitutes[s.key] ?? [];
      const message =
        dependents.length > 0
          ? `Source ${s.key} is RED — and it is the substitute coverage for ${dependents.join(", ")}, which now have NO fallback`
          : `Source ${s.key} is RED — deliveries it solely supports are suppressed`;
      candidates.push({
        alertType: "source_red",
        subjectKey: s.key,
        severity: "critical",
        message,
        details: { lastSuccessAt: s.last_success_at, ...(dependents.length > 0 ? { mitigatedDependents: dependents } : {}) },
        idempotencyKey: `source_red:${s.key}:${day}`,
      });
    }
    const cadenceDays = CADENCE_DAYS[s.cadence];
    if (cadenceDays && s.last_success_at) {
      const ageDays = (now.getTime() - new Date(s.last_success_at).getTime()) / 86_400_000;
      if (ageDays > 2 * cadenceDays) {
        candidates.push({
          alertType: "source_stale",
          subjectKey: s.key,
          severity: "warning",
          message: `Source ${s.key} stale: last success ${Math.round(ageDays)}d ago (cadence ${s.cadence}, threshold ${2 * cadenceDays}d)`,
          details: { lastSuccessAt: s.last_success_at, ageDays, cadence: s.cadence },
          idempotencyKey: `source_stale:${s.key}:${day}`,
        });
      }
    }
  }

  // 4. Deliveries drafted but never sent well past their period.
  const drafts = await db.execute(sql`
    SELECT d.id, d.period_end, ap.key AS account_key
    FROM deliveries d JOIN account_profiles ap ON ap.id = d.account_profile_id
    WHERE d.status = 'draft' AND d.period_end < ${new Date(now.getTime() - 3 * 86_400_000).toISOString()}
      AND ap.active = true`);
  const draftRows = drafts.rows as { id: string; period_end: string; account_key: string }[];
  for (const d of draftRows) {
    candidates.push({
      alertType: "delivery_unsent",
      subjectKey: d.id,
      severity: "warning",
      message: `Digest for ${d.account_key} (period ending ${d.period_end.slice(0, 10)}) is still a draft 3+ days after period end`,
      details: { deliveryId: d.id, accountKey: d.account_key, periodEnd: d.period_end },
      idempotencyKey: `delivery_unsent:${d.id}`,
    });
  }

  // 5. Phase-change urgent alert (WS-C): a PRIORITY opportunity whose project
  // JUST entered its bid window on a recent material stage change. Rides the
  // existing daily alert run (no new cron) so a sub hears "this project just hit
  // its bid window, bid now" the next morning instead of waiting for the Monday
  // digest — the real-time-ish answer inside the weekly cadence. The commercial-
  // vs-residential track is derived with the SAME classify()/bidTrackFor() the
  // scorer and digest use (never a re-implemented keyword pass); the window
  // itself reuses COMMERCIAL_BUYOUT_STAGES (bid-window.ts). Account-isolated: the
  // join never crosses account_profile_id, and the subject/idempotency keys are
  // scoped to the single opportunity.
  const phaseWindowStart = new Date(
    now.getTime() - PHASE_CHANGE_LOOKBACK_DAYS * 86_400_000,
  ).toISOString();
  const phase = await db.execute(sql`
    SELECT o.id AS opportunity_id, o.account_profile_id, ap.key AS account_key,
      o.current_score, p.canonical_name AS project_name, p.county,
      ev.resulting_stage,
      COALESCE(rec.text, lower(p.canonical_name)) AS text
    FROM opportunities o
    JOIN account_profiles ap ON ap.id = o.account_profile_id AND ap.active = true
    JOIN projects p ON p.id = o.project_id
    JOIN LATERAL (
      -- distinct resulting stages this project reached on a RECENTLY-OBSERVED
      -- material change; one candidate per opportunity/stage.
      SELECT pe.resulting_stage
      FROM project_events pe
      WHERE pe.project_id = o.project_id
        AND pe.material_change = true
        AND pe.resulting_stage IS NOT NULL
        AND pe.observed_at >= ${phaseWindowStart}
      GROUP BY pe.resulting_stage
    ) ev ON true
    LEFT JOIN LATERAL (
      -- same record-text aggregation the digest/scorer classify on; NULL when a
      -- project has no active record yet → fall back to its canonical name.
      SELECT lower(string_agg(concat_ws(' ',
          sr.normalized_json->>'title', left(sr.normalized_json->>'description', 800),
          sr.normalized_json->>'permitType', sr.normalized_json->>'applicationType'), ' ')) AS text
      FROM record_resolutions rr JOIN source_records sr ON sr.id = rr.source_record_id
      WHERE rr.project_id = p.id AND rr.status = 'active'
    ) rec ON true
    WHERE o.state = ${PHASE_CHANGE_PRIORITY_STATE}`);
  const phaseRows = phase.rows as {
    opportunity_id: string;
    account_profile_id: string;
    account_key: string;
    current_score: number | null;
    project_name: string;
    county: string;
    resulting_stage: string;
    text: string | null;
  }[];
  for (const r of phaseRows) {
    // Same deterministic classifier the scorer/digest use — never a re-derived
    // keyword pass. classify() reads only the aggregated text (stage is unused
    // by it), so a minimal ProjectFeatures with honest nulls is faithful.
    const track = bidTrackFor(
      classify({
        projectId: r.opportunity_id,
        county: r.county,
        permittingJurisdiction: "",
        city: null,
        stage: r.resulting_stage,
        text: r.text ?? "",
        maxUnits: null,
        maxValuation: null,
        clusterSize: 0,
        hasVelocitySignal: false,
        orgs: [],
        aGradeEvidence: 0,
        lastMaterialChangeAt: null,
      } satisfies ProjectFeatures),
    );
    const enteredBidWindow =
      track === "commercial"
        ? COMMERCIAL_BUYOUT_STAGES.has(r.resulting_stage)
        : r.resulting_stage === RESIDENTIAL_BID_WINDOW_STAGE;
    if (!enteredBidWindow) continue;
    candidates.push({
      alertType: "phase_change",
      subjectKey: `${r.account_key}:${r.opportunity_id}`,
      severity: "warning",
      message:
        `${r.project_name} (${r.county} County) just hit its ${track} bid window ` +
        `(stage → ${r.resulting_stage}) — bid window open now`,
      details: {
        opportunityId: r.opportunity_id,
        accountProfileId: r.account_profile_id,
        projectName: r.project_name,
        county: r.county,
        resultingStage: r.resulting_stage,
        score: r.current_score,
        track,
      },
      idempotencyKey: `phase_change:${r.opportunity_id}:${r.resulting_stage}:${day}`,
    });
  }

  return { candidates, sourcesChecked: sourceRows.length, deliveriesChecked: draftRows.length };
}

export interface RunAlertsOptions {
  monthlyBudgetUsd: number | null;
  now?: Date;
  send?: boolean;
  recipient?: string;
  smtp?: { host: string; port: number };
  /** D4 — source key → keys it provides substitute coverage for. */
  substitutes?: Record<string, string[]>;
}

export async function runAlerts(db: Db, opts: RunAlertsOptions): Promise<AlertsRunSummary> {
  const { candidates, sourcesChecked, deliveriesChecked } = await evaluateAlertConditions(db, {
    monthlyBudgetUsd: opts.monthlyBudgetUsd,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.substitutes ? { substitutes: opts.substitutes } : {}),
  });

  const fired: AlertCandidate[] = [];
  let deduped = 0;
  for (const c of candidates) {
    const inserted = await db.execute(sql`
      INSERT INTO alerts (alert_type, subject_key, severity, message, details_json, idempotency_key)
      VALUES (${c.alertType}, ${c.subjectKey}, ${c.severity}, ${c.message},
              ${JSON.stringify(c.details)}, ${c.idempotencyKey})
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id`);
    if (inserted.rows.length > 0) fired.push(c);
    else deduped++;
  }

  let emailed = false;
  if (opts.send && fired.length > 0) {
    const transport = nodemailer.createTransport({
      host: opts.smtp?.host ?? process.env.SMTP_HOST ?? "localhost",
      port: opts.smtp?.port ?? Number(process.env.SMTP_PORT ?? 1025),
      secure: false,
    });
    const critical = fired.filter((f) => f.severity === "critical").length;
    await transport.sendMail({
      from: process.env.EMAIL_FROM ?? "insights@otn.local",
      to: opts.recipient ?? process.env.ALERTS_EMAIL ?? "ops@otn.local",
      subject: `[OTN alerts] ${fired.length} new (${critical} critical)`,
      html: `<h1>OTN operational alerts</h1><ul>${fired
        .map((f) => `<li><strong>[${f.severity}] ${f.alertType}</strong> — ${f.message}</li>`)
        .join("")}</ul>`,
    });
    emailed = true;
  }

  return {
    evaluated: { spend: opts.monthlyBudgetUsd !== null, sources: sourcesChecked, deliveries: deliveriesChecked },
    fired,
    deduped,
    emailed,
  };
}
