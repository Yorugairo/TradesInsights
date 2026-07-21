/**
 * M4.7 — spend/health/stale/delivery alerts: each condition fires once per
 * period (idempotent rows), reruns dedupe, and the Mailpit send delivers
 * exactly the newly fired alerts.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type pg from "pg";
import {
  accountProfiles,
  coverageEntries,
  opportunities,
  projectEvents,
  projects,
  rawArtifacts,
  sourceRecords,
  sourceRuns,
  sources,
  type Db,
} from "@otn/db";
import { evaluateAlertConditions, runAlerts } from "@otn/delivery";
import { deleteTestProjects, testDb } from "./helpers.js";

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

  it("D4: a red substitute source escalates, naming its now-uncovered dependents", async () => {
    const { candidates } = await evaluateAlertConditions(db, {
      monthlyBudgetUsd: null,
      substitutes: {
        [`test_alert_source_${RUN}`]: ["pierce_environmental_determinations", "tumwater_sepa"],
      },
    });
    const red = candidates.find(
      (c) => c.alertType === "source_red" && c.subjectKey === `test_alert_source_${RUN}`,
    )!;
    expect(red).toBeTruthy();
    expect(red.message).toMatch(/substitute coverage for/i);
    expect(red.message).toContain("pierce_environmental_determinations");
    expect((red.details as { mitigatedDependents?: string[] }).mitigatedDependents).toEqual([
      "pierce_environmental_determinations",
      "tumwater_sepa",
    ]);

    // Without a substitute mapping, the same red source keeps the plain message.
    const plain = await evaluateAlertConditions(db, { monthlyBudgetUsd: null });
    const plainRed = plain.candidates.find(
      (c) => c.alertType === "source_red" && c.subjectKey === `test_alert_source_${RUN}`,
    )!;
    expect(plainRed.message).not.toMatch(/substitute coverage/i);
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

/**
 * WS-C — phase-change urgent alert: a PRIORITY opportunity whose project just
 * entered its bid window (commercial buyout stages / residential permit_issued)
 * fires on the daily alert run, is idempotent per opportunity/stage/day, and is
 * account-isolated. Seeded in this describe's own hooks so the shared M4.7 tests
 * (which call runAlerts under today's/tomorrow's clock) never see this data —
 * keeping the "fires fresh" assertion deterministic.
 */
describe("WS-C phase_change bid-window alert", () => {
  const accountKey = `test_phase_acct_${RUN}`;
  let srcId: string;
  let accountId: string;
  const projectIds: string[] = [];
  let commercialOppId: string;
  let residentialIssuedOppId: string;
  let belowPriorityOppId: string;
  let residentialPreOppId: string;
  const artifactRef = { id: "" };

  /** Seed a project + its FK-required source record + a recent material stage
   * event + one opportunity. Track is driven by the project name (the alert
   * classifies on record text, falling back to canonical_name). */
  async function seed(opts: {
    name: string;
    stage: string; // resulting_stage of the event (and project.current_stage)
    state: string; // opportunity.state
    score: number;
  }): Promise<string> {
    const [project] = await db
      .insert(projects)
      .values({
        canonicalName: opts.name,
        permittingJurisdiction: "Test Jurisdiction",
        county: "Thurston",
        currentStage: opts.stage,
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      })
      .returning({ id: projects.id });
    projectIds.push(project!.id);
    const [record] = await db
      .insert(sourceRecords)
      .values({
        sourceId: srcId,
        rawArtifactId: artifactRef.id,
        externalId: opts.name,
        recordType: "permit",
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        rawFieldsJson: {},
        normalizedJson: { title: opts.name },
        normalizedFingerprint: `phase-${opts.name}`,
      })
      .returning({ id: sourceRecords.id });
    await db.insert(projectEvents).values({
      projectId: project!.id,
      sourceRecordId: record!.id,
      eventType: "stage_change",
      // observed just now → inside the phase-change lookback on today's run.
      eventDate: new Date(),
      observedAt: new Date(),
      priorStage: "concept",
      resultingStage: opts.stage,
      materialChange: true,
      confirmed: true,
      confidence: 1,
    });
    const [opp] = await db
      .insert(opportunities)
      .values({
        accountProfileId: accountId,
        projectId: project!.id,
        currentScore: opts.score,
        state: opts.state,
        firstQualifiedAt: new Date(),
      })
      .returning({ id: opportunities.id });
    return opp!.id;
  }

  beforeAll(async () => {
    const [src] = await db
      .insert(sources)
      .values({
        key: `test_phase_src_${RUN}`,
        name: "Phase Test Source",
        authority: "test",
        priority: "test",
        landingUrl: "https://example.invalid/phase",
        format: "html",
        accessClass: "html",
        cadence: "daily",
        enabled: true, // no coverage_entry → never triggers a source-health alert
      })
      .returning({ id: sources.id });
    srcId = src!.id;
    const [run] = await db
      .insert(sourceRuns)
      .values({ sourceId: srcId, status: "succeeded" })
      .returning({ id: sourceRuns.id });
    const [artifact] = await db
      .insert(rawArtifacts)
      .values({
        sourceId: srcId,
        sourceRunId: run!.id,
        canonicalUrl: `https://example.invalid/phase/${RUN}`,
        retrievedAt: new Date(),
        contentType: "application/json",
        httpStatus: 200,
        storageKey: `raw/phase/${RUN}`,
        sha256: RUN.padEnd(64, "a"),
        byteSize: 2,
        headersJson: {},
        parserVersion: "test",
      })
      .returning({ id: rawArtifacts.id });
    artifactRef.id = artifact!.id;

    const [account] = await db
      .insert(accountProfiles)
      .values({
        key: accountKey,
        name: `Phase Account ${RUN}`,
        active: true,
        capabilitiesJson: [],
        territoryJson: { counties_included: ["Thurston"] },
        deliveryConfigJson: { priority_review_min: 80, weekly_digest_min: 65 },
      })
      .returning({ id: accountProfiles.id });
    accountId = account!.id;

    // Commercial + priority + a buyout stage → FIRES.
    commercialOppId = await seed({
      name: `Phase Commercial Office Building ${RUN}`,
      stage: "permit_applied",
      state: "priority_review",
      score: 90,
    });
    // Residential + priority + permit_issued (residential window opens at issuance) → FIRES.
    residentialIssuedOppId = await seed({
      name: `Phase New Single Family Residence ${RUN}`,
      stage: "permit_issued",
      state: "priority_review",
      score: 85,
    });
    // Commercial + buyout stage but BELOW priority (weekly_digest) → does NOT fire.
    belowPriorityOppId = await seed({
      name: `Phase Commercial Retail Center ${RUN}`,
      stage: "permit_applied",
      state: "weekly_digest",
      score: 70,
    });
    // Residential + priority but PRE-issuance (permit_applied) → does NOT fire.
    residentialPreOppId = await seed({
      name: `Phase New Single Family Dwelling ${RUN}`,
      stage: "permit_applied",
      state: "priority_review",
      score: 88,
    });
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM alerts WHERE subject_key LIKE ${`${accountKey}:%`}`);
    await db.execute(sql`DELETE FROM opportunities WHERE account_profile_id = ${accountId}`);
    await deleteTestProjects(db, projectIds);
    await db.execute(sql`DELETE FROM source_records WHERE source_id = ${srcId}`);
    await db.execute(sql`DELETE FROM raw_artifacts WHERE source_id = ${srcId}`);
    await db.execute(sql`DELETE FROM source_runs WHERE source_id = ${srcId}`);
    await db.execute(sql`DELETE FROM sources WHERE id = ${srcId}`);
    await db.execute(sql`DELETE FROM account_profiles WHERE id = ${accountId}`);
  });

  it("fires for a priority opp entering its bid window; not for below-priority or pre-issuance", async () => {
    const res = await runAlerts(db, { monthlyBudgetUsd: null });
    const phase = res.fired.filter((f) => f.alertType === "phase_change");
    const byOpp = (id: string) => phase.find((f) => f.subjectKey === `${accountKey}:${id}`);

    // Commercial priority opp at a buyout stage → fires, warning, commercial track.
    const commercial = byOpp(commercialOppId);
    expect(commercial).toBeTruthy();
    expect(commercial!.severity).toBe("warning");
    expect(commercial!.message).toMatch(/bid window open now/i);
    expect(commercial!.details).toMatchObject({
      track: "commercial",
      resultingStage: "permit_applied",
      county: "Thurston",
      opportunityId: commercialOppId,
      accountProfileId: accountId,
      score: 90,
    });
    expect(commercial!.idempotencyKey).toContain(`phase_change:${commercialOppId}:permit_applied:`);

    // Residential priority opp at permit_issued → fires, residential track.
    const residentialIssued = byOpp(residentialIssuedOppId);
    expect(residentialIssued).toBeTruthy();
    expect(residentialIssued!.details).toMatchObject({
      track: "residential",
      resultingStage: "permit_issued",
    });

    // Governance — the high bar holds: a below-priority opp and a pre-issuance
    // residential opp (its window opens only at issuance) never fire.
    expect(byOpp(belowPriorityOppId)).toBeUndefined();
    expect(byOpp(residentialPreOppId)).toBeUndefined();
  });

  it("dedupes on a same-day rerun (idempotent per opportunity/stage/day)", async () => {
    const rerun = await runAlerts(db, { monthlyBudgetUsd: null });
    const minePhase = rerun.fired.filter(
      (f) => f.alertType === "phase_change" && f.subjectKey.startsWith(`${accountKey}:`),
    );
    expect(minePhase).toHaveLength(0); // both prior fires already durable for today
    expect(rerun.deduped).toBeGreaterThanOrEqual(2);
  });
});
