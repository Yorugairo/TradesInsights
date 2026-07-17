/**
 * #4 — self-driving cadence: config-derived cron schedules with deterministic
 * stagger, reconciliation at boot (stale schedules dropped), on_demand and
 * private-class sources never scheduled.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import PgBoss from "pg-boss";
import pino from "pino";
import { loadSourcesConfig } from "@otn/config";
import {
  DIGEST_DRAFT_QUEUE,
  MAINTENANCE_QUEUE,
  cadenceCron,
  registerSchedules,
  schedulableSources,
  scheduledQueueName,
} from "../src/schedules.js";

let boss: PgBoss;
const logger = pino({ level: "silent" });

beforeAll(async () => {
  boss = new PgBoss({ connectionString: process.env.DATABASE_URL! });
  await boss.start();
});

afterAll(async () => {
  // Leave no schedules behind: tests must not make the shared dev DB start
  // firing real source runs on a cron.
  for (const s of await boss.getSchedules()) {
    if (
      s.name.startsWith("source-run.") ||
      s.name === MAINTENANCE_QUEUE ||
      s.name === DIGEST_DRAFT_QUEUE
    ) {
      await boss.unschedule(s.name);
    }
  }
  await boss.stop({ close: true, graceful: false });
});

describe("cadenceCron", () => {
  it("maps cadences to cron with a stable per-source stagger", () => {
    const daily = cadenceCron("daily", "seattle_building_permits");
    expect(daily).toMatch(/^\d{1,2} [23] \* \* \*$/); // 02:xx or 03:xx local
    expect(cadenceCron("daily", "seattle_building_permits")).toBe(daily); // stable
    expect(cadenceCron("weekly", "lewis_issued_permits")).toMatch(/^\d{1,2} [23] \* \* 1$/);
    expect(cadenceCron("monthly", "king_permit_reports")).toMatch(/^\d{1,2} [23] 2 \* \*$/);
    expect(cadenceCron("on_demand", "customer_bid_inbox_solis")).toBeNull();
  });

  it("staggers sources instead of stampeding one minute", () => {
    const sources = schedulableSources(loadSourcesConfig().sources);
    const minutes = new Set(sources.map((s) => cadenceCron(s.cadence, s.key)!.split(" ")[0]));
    // Not a strict uniqueness guarantee (hash), but the live set must spread.
    expect(minutes.size).toBeGreaterThan(Math.min(4, sources.length - 1));
  });
});

describe("schedulableSources", () => {
  it("excludes disabled, on_demand, and private-class sources", () => {
    const keys = schedulableSources(loadSourcesConfig().sources).map((s) => s.key);
    expect(keys).not.toContain("customer_bid_inbox_solis"); // private + on_demand
    expect(keys).not.toContain("pierce_environmental_determinations"); // disabled (blocked)
    expect(keys).toContain("seattle_building_permits");
    expect(keys.length).toBeGreaterThan(5);
  });
});

describe("registerSchedules reconciliation", () => {
  it("schedules every fetchable source plus maintenance and digest drafts, idempotently", async () => {
    const first = await registerSchedules(boss, logger);
    const expected = schedulableSources(loadSourcesConfig().sources).length + 2;
    expect(first.scheduled.length).toBe(expected);

    const names = (await boss.getSchedules()).map((s) => s.name);
    expect(names).toContain(MAINTENANCE_QUEUE);
    expect(names).toContain(DIGEST_DRAFT_QUEUE);
    expect(names).toContain(scheduledQueueName("seattle_building_permits"));

    // Re-register: same set, nothing dropped (idempotent boot).
    const second = await registerSchedules(boss, logger);
    expect(second.scheduled.length).toBe(expected);
    expect(second.unscheduled).toEqual([]);
  });

  it("drops a stale schedule for a source that left the config", async () => {
    const stale = scheduledQueueName("ghost_source_e2e");
    await boss.createQueue(stale);
    await boss.schedule(stale, "0 3 * * *", {});
    const summary = await registerSchedules(boss, logger);
    expect(summary.unscheduled).toContain(stale);
    const names = (await boss.getSchedules()).map((s) => s.name);
    expect(names).not.toContain(stale);
  });
});
