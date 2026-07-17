import type PgBoss from "pg-boss";
import type { Logger } from "pino";
import { sql } from "drizzle-orm";
import { createDb, createPool } from "@otn/db";
import { loadSourcesConfig, type SourceConfig } from "@otn/config";
import {
  buildDevelopments,
  computeCampusVelocity,
  computeClusterVelocity,
  geocodeProjects,
  materializeProjectGeometry,
  resolveUnresolved,
} from "@otn/resolution";
import { scoreAll } from "@otn/intelligence";
import { buildDigest, deliverDigest, runAlerts } from "@otn/delivery";
import { SOURCE_RUN_DEAD_LETTER, executeSourceRun } from "./jobs.js";

/**
 * #4 — self-driving cadence. Everything an operator was invoking by hand
 * becomes pg-boss cron schedules, reconciled from config at worker boot:
 *
 * - one schedule per enabled fetchable source, cron derived from its
 *   `cadence` in config/sources.yaml with a deterministic per-source stagger
 *   (no top-of-the-hour stampede against county infrastructure);
 * - a nightly `pipeline-maintenance` chain (resolve → developments →
 *   velocity/campus → geometry materialize → geocode batch → score → alerts)
 *   — exactly the manual CLI sequence, same functions;
 * - a weekly `digest-draft` run that BUILDS drafts for active accounts and
 *   never sends (sending stays a human/explicitly-authorized act).
 *
 * Reconciliation: schedules for sources that are no longer enabled (or left
 * config) are unscheduled at boot — config stays the source of truth.
 * The M4.7 alerts (red/stale/unsent-draft) are the safety net around all of
 * this, and they run inside the nightly chain.
 */

export const MAINTENANCE_QUEUE = "pipeline-maintenance";
export const DIGEST_DRAFT_QUEUE = "digest-draft";
/** Nightly geocode batch size (Census pacing stays polite). */
export const NIGHTLY_GEOCODE_LIMIT = 500;
const TZ = "America/Los_Angeles";

export function scheduledQueueName(sourceKey: string): string {
  return `source-run.${sourceKey}`;
}

/** Deterministic 0..(mod-1) stagger from the source key (stable across boots). */
function stagger(key: string, mod: number): number {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % mod;
}

/**
 * Cadence → cron with per-source stagger, early-morning Pacific (counties
 * publish on business days; fetching at 02:xx–03:xx local avoids their peak
 * and ours). on_demand sources are never scheduled.
 */
export function cadenceCron(cadence: SourceConfig["cadence"], sourceKey: string): string | null {
  const minute = stagger(sourceKey, 60);
  const hour = 2 + stagger(`${sourceKey}h`, 2); // 02:xx or 03:xx local
  switch (cadence) {
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekly":
      return `${minute} ${hour} * * 1`; // Mondays
    case "monthly":
      return `${minute} ${hour} 2 * *`; // 2nd — monthly reports post after month end
    case "on_demand":
      return null;
  }
}

/** Sources that should be on a schedule: enabled, fetchable, never private. */
export function schedulableSources(sources: SourceConfig[]): SourceConfig[] {
  return sources.filter(
    (s) => s.enabled && s.cadence !== "on_demand" && s.access_class !== "private_authorized",
  );
}

async function runMaintenance(logger: Logger): Promise<void> {
  const pool = createPool();
  const db = createDb(pool);
  try {
    const resolved = await resolveUnresolved(db, { logger });
    const developments = await buildDevelopments(db, { logger });
    const velocity = await computeClusterVelocity(db, { logger });
    const campus = await computeCampusVelocity(db, { logger });
    const materialized = await materializeProjectGeometry(db, { logger });
    const geocoded = await geocodeProjects(db, { limit: NIGHTLY_GEOCODE_LIMIT, logger });
    const scored = await scoreAll(db, { logger });

    const monthlyBudgetUsd = process.env.LLM_MONTHLY_BUDGET_USD
      ? Number(process.env.LLM_MONTHLY_BUDGET_USD)
      : null;
    const substitutes: Record<string, string[]> = {};
    for (const s of loadSourcesConfig().sources) {
      if (s.mitigates.length > 0) substitutes[s.key] = s.mitigates;
    }
    const alerts = await runAlerts(db, { monthlyBudgetUsd, substitutes });

    logger.info(
      {
        resolved,
        developments,
        velocity,
        campus,
        materialized,
        geocoded,
        scored: scored.byAccount,
        alerts: { evaluated: alerts.evaluated, fired: alerts.fired.length, deduped: alerts.deduped },
      },
      "pipeline maintenance complete",
    );
  } finally {
    await pool.end();
  }
}

async function runDigestDrafts(logger: Logger): Promise<void> {
  const pool = createPool();
  const db = createDb(pool);
  try {
    const periodEnd = new Date();
    const periodStart = new Date(periodEnd.getTime() - 7 * 86_400_000);
    const accounts = await db.execute(
      sql`SELECT id, key FROM account_profiles WHERE active = true AND key NOT LIKE 'test_%'`,
    );
    for (const a of accounts.rows as { id: string; key: string }[]) {
      const model = await buildDigest(db, a.id, { start: periodStart, end: periodEnd });
      // Draft only — never sends. Idempotent per (account, week).
      const delivery = await deliverDigest(db, model);
      logger.info(
        { account: a.key, deliveryId: delivery.deliveryId, created: delivery.created },
        "digest draft",
      );
    }
  } finally {
    await pool.end();
  }
}

export interface ScheduleSummary {
  scheduled: string[];
  unscheduled: string[];
}

/** Reconcile pg-boss cron schedules with config. Idempotent at every boot. */
export async function registerSchedules(boss: PgBoss, logger: Logger): Promise<ScheduleSummary> {
  const sources = schedulableSources(loadSourcesConfig().sources);
  const desired = new Map<string, { cron: string; data?: object }>();

  for (const s of sources) {
    const cron = cadenceCron(s.cadence, s.key);
    if (cron) desired.set(scheduledQueueName(s.key), { cron, data: { sourceKey: s.key } });
  }
  desired.set(MAINTENANCE_QUEUE, { cron: `45 4 * * *` }); // after the 02–03:xx fetch window
  desired.set(DIGEST_DRAFT_QUEUE, { cron: `15 5 * * 1` }); // Mondays, after maintenance

  // Queues + workers.
  for (const s of sources) {
    const queue = scheduledQueueName(s.key);
    await boss.createQueue(queue, {
      name: queue,
      retryLimit: 3,
      retryDelay: 60,
      retryBackoff: true,
      deadLetter: SOURCE_RUN_DEAD_LETTER,
    });
    await boss.work<{ sourceKey: string }>(queue, async ([job]) => {
      if (!job) return;
      const jobLogger = logger.child({ jobId: job.id, queue });
      const pool = createPool();
      const db = createDb(pool);
      try {
        jobLogger.info({ sourceKey: job.data.sourceKey }, "scheduled source run started");
        await executeSourceRun(db, { sourceKey: job.data.sourceKey }, jobLogger);
      } finally {
        await pool.end();
      }
    });
  }
  await boss.createQueue(MAINTENANCE_QUEUE, {
    name: MAINTENANCE_QUEUE,
    retryLimit: 1,
    retryDelay: 600,
  });
  await boss.work(MAINTENANCE_QUEUE, async () => runMaintenance(logger.child({ queue: MAINTENANCE_QUEUE })));
  await boss.createQueue(DIGEST_DRAFT_QUEUE, {
    name: DIGEST_DRAFT_QUEUE,
    retryLimit: 1,
    retryDelay: 600,
  });
  await boss.work(DIGEST_DRAFT_QUEUE, async () => runDigestDrafts(logger.child({ queue: DIGEST_DRAFT_QUEUE })));

  // Schedules: upsert desired, drop stale (a disabled source stops fetching
  // at the next boot without manual cleanup).
  const existing = await boss.getSchedules();
  const summary: ScheduleSummary = { scheduled: [], unscheduled: [] };
  for (const [queue, { cron, data }] of desired) {
    await boss.schedule(queue, cron, data ?? {}, { tz: TZ });
    summary.scheduled.push(`${queue} @ ${cron}`);
  }
  for (const sched of existing) {
    const isOurs =
      sched.name.startsWith("source-run.") ||
      sched.name === MAINTENANCE_QUEUE ||
      sched.name === DIGEST_DRAFT_QUEUE;
    if (isOurs && !desired.has(sched.name)) {
      await boss.unschedule(sched.name);
      summary.unscheduled.push(sched.name);
    }
  }
  logger.info(summary, "schedules reconciled from config");
  return summary;
}
