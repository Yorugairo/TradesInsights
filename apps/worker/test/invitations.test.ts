/**
 * S3 (strengthening addendum §6/§13) — bid-invitation ingestion: idempotent
 * duplicate messages, account isolation, deadline changes recorded as
 * append-only events (both deadlines preserved), and ambiguous project matches
 * entering review. Deterministic — no model, no portal scraping.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { accountProfiles, opportunities, projects, type Db } from "@otn/db";
import { getInvitation, ingestInvitation, listInvitations } from "@otn/intelligence";
import { deleteTestProjects, testDb } from "./helpers.js";

const RUN = randomUUID().slice(0, 8).toUpperCase();
let db: Db;
let pool: pg.Pool;
let accountA: string;
let accountB: string;
let projectMatch: string;
let projectMatch2: string;

function eml(messageId: string, project: string, due: string): string {
  return `From: "Acme Builders" <estimating@acme-gc.com>
To: bids@solis.example
Subject: Invitation to Bid
Date: Mon, 20 Jul 2026 09:00:00 -0700
Message-ID: <${messageId}>

You are invited to submit a bid.
Project: ${project}
Scope: Division 09 drywall and painting
Bids due: ${due}
`;
}

async function mkAccount(key: string): Promise<string> {
  const [a] = await db.insert(accountProfiles).values({
    key, name: key, active: true, capabilitiesJson: [], territoryJson: {}, deliveryConfigJson: {},
  }).returning({ id: accountProfiles.id });
  return a!.id;
}
async function mkProjectWithOpp(name: string, accountId: string): Promise<string> {
  const [p] = await db.insert(projects).values({
    canonicalName: name, permittingJurisdiction: "Test Jurisdiction", county: "Thurston",
    currentStage: "permit_applied", firstSeenAt: new Date(), lastSeenAt: new Date(),
  }).returning({ id: projects.id });
  await db.insert(opportunities).values({
    accountProfileId: accountId, projectId: p!.id, currentScore: 80, route: "interior_trades", state: "priority_review",
  });
  return p!.id;
}

beforeAll(async () => {
  ({ db, pool } = await testDb());
  accountA = await mkAccount(`test_inv_a_${RUN.toLowerCase()}`);
  accountB = await mkAccount(`test_inv_b_${RUN.toLowerCase()}`);
  projectMatch = await mkProjectWithOpp(`Lakewood Medical ${RUN} Office TI Building A`, accountA);
});

afterAll(async () => {
  for (const acct of [accountA, accountB]) {
    await db.execute(sql`DELETE FROM bid_invitation_events WHERE bid_invitation_id IN (SELECT id FROM bid_invitations WHERE account_profile_id = ${acct})`);
    await db.execute(sql`DELETE FROM bid_invitations WHERE account_profile_id = ${acct}`);
    await db.execute(sql`DELETE FROM inbound_messages WHERE account_profile_id = ${acct}`);
    await db.execute(sql`DELETE FROM opportunities WHERE account_profile_id = ${acct}`);
  }
  await deleteTestProjects(db, [projectMatch, projectMatch2].filter(Boolean));
  await db.execute(sql`DELETE FROM account_profiles WHERE id IN (${accountA}, ${accountB})`);
  await pool.end();
});

describe("S3 invitation ingestion", () => {
  let invitationId: string;

  it("ingests a matched invitation, then dedupes a duplicate forward", async () => {
    const r1 = await ingestInvitation(db, {
      accountProfileId: accountA, provider: "eml", providerMessageId: "fallback-1",
      rawEml: eml(`inv-1-${RUN}`, `Lakewood Medical ${RUN} Office TI`, "July 30, 2026 2:00 PM"),
    });
    expect(r1.deduped).toBe(false);
    expect(r1.matchStatus).toBe("matched");
    expect(r1.invitationId).toBeTruthy();
    invitationId = r1.invitationId!;

    const dup = await ingestInvitation(db, {
      accountProfileId: accountA, provider: "eml", providerMessageId: "fallback-1",
      rawEml: eml(`inv-1-${RUN}`, `Lakewood Medical ${RUN} Office TI`, "July 30, 2026 2:00 PM"),
    });
    expect(dup.deduped).toBe(true); // same Message-ID → ingested once
  });

  it("a later deadline creates an append-only deadline_changed event (both preserved)", async () => {
    const r = await ingestInvitation(db, {
      accountProfileId: accountA, provider: "eml", providerMessageId: "fallback-2",
      rawEml: eml(`inv-2-${RUN}`, `Lakewood Medical ${RUN} Office TI`, "August 6, 2026 2:00 PM"),
    });
    expect(r.deadlineChanged).toBe(true);
    const detail = (await getInvitation(db, invitationId))!;
    const change = detail.events.find((e) => e.eventType === "deadline_changed")!;
    expect(change).toBeTruthy();
    const meta = change.metadata as { priorBidDueAt: string; revisedBidDueAt: string; verified: boolean };
    expect(meta.priorBidDueAt).toBeTruthy();
    expect(meta.revisedBidDueAt).toBeTruthy();
    expect(meta.verified).toBe(false); // human must verify before a deadline alert
  });

  it("an ambiguous project match enters review (no silent guess)", async () => {
    projectMatch2 = await mkProjectWithOpp(`Lakewood Medical ${RUN} Center Renovation`, accountA);
    const r = await ingestInvitation(db, {
      accountProfileId: accountA, provider: "eml", providerMessageId: "fallback-3",
      rawEml: eml(`inv-3-${RUN}`, `Lakewood Medical ${RUN}`, "September 1, 2026"),
    });
    expect(r.matchStatus).toBe("review");
  });

  it("private invitations are account-scoped (invisible to another account)", async () => {
    const listA = await listInvitations(db, accountA);
    expect(listA.length).toBeGreaterThan(0);
    const listB = await listInvitations(db, accountB);
    expect(listB).toHaveLength(0);
    const detail = (await getInvitation(db, invitationId))!;
    expect(detail.accountProfileId).toBe(accountA);
  });
});
