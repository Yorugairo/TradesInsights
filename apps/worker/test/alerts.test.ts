/**
 * M4.7 — spend/health/stale/delivery alerts: each condition fires once per
 * period (idempotent rows), reruns dedupe, and the Mailpit send delivers
 * exactly the newly fired alerts.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type pg from "pg";
import { accountProfiles, coverageEntries, sources, type Db } from "@otn/db";
import { runAlerts } from "@otn/delivery";
import { testDb } from "./helpers.js";

const RUN = randomUUID().slice(0, 8).toLowerCase();

let db: Db;
let pool: pg.Pool;
let sourceId: string;
let accountId: string;
let deliveryId: string;
let modelRunId: string;

beforeAll(async () => {
  ({ db, pool } = await testDb());

  // A red + stale enabled source.
  const [src] = await db
    .insert(sources)
    .values({
      key: `test_alert_source_${RUN}`,
      name: "Alert Test Source",
      authority: "test",
      priority: "test",
      landingUrl: "https://example.invalid/alerts",
      format: "html",
      accessClass: "html",
      cadence: "daily",
      enabled: true,
    })
    .returning({ id: sources.id });
  sourceId = src!.id;
  await db.insert(coverageEntries).values({
    sourceId,
    status: "enabled",
    freshnessState: "red",
    lastSuccessAt: new Date(Date.now() - 5 * 86_400_000), // 5d > 2× daily
  });

  // An unsent draft digest 10 days past its period.
  const [account] = await db
    .insert(accountProfiles)
    .values({
      key: `test_alert_account_${RUN}`,
      name: `Alert Account ${RUN}`,
      active: true,
      capabilitiesJson: [],
      territoryJson: {},
      deliveryConfigJson: {},
    })
    .returning({ id: accountProfiles.id });
  accountId = account!.id;
  const draft = await db.execute(sql`
    INSERT INTO deliveries (account_profile_id, delivery_type, period_start, period_end, status, idempotency_key)
    VALUES (${accountId}, 'weekly_digest',
      ${new Date(Date.now() - 17 * 86_400_000).toISOString()},
      ${new Date(Date.now() - 10 * 86_400_000).toISOString()},
      'draft', ${`test-alert-${RUN}`})
    RETURNING id`);
  deliveryId = (draft.rows[0] as { id: string }).id;

  // Spend: one model_runs row that eats 90% of a tiny budget.
  const run = await db.execute(sql`
    INSERT INTO model_runs (job_type, provider, model, prompt_version, cost_usd, status)
    VALUES ('extraction', 'test', 'test', 'test', 0.9, 'succeeded') RETURNING id`);
  modelRunId = (run.rows[0] as { id: string }).id;
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM alerts WHERE subject_key LIKE ${'%' + RUN + '%'} OR subject_key = ${deliveryId}`);
  await db.execute(sql`DELETE FROM alerts WHERE idempotency_key LIKE 'spend_budget:%'`);
  await db.execute(sql`DELETE FROM model_runs WHERE id = ${modelRunId}`);
  await db.execute(sql`DELETE FROM deliveries WHERE id = ${deliveryId}`);
  await db.execute(sql`DELETE FROM account_profiles WHERE id = ${accountId}`);
  await db.delete(coverageEntries).where(eq(coverageEntries.sourceId, sourceId));
  await db.delete(sources).where(eq(sources.id, sourceId));
  await pool.end();
});

describe("M4.7 operational alerts", () => {
  it("fires spend/red/stale/unsent alerts and dedupes on rerun", async () => {
    // The seeded model_runs corpus may carry other cost rows; the tiny budget
    // guarantees the ratio crosses a threshold either way.
    const first = await runAlerts(db, { monthlyBudgetUsd: 1 });
    const types = first.fired.map((f) => `${f.alertType}:${f.subjectKey}`);
    expect(types).toContain(`source_red:test_alert_source_${RUN}`);
    expect(types).toContain(`source_stale:test_alert_source_${RUN}`);
    expect(types).toContain(`delivery_unsent:${deliveryId}`);
    expect(first.fired.some((f) => f.alertType === "spend_budget")).toBe(true);

    const rerun = await runAlerts(db, { monthlyBudgetUsd: 1 });
    // Same period → every condition dedupes against the stored rows.
    expect(rerun.fired.filter((f) => f.subjectKey.includes(RUN))).toHaveLength(0);
    expect(rerun.deduped).toBeGreaterThanOrEqual(3);
  });

  it("spend alert severity: exhausted budget is critical and blocks are called out", async () => {
    const res = await runAlerts(db, { monthlyBudgetUsd: 0.5 }); // 0.9 spent ≥ 100%
    const spend =
      res.fired.find((f) => f.alertType === "spend_budget") ??
      // may already exist from a prior in-test run at the same month+threshold
      (await db.execute(sql`
        SELECT severity, message FROM alerts
        WHERE idempotency_key LIKE 'spend_budget:llm_monthly:%:100'`).then(
        (r) => r.rows[0] as { severity: string; message: string } | undefined,
      ));
    expect(spend).toBeTruthy();
    expect((spend as { severity: string }).severity).toBe("critical");
    expect((spend as { message: string }).message).toContain("blocked");
  });

  it("emails newly fired alerts via Mailpit exactly once", async () => {
    const recipient = `alerts-${RUN}@pilot.otn.local`;
    // Fresh condition (a second stale day is simulated by a future 'now').
    const tomorrow = new Date(Date.now() + 86_400_000);
    const sent = await runAlerts(db, {
      monthlyBudgetUsd: null,
      now: tomorrow,
      send: true,
      recipient,
    });
    expect(sent.fired.length).toBeGreaterThanOrEqual(1);
    expect(sent.emailed).toBe(true);

    const res = await fetch(
      `http://localhost:8025/api/v1/search?query=to:${encodeURIComponent(recipient)}`,
    );
    const box = (await res.json()) as { messages_count: number };
    expect(box.messages_count).toBe(1);

    // Rerun with the same clock: nothing new → no second email.
    const again = await runAlerts(db, { monthlyBudgetUsd: null, now: tomorrow, send: true, recipient });
    expect(again.emailed).toBe(false);
  });
});
