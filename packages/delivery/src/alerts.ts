import { sql } from "drizzle-orm";
import nodemailer from "nodemailer";
import type { Db } from "@otn/db";

/**
 * M4.7 — operational alerts (spec §21: "spend, health, stale-source, and
 * delivery alerts"). Every condition is a deterministic query; every fired
 * alert is a row in `alerts` with an idempotency key scoped to its period,
 * so scheduled re-evaluation never spams. Email (Mailpit locally) is
 * best-effort on top of the durable rows.
 */

export const SPEND_WARNING_RATIO = 0.8;

export interface AlertCandidate {
  alertType: "spend_budget" | "source_red" | "source_stale" | "delivery_unsent";
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
  opts: { monthlyBudgetUsd: number | null; now?: Date } = { monthlyBudgetUsd: null },
): Promise<{ candidates: AlertCandidate[]; sourcesChecked: number; deliveriesChecked: number }> {
  const now = opts.now ?? new Date();
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
      candidates.push({
        alertType: "source_red",
        subjectKey: s.key,
        severity: "critical",
        message: `Source ${s.key} is RED — deliveries it solely supports are suppressed`,
        details: { lastSuccessAt: s.last_success_at },
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

  return { candidates, sourcesChecked: sourceRows.length, deliveriesChecked: draftRows.length };
}

export interface RunAlertsOptions {
  monthlyBudgetUsd: number | null;
  now?: Date;
  send?: boolean;
  recipient?: string;
  smtp?: { host: string; port: number };
}

export async function runAlerts(db: Db, opts: RunAlertsOptions): Promise<AlertsRunSummary> {
  const { candidates, sourcesChecked, deliveriesChecked } = await evaluateAlertConditions(db, {
    monthlyBudgetUsd: opts.monthlyBudgetUsd,
    ...(opts.now ? { now: opts.now } : {}),
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
