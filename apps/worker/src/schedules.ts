import type PgBoss from "pg-boss";
import type { Logger } from "pino";
import { sql } from "drizzle-orm";
import { createDb, createPool } from "@otn/db";
import { loadSourcesConfig, type SourceConfig } from "@otn/config";
import {
  applyRecordUpdates,
  buildDevelopments,
  computeCampusVelocity,
  computeClusterVelocity,
  geocodeProjects,
  materializeProjectGeometry,
  resolveUnresolved,
} from "@otn/resolution";
import { computeStageLagStats, scoreAll } from "@otn/intelligence";
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
/** Boot catch-up: enqueue maintenance if none completed within this window. */
export const MAINTENANCE_CATCHUP_HOURS = 24;
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
    const updates = await applyRecordUpdates(db, { logger });
    const developments = await buildDevelopments(db, { logger });
    const velocity = await computeClusterVelocity(db, { logger });
    const campus = await computeCampusVelocity(db, { logger });
    const materialized = await materializeProjectGeometry(db, { logger });
    const geocoded = await geocodeProjects(db, { limit: NIGHTLY_GEOCODE_LIMIT, logger });
    const stageLag = await computeStageLagStats(db, { logger });
    const scored = await scoreAll(db, { logger });

    const monthlyBudgetUsd = process.env.LLM_MONTHLY_BUDGET_USD
      ? Number(process.env.LLM_MONTHLY_BUDGET_USD)
      : null;
    const substitutes: Record<string, string[]> = {};
    for (const s of loadSourcesConfig().sources) {
      if (s.mitigates.length > 0) substitutes[s.key] = s.mitigates;
    }
    // Alert EMAILS go out when a recipient is configured (ALERTS_EMAIL):
    // an unattended pipeline whose alerts stay in a table isn't alerting.
    // Idempotent rows + exactly-once send semantics live in runAlerts (M4.7).
    const alerts = await runAlerts(db, {
      monthlyBudgetUsd,
      substitutes,
      send: Boolean(process.env.ALERTS_EMAIL),
    });

    logger.info(
      {
        resolved,
        updates,
        developments,
        velocity,
        campus,
        materialized,
        geocoded,
        stageLag,
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

/**
 * Dead-worker stall protection: cron only fires while a worker is alive, and
 * the safety-net alerts run INSIDE the nightly chain — so a worker that was
 * down through the 04:45 window would stall the whole pipeline silently. On
 * boot, if no maintenance run completed within the catch-up window and none
 * is queued, enqueue one immediately (singleton-keyed so racing boots enqueue
 * exactly once; the chain itself is idempotent, so a same-day cron run after
 * a catch-up is harmless).
 */
export async function catchUpMaintenance(
  boss: PgBoss,
  logger: Logger,
  queue: string = MAINTENANCE_QUEUE,
): Promise<{ enqueued: boolean; reason: string }> {
  const pool = createPool();
  const db = createDb(pool);
  try {
    const res = await db.execute(sql`
      SELECT
        greatest(
          (SELECT max(completed_on) FROM pgboss.job
             WHERE name = ${queue} AND state = 'completed'),
          (SELECT max(completed_on) FROM pgboss.archive
             WHERE name = ${queue} AND state = 'completed')
        ) AS last_completed,
        EXISTS (SELECT 1 FROM pgboss.job
                  WHERE name = ${queue} AND state IN ('created', 'active', 'retry')) AS pending`);
    const row = res.rows[0] as { last_completed: string | null; pending: boolean };
    if (row.pending) {
      return { enqueued: false, reason: "maintenance already queued or running" };
    }
    const last = row.last_completed ? new Date(row.last_completed) : null;
    const ageHours = last ? (Date.now() - last.getTime()) / 3_600_000 : Infinity;
    if (ageHours < MAINTENANCE_CATCHUP_HOURS) {
      return { enqueued: false, reason: `last completed ${ageHours.toFixed(1)}h ago` };
    }
    const jobId = await boss.send(queue, {}, { singletonKey: "boot-catchup", singletonSeconds: 3600 });
    const summary = {
      enqueued: jobId !== null,
      reason: jobId !== null ? "no completed run in window — catch-up enqueued" : "singleton already pending",
    };
    logger.info({ queue, lastCompleted: row.last_completed, ...summary }, "maintenance catch-up check");
    return summary;
  } finally {
    await pool.end();
  }
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
