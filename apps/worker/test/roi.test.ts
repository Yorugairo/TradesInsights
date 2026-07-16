/**
 * S5 (strengthening addendum §8/§9) — ROI reproduces from stored events (no
 * edited aggregates), attributable revenue requires a human influenced_by_otn
 * flag, suppression is applied BEFORE digest assembly, and corrections are
 * append-only.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { accountProfiles, feedback, opportunities, projects, type Db } from "@otn/db";
import { addCorrection, addSuppression } from "@otn/intelligence";
import { addOutcome, addResearchTime, buildDigest, roiScorecard } from "@otn/delivery";
import { deleteTestProjects, testDb } from "./helpers.js";

const RUN = randomUUID().slice(0, 8).toUpperCase();
// END is slightly in the future so rows stamped with now() during setup fall
// inside the [START, END) window.
const END = new Date(Date.now() + 3_600_000);
const START = new Date(Date.now() - 7 * 86_400_000);
let db: Db;
let pool: pg.Pool;
let accountId: string;
let projectId: string;
let oppId: string;

beforeAll(async () => {
  ({ db, pool } = await testDb());
  const [a] = await db.insert(accountProfiles).values({
    key: `test_roi_${RUN.toLowerCase()}`, name: `ROI ${RUN}`, active: true,
    capabilitiesJson: [], territoryJson: {}, deliveryConfigJson: {},
  }).returning({ id: accountProfiles.id });
  accountId = a!.id;
  const [p] = await db.insert(projects).values({
    canonicalName: `ROI-${RUN}`, permittingJurisdiction: "Test Jurisdiction", county: "Thurston",
    currentStage: "permit_applied", firstSeenAt: new Date(), lastSeenAt: new Date(),
  }).returning({ id: projects.id });
  projectId = p!.id;
  const [o] = await db.insert(opportunities).values({
    accountProfileId: accountId, projectId, currentScore: 84, route: "interior_trades", state: "priority_review",
  }).returning({ id: opportunities.id });
  oppId = o!.id;

  // A delivery with two items (one new) inside the period.
  await db.execute(sql`
    INSERT INTO deliveries (account_profile_id, delivery_type, period_start, period_end, status, idempotency_key, metadata_json)
    VALUES (${accountId}, 'weekly_digest', ${START.toISOString()}, ${new Date(END.getTime() - 86_400_000).toISOString()},
      'sent', ${`roi-${RUN}`},
      ${JSON.stringify({ items: [{ opportunityId: oppId, projectId, isNew: true }, { opportunityId: oppId, projectId, isNew: false }] })})`);

  // Feedback: 2 answered relevant, 1 yes.
  await db.insert(feedback).values([
    { opportunityId: oppId, userId: "u", relevant: true, worthPursuing: true },
    { opportunityId: oppId, userId: "u", relevant: false, worthPursuing: false },
  ]);

  // A pursuit that submitted + won inside the period.
  const pu = await db.execute(sql`
    INSERT INTO pursuits (account_profile_id, opportunity_id, state, owner_user_id)
    VALUES (${accountId}, ${oppId}, 'won', 'alice') RETURNING id`);
  const pursuitId = (pu.rows[0] as { id: string }).id;
  await db.execute(sql`
    INSERT INTO pursuit_transitions (pursuit_id, from_state, to_state, actor_type)
    VALUES (${pursuitId}, 'estimating', 'submitted', 'human'), (${pursuitId}, 'submitted', 'won', 'human')`);

  await addResearchTime(db, { accountProfileId: accountId, opportunityId: oppId, minutesSavedEstimate: 45, estimationMethod: "manual" });
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM opportunity_outcomes WHERE opportunity_id = ${oppId}`);
  await db.execute(sql`DELETE FROM research_time_entries WHERE account_profile_id = ${accountId}`);
  await db.execute(sql`DELETE FROM claim_corrections WHERE opportunity_id = ${oppId}`);
  await db.execute(sql`DELETE FROM account_suppressions WHERE account_profile_id = ${accountId}`);
  await db.execute(sql`DELETE FROM pursuit_transitions WHERE pursuit_id IN (SELECT id FROM pursuits WHERE account_profile_id = ${accountId})`);
  await db.execute(sql`DELETE FROM pursuits WHERE account_profile_id = ${accountId}`);
  await db.execute(sql`DELETE FROM feedback WHERE opportunity_id = ${oppId}`);
  await db.execute(sql`DELETE FROM deliveries WHERE account_profile_id = ${accountId}`);
  await db.execute(sql`DELETE FROM opportunities WHERE account_profile_id = ${accountId}`);
  await deleteTestProjects(db, [projectId]);
  await db.execute(sql`DELETE FROM account_profiles WHERE id = ${accountId}`);
  await pool.end();
});

describe("S5 ROI + trust", () => {
  it("scorecard reproduces every metric from stored events", async () => {
    const s = await roiScorecard(db, accountId, { start: START, end: END });
    expect(s.opportunitiesDelivered).toBe(2);
    expect(s.newToCustomer).toBe(1);
    expect(s.relevantRate).toBe(0.5); // 1 of 2 answered
    expect(s.bidsSubmitted).toBe(1);
    expect(s.wins).toBe(1);
    expect(s.researchTimeSavedMinutes).toBe(45);
    expect(s.unsupportedFactCount).toBe(0);
  });

  it("attributable revenue requires a human influenced_by_otn flag", async () => {
    await addOutcome(db, { opportunityId: oppId, outcomeType: "won", influencedByOtn: false, attributableValue: 100000, outcomeAt: new Date().toISOString() });
    let s = await roiScorecard(db, accountId, { start: START, end: END });
    expect(s.influencedContractValue).toBe(0); // not human-attributed → not counted

    await addOutcome(db, { opportunityId: oppId, outcomeType: "won", influencedByOtn: true, attributableValue: 250000, outcomeAt: new Date().toISOString() });
    s = await roiScorecard(db, accountId, { start: START, end: END });
    expect(s.influencedContractValue).toBe(250000);
  });

  it("suppression is applied before digest assembly", async () => {
    let model = await buildDigest(db, accountId, { start: START, end: END });
    const before = [
      ...model.sections.priorityNew, ...model.sections.stageChanges,
      ...model.sections.missingFacts, ...model.sections.monitoring,
    ].some((i) => i.projectId === projectId);
    // (may or may not be present depending on gate; the point is suppression removes it and counts it)
    await addSuppression(db, { accountProfileId: accountId, targetType: "project", targetId: projectId, reason: "not interested" });
    model = await buildDigest(db, accountId, { start: START, end: END });
    const after = [
      ...model.sections.priorityNew, ...model.sections.stageChanges,
      ...model.sections.missingFacts, ...model.sections.monitoring,
    ].some((i) => i.projectId === projectId);
    expect(after).toBe(false); // suppressed → never assembled
    expect(model.suppressed.customerSuppressed).toBeGreaterThanOrEqual(1);
    void before;
  });

  it("corrections are append-only (history never mutated)", async () => {
    const c1 = await addCorrection(db, { opportunityId: oppId, correctionType: "unit_count", priorValue: 198, correctedValue: 180, reason: "source correction" });
    await addCorrection(db, { opportunityId: oppId, correctionType: "unit_count", priorValue: 180, correctedValue: 176, reason: "addendum" });
    const rows = await db.execute(sql`SELECT id, corrected_value_json FROM claim_corrections WHERE opportunity_id = ${oppId} ORDER BY created_at ASC`);
    expect(rows.rows).toHaveLength(2); // append, not edit
    // The first correction's stored value is unchanged by the second.
    const first = rows.rows.find((r) => (r as { id: string }).id === c1.id) as { corrected_value_json: number };
    expect(Number(first.corrected_value_json)).toBe(180);
  });
});
