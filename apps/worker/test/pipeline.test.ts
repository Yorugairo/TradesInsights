/**
 * Pipeline summary — the customer-facing "what did OTN get me" headline:
 * sourced → pursued → bid → won funnel + dollar attribution, reproduced from
 * stored opportunities, the pursuit state machine, and opportunity_outcomes.
 * Dollars only where a human recorded them; nothing fabricated.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import {
  accountProfiles, opportunities, opportunityOutcomes, projects, pursuits, type Db,
} from "@otn/db";
import { pipelineSummary } from "@otn/delivery";
import { deleteTestProjects, testDb } from "./helpers.js";

const RUN = randomUUID().slice(0, 8).toUpperCase();
let db: Db;
let pool: pg.Pool;
let accountId: string;
const projectIds: string[] = [];

async function opp(name: string, state: string): Promise<string> {
  const [project] = await db.insert(projects).values({
    canonicalName: `${name}-${RUN}`, permittingJurisdiction: "Test Jurisdiction", county: "Pierce",
    currentStage: "permit_issued", firstSeenAt: new Date(), lastSeenAt: new Date(),
  }).returning({ id: projects.id });
  projectIds.push(project!.id);
  const [o] = await db.insert(opportunities).values({
    accountProfileId: accountId, projectId: project!.id, currentScore: 80, state,
  }).returning({ id: opportunities.id });
  return o!.id;
}

beforeAll(async () => {
  ({ db, pool } = await testDb());
  const [account] = await db.insert(accountProfiles).values({
    key: `test_pipe_${RUN.toLowerCase()}`, name: `Pipe ${RUN}`, active: true,
    capabilitiesJson: [], territoryJson: { counties_included: ["Pierce"] }, deliveryConfigJson: {},
  }).returning({ id: accountProfiles.id });
  accountId = account!.id;

  // Three surfaced (priority/digest/promoted) + one archived (not surfaced).
  const oWon = await opp("PIPE-WON", "priority_review");
  const oSub = await opp("PIPE-SUB", "weekly_digest");
  const oBid = await opp("PIPE-BID", "promoted");
  await opp("PIPE-ARCH", "archive");

  await db.insert(pursuits).values([
    { accountProfileId: accountId, opportunityId: oWon, ownerUserId: "u1", state: "won", outcomeValue: 120_000 },
    { accountProfileId: accountId, opportunityId: oSub, ownerUserId: "u1", state: "submitted", submittedValue: 80_000 },
    { accountProfileId: accountId, opportunityId: oBid, ownerUserId: "u1", state: "bid_confirmed", estimatedContractValue: 40_000 },
  ]);
  await db.insert(opportunityOutcomes).values({
    opportunityId: oWon, outcomeType: "won", influencedByOtn: true, attributableValue: 120_000, createdBy: "u1",
  });
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM opportunity_outcomes WHERE opportunity_id IN (SELECT id FROM opportunities WHERE account_profile_id = ${accountId})`);
  await db.execute(sql`DELETE FROM pursuits WHERE account_profile_id = ${accountId}`);
  await db.execute(sql`DELETE FROM opportunities WHERE account_profile_id = ${accountId}`);
  await deleteTestProjects(db, projectIds);
  await db.execute(sql`DELETE FROM account_profiles WHERE id = ${accountId}`);
  await pool.end();
});

describe("pipeline summary", () => {
  it("reproduces the funnel and dollars from stored rows", async () => {
    const p = await pipelineSummary(db, accountId);
    expect(p.surfacedByOtn).toBe(3); // archived opportunity is not surfaced
    expect(p.pursuitsStarted).toBe(3);
    expect(p.reachedBidding).toBe(3); // bid_confirmed, submitted, won all count
    expect(p.reachedSubmission).toBe(2); // submitted + won
    expect(p.won).toBe(1);
    expect(p.lost).toBe(0);
    expect(p.wonValueUsd).toBe(120_000);
    // in flight = active pursuits (submitted counts as active; won does not)
    expect(p.inFlightValueUsd).toBe(80_000 + 40_000);
    expect(p.influencedValueUsd).toBe(120_000);
  });

  it("returns zeros/nulls for an account with no pursuits — never fabricated", async () => {
    const [empty] = await db.insert(accountProfiles).values({
      key: `test_pipe_empty_${RUN.toLowerCase()}`, name: `Pipe Empty ${RUN}`, active: true,
      capabilitiesJson: [], territoryJson: {}, deliveryConfigJson: {},
    }).returning({ id: accountProfiles.id });
    try {
      const p = await pipelineSummary(db, empty!.id);
      expect(p.surfacedByOtn).toBe(0);
      expect(p.pursuitsStarted).toBe(0);
      expect(p.wonValueUsd).toBe(0);
      expect(p.medianAdvanceNoticeDays).toBeNull();
    } finally {
      await db.execute(sql`DELETE FROM account_profiles WHERE id = ${empty!.id}`);
    }
  });
});
