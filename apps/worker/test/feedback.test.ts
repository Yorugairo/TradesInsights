/**
 * M3.7 — feedback + disposition reasons: controlled vocabulary and the
 * per-account calibration rollup (rates, dispositions, per-route relevance).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { accountProfiles, opportunities, projects, type Db } from "@otn/db";
import {
  DISPOSITION_REASONS,
  feedbackSummary,
  isDispositionReason,
} from "@otn/intelligence";
import { deleteTestProjects, testDb } from "./helpers.js";

const RUN = randomUUID().slice(0, 8).toUpperCase();

let db: Db;
let pool: pg.Pool;
let accountId: string;
const projectIds: string[] = [];

async function seedOpportunity(route: string): Promise<string> {
  const [project] = await db
    .insert(projects)
    .values({
      canonicalName: `FEEDBACK-${route}-${RUN}`,
      permittingJurisdiction: "Test Jurisdiction",
      county: "Thurston",
      currentStage: "permit_applied",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    })
    .returning({ id: projects.id });
  projectIds.push(project!.id);
  const [opp] = await db
    .insert(opportunities)
    .values({
      accountProfileId: accountId,
      projectId: project!.id,
      currentScore: 70,
      state: "weekly_digest",
      route,
    })
    .returning({ id: opportunities.id });
  return opp!.id;
}

async function addFeedback(
  opportunityId: string,
  fields: {
    relevant?: boolean | null;
    timely?: boolean | null;
    worthPursuing?: boolean | null;
    disposition?: string | null;
  },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO feedback (opportunity_id, user_id, relevant, timely, worth_pursuing, disposition_reason)
    VALUES (${opportunityId}, 'test-user', ${fields.relevant ?? null}, ${fields.timely ?? null},
      ${fields.worthPursuing ?? null}, ${fields.disposition ?? null})`);
}

beforeAll(async () => {
  ({ db, pool } = await testDb());
  const [account] = await db
    .insert(accountProfiles)
    .values({
      key: `test_feedback_${RUN.toLowerCase()}`,
      name: `Feedback Test ${RUN}`,
      active: false, // never picked up by score/digest runs
      capabilitiesJson: [],
      territoryJson: {},
      deliveryConfigJson: {},
    })
    .returning({ id: accountProfiles.id });
  accountId = account!.id;

  const interior = await seedOpportunity("interior_trades");
  const radar = await seedOpportunity("gc_relationship_radar");

  await addFeedback(interior, { relevant: true, timely: true, worthPursuing: true });
  await addFeedback(interior, { relevant: true, timely: false, disposition: "too_late" });
  await addFeedback(interior, { relevant: false, disposition: "wrong_trade" });
  await addFeedback(radar, { relevant: false, disposition: "too_large" });
  await addFeedback(radar, { disposition: "already_known" }); // all booleans unanswered
});

afterAll(async () => {
  await db.execute(sql`
    DELETE FROM feedback WHERE opportunity_id IN
      (SELECT id FROM opportunities WHERE account_profile_id = ${accountId})`);
  await db.execute(sql`DELETE FROM opportunities WHERE account_profile_id = ${accountId}`);
  await deleteTestProjects(db, projectIds);
  await db.execute(sql`DELETE FROM account_profiles WHERE id = ${accountId}`);
  await pool.end();
});

describe("M3.7 feedback + disposition reasons", () => {
  it("vocabulary is controlled and checkable", () => {
    expect(DISPOSITION_REASONS).toContain("wrong_trade");
    expect(isDispositionReason("too_small")).toBe(true);
    expect(isDispositionReason("not a reason")).toBe(false);
    expect(isDispositionReason(null)).toBe(false);
  });

  it("rolls up rates, dispositions, and per-route relevance for calibration", async () => {
    const s = await feedbackSummary(db, accountId);
    expect(s.total).toBe(5);
    // relevant answered on 4 of 5 rows, yes on 2 → 0.5
    expect(s.answered.relevant).toBe(4);
    expect(s.yesRate.relevant).toBe(0.5);
    // timely answered twice (yes once) → 0.5; unanswered fields don't dilute
    expect(s.answered.timely).toBe(2);
    expect(s.yesRate.timely).toBe(0.5);
    expect(s.answered.worthPursuing).toBe(1);
    expect(s.yesRate.worthPursuing).toBe(1);

    expect(s.byDisposition).toEqual({
      too_late: 1,
      wrong_trade: 1,
      too_large: 1,
      already_known: 1,
    });

    expect(s.byRoute["interior_trades"]).toEqual({ total: 3, relevantYes: 2, relevantNo: 1 });
    expect(s.byRoute["gc_relationship_radar"]).toEqual({ total: 2, relevantYes: 0, relevantNo: 1 });
  });

  it("returns null rates (not zero) when nothing is answered — never fabricate a rate", async () => {
    const [empty] = await db
      .insert(accountProfiles)
      .values({
        key: `test_feedback_empty_${RUN.toLowerCase()}`,
        name: `Feedback Empty ${RUN}`,
        active: false,
        capabilitiesJson: [],
        territoryJson: {},
        deliveryConfigJson: {},
      })
      .returning({ id: accountProfiles.id });
    try {
      const s = await feedbackSummary(db, empty!.id);
      expect(s.total).toBe(0);
      expect(s.yesRate.relevant).toBeNull();
    } finally {
      await db.execute(sql`DELETE FROM account_profiles WHERE id = ${empty!.id}`);
    }
  });
});
