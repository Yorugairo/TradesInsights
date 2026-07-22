/**
 * S2 (strengthening addendum §4/§13) — pursuit state machine: invalid
 * transitions are blocked, human-only states reject AI/system actors, outcomes
 * and no-bids require reasons/dates, and every transition is audited. Proves a
 * full qualified → … → won walk and that every active pursuit has state + owner.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type pg from "pg";
import {
  accountProfiles, coverageEntries, evidenceItems, opportunities, projectEvents,
  projects, rawArtifacts, sourceRecords, sourceRuns, type Db,
} from "@otn/db";
import {
  PursuitError, addPursuitNote, addPursuitTask, createPursuit, listPursuits, transitionPursuit,
} from "@otn/intelligence";
import { deleteTestProjects, resetSource, testDb } from "./helpers.js";

const RUN = randomUUID().slice(0, 8).toUpperCase();
let db: Db;
let pool: pg.Pool;
let sourceId: string;
let accountId: string;
let projectId: string;
let project2Id: string;
let oppId: string;
let opp2Id: string;
let pursuitId: string;

beforeAll(async () => {
  ({ db, pool } = await testDb());
  sourceId = await resetSource(db, "fake_source");
  await db.update(coverageEntries).set({ freshnessState: "green" }).where(eq(coverageEntries.sourceId, sourceId));
  const [run] = await db.insert(sourceRuns).values({ sourceId, status: "succeeded" }).returning({ id: sourceRuns.id });
  const [art] = await db.insert(rawArtifacts).values({
    sourceId, sourceRunId: run!.id, canonicalUrl: `https://example.invalid/pursuit/${RUN}`,
    retrievedAt: new Date(), contentType: "text/html", httpStatus: 200,
    storageKey: `raw/fake_source/pursuit-${RUN}`, sha256: RUN.padEnd(64, "5").toLowerCase(), byteSize: 5,
    headersJson: {}, parserVersion: "test",
  }).returning({ id: rawArtifacts.id });

  const [acct] = await db.insert(accountProfiles).values({
    key: `test_pursuit_${RUN.toLowerCase()}`, name: `Pursuit ${RUN}`, active: true,
    capabilitiesJson: [], territoryJson: {}, deliveryConfigJson: { weekly_digest_min: 65 },
  }).returning({ id: accountProfiles.id });
  accountId = acct!.id;

  const [project] = await db.insert(projects).values({
    canonicalName: `PURSUIT-${RUN}`, permittingJurisdiction: "Test Jurisdiction", county: "Thurston",
    currentStage: "permit_issued", firstSeenAt: new Date(), lastSeenAt: new Date(),
  }).returning({ id: projects.id });
  projectId = project!.id;
  const [rec] = await db.insert(sourceRecords).values({
    sourceId, rawArtifactId: art!.id, externalId: `PURSUIT-${RUN}`, recordType: "permit",
    firstSeenAt: new Date(), lastSeenAt: new Date(), rawFieldsJson: {},
    normalizedJson: { title: `PURSUIT-${RUN}` }, normalizedFingerprint: `pursuit-${RUN}`,
  }).returning({ id: sourceRecords.id });
  await db.execute(sql`
    INSERT INTO record_resolutions (source_record_id, project_id, resolver_version, matched_rule, features_json, score, decision, status)
    VALUES (${rec!.id}, ${projectId}, 'test', 'new_project', '{}', 1, 'auto', 'active')`);
  await db.insert(projectEvents).values({
    projectId, sourceRecordId: rec!.id, eventType: "permit_issued",
    eventDate: new Date(Date.now() - 2 * 86_400_000), observedAt: new Date(Date.now() - 2 * 86_400_000),
    resultingStage: "permit_issued", materialChange: true, confirmed: true, confidence: 1,
  });
  await db.insert(evidenceItems).values({
    sourceRecordId: rec!.id, rawArtifactId: art!.id, factPath: "project.stage",
    evidenceText: "Permit issued.", pageOrSection: "desc",
    sourceUrl: `https://example.invalid/pursuit/${RUN}`, authorityGrade: "A", parserVersion: "test",
  });
  const [opp] = await db.insert(opportunities).values({
    accountProfileId: accountId, projectId, currentScore: 84, route: "interior_trades",
    state: "priority_review", firstQualifiedAt: new Date(),
  }).returning({ id: opportunities.id });
  oppId = opp!.id;

  // A second, minimal project+opportunity for the fresh-pursuit guard tests
  // (opportunities are unique per account+project).
  const [p2] = await db.insert(projects).values({
    canonicalName: `PURSUIT2-${RUN}`, permittingJurisdiction: "Test Jurisdiction", county: "Thurston",
    currentStage: "permit_applied", firstSeenAt: new Date(), lastSeenAt: new Date(),
  }).returning({ id: projects.id });
  project2Id = p2!.id;
  const [opp2] = await db.insert(opportunities).values({
    accountProfileId: accountId, projectId: project2Id, currentScore: 70, route: "interior_trades", state: "weekly_digest",
  }).returning({ id: opportunities.id });
  opp2Id = opp2!.id;
});

afterAll(async () => {
  const ownPursuits = sql`(SELECT id FROM pursuits WHERE account_profile_id = ${accountId})`;
  await db.execute(sql`DELETE FROM pursuit_notes WHERE pursuit_id IN ${ownPursuits}`);
  await db.execute(sql`DELETE FROM pursuit_tasks WHERE pursuit_id IN ${ownPursuits}`);
  await db.execute(sql`DELETE FROM pursuit_transitions WHERE pursuit_id IN ${ownPursuits}`);
  await db.execute(sql`DELETE FROM pursuits WHERE account_profile_id = ${accountId}`);
  await db.execute(sql`DELETE FROM decision_labels WHERE account_profile_id = ${accountId}`);
  await db.execute(sql`DELETE FROM opportunities WHERE account_profile_id = ${accountId}`);
  await deleteTestProjects(db, [projectId, project2Id]);
  await db.execute(sql`DELETE FROM account_profiles WHERE id = ${accountId}`);
  await pool.end();
});

describe("S2 pursuit state machine", () => {
  it("opens at discovered with an owner, then qualifies (gate not failed)", async () => {
    const { id } = await createPursuit(db, { accountProfileId: accountId, opportunityId: oppId, ownerUserId: "alice" });
    pursuitId = id;
    await transitionPursuit(db, pursuitId, "qualified", { actorType: "human", actorId: "alice" });
    const list = await listPursuits(db, accountId);
    const p = list.find((x) => x.id === pursuitId)!;
    expect(p.state).toBe("qualified");
    expect(p.ownerUserId).toBe("alice"); // every active pursuit has an owner
  });

  it("blocks an invalid transition (qualified → submitted)", async () => {
    await expect(transitionPursuit(db, pursuitId, "submitted", { actorType: "human" })).rejects.toMatchObject({
      code: "invalid_transition",
    });
  });

  it("human-only states reject an AI actor", async () => {
    await transitionPursuit(db, pursuitId, "bid_confirmed", { actorType: "human" });
    await transitionPursuit(db, pursuitId, "bid_decision_pending", { actorType: "system" });
    await expect(transitionPursuit(db, pursuitId, "estimating", { actorType: "ai" })).rejects.toMatchObject({
      code: "human_required",
    });
  });

  it("walks estimating → submitted → won with required data", async () => {
    await transitionPursuit(db, pursuitId, "estimating", { actorType: "human", metadata: { value: 250000 } });
    await expect(transitionPursuit(db, pursuitId, "submitted", { actorType: "human" })).rejects.toMatchObject({
      code: "missing_submission",
    });
    await transitionPursuit(db, pursuitId, "submitted", {
      actorType: "human", metadata: { submittedAt: new Date().toISOString(), value: 240000 },
    });
    await expect(transitionPursuit(db, pursuitId, "won", { actorType: "human", reason: "low bid" })).rejects.toMatchObject({
      code: "missing_outcome_date",
    });
    await transitionPursuit(db, pursuitId, "won", {
      actorType: "human", reason: "low bid", metadata: { outcomeDate: "2026-08-01", value: 240000 },
    });
    const row = await db.execute(sql`SELECT state, submitted_value, outcome_value FROM pursuits WHERE id = ${pursuitId}`);
    const p = row.rows[0] as { state: string; submitted_value: number; outcome_value: number };
    expect(p.state).toBe("won");
    expect(Number(p.submitted_value)).toBe(240000);
    expect(Number(p.outcome_value)).toBe(240000);
  });

  it("won emits a pursuit_outcome decision label with the decision-time snapshot (4A.2)", async () => {
    const labels = (await db.execute(sql`
      SELECT kind, decided_by, reason, snapshot FROM decision_labels
      WHERE account_profile_id = ${accountId} AND opportunity_id = ${oppId} AND kind = 'pursuit_outcome'`)).rows as {
      kind: string; decided_by: string; reason: string | null; snapshot: Record<string, unknown>;
    }[];
    expect(labels).toHaveLength(1);
    expect(labels[0]!.reason).toBe("low bid");
    expect(labels[0]!.snapshot["outcome"]).toBe("won");
    expect(labels[0]!.snapshot["fromState"]).toBe("submitted");
    expect(Number(labels[0]!.snapshot["score"])).toBe(84);
    expect(Number(labels[0]!.snapshot["outcomeValue"])).toBe(240000);
    // Non-outcome transitions never label: the whole walk produced exactly one.
    const all = (await db.execute(sql`
      SELECT count(*) AS n FROM decision_labels WHERE account_profile_id = ${accountId}`)).rows as { n: string }[];
    expect(Number(all[0]!.n)).toBe(1);
  });

  it("records every transition (auditable history)", async () => {
    const res = await db.execute(sql`SELECT count(*) AS n FROM pursuit_transitions WHERE pursuit_id = ${pursuitId}`);
    // opened + qualified + bid_confirmed + bid_decision_pending + estimating + submitted + won = 7
    expect(Number((res.rows[0] as { n: string }).n)).toBe(7);
  });

  it("won → no_bid is invalid; tasks validate their type and notes attach", async () => {
    await expect(
      transitionPursuit(db, pursuitId, "no_bid", { actorType: "human", reason: "x" }),
    ).rejects.toMatchObject({ code: "invalid_transition" }); // won → no_bid is not allowed
    await expect(addPursuitTask(db, pursuitId, { title: "x", taskType: "not_a_type" })).rejects.toMatchObject({
      code: "invalid_task_type",
    });
    await addPursuitTask(db, pursuitId, { title: "Verify the GC", taskType: "verify_gc", ownerUserId: "alice" });
    await addPursuitNote(db, pursuitId, { authorUserId: "alice", body: "Won — schedule follow-up." });
  });

  it("no_bid on a fresh pursuit needs a reason, then closes with one", async () => {
    const { id } = await createPursuit(db, { accountProfileId: accountId, opportunityId: opp2Id, ownerUserId: "carol" });
    await expect(transitionPursuit(db, id, "no_bid", { actorType: "human" })).rejects.toMatchObject({
      code: "missing_reason",
    });
    await transitionPursuit(db, id, "no_bid", { actorType: "human", reason: "out of territory" });
    const row = await db.execute(sql`SELECT state FROM pursuits WHERE id = ${id}`);
    expect((row.rows[0] as { state: string }).state).toBe("no_bid");
  });

  it("PursuitError is the thrown type", () => {
    expect(new PursuitError("not_found", "x")).toBeInstanceOf(Error);
  });
});
