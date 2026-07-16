/**
 * S1 (strengthening addendum §3) — opportunity decision memo: deterministic
 * assembly over stored gate/extraction/verification/capacity/score rows, with
 * facts separated from inferences, procurement state that never calls a permit a
 * bid, capacity surfaced, and content-hash-versioned regenerate (idempotent).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type pg from "pg";
import {
  evidenceItems, opportunities, projectEvents, projects, rawArtifacts,
  sourceRecords, sourceRuns, type Db,
} from "@otn/db";
import {
  MockProvider, buildDecisionMemo, extractProject, persistDecisionMemo,
  latestDecisionMemo, verifyProject,
} from "@otn/intelligence";
import { deleteTestProjects, resetSource, testDb } from "./helpers.js";

const RUN = randomUUID().slice(0, 8).toUpperCase();
const BUDGET = { monthlyCapUsd: 100, perJobCapUsd: 0.5 };

let db: Db;
let pool: pg.Pool;
let sourceId: string;
let projectId: string;
let oppId: string;

beforeAll(async () => {
  ({ db, pool } = await testDb());
  sourceId = await resetSource(db, "fake_source");
  const [run] = await db.insert(sourceRuns).values({ sourceId, status: "succeeded" }).returning({ id: sourceRuns.id });
  const [art] = await db.insert(rawArtifacts).values({
    sourceId, sourceRunId: run!.id, canonicalUrl: `https://example.invalid/memo/${RUN}`,
    retrievedAt: new Date(), contentType: "application/json", httpStatus: 200,
    storageKey: `raw/fake_source/memo-${RUN}`, sha256: RUN.padEnd(64, "3").toLowerCase(), byteSize: 3,
    headersJson: {}, parserVersion: "test",
  }).returning({ id: rawArtifacts.id });

  const [project] = await db.insert(projects).values({
    canonicalName: `MEMO-${RUN}`, permittingJurisdiction: "Test Jurisdiction", county: "Thurston",
    currentStage: "permit_issued", firstSeenAt: new Date(), lastSeenAt: new Date(),
  }).returning({ id: projects.id });
  projectId = project!.id;
  const [rec] = await db.insert(sourceRecords).values({
    sourceId, rawArtifactId: art!.id, externalId: `MEMO-${RUN}`, recordType: "permit",
    firstSeenAt: new Date(), lastSeenAt: new Date(), rawFieldsJson: {},
    normalizedJson: { title: `MEMO-${RUN}`, units: 20 }, normalizedFingerprint: `memo-${RUN}`,
  }).returning({ id: sourceRecords.id });
  await db.execute(sql`
    INSERT INTO record_resolutions (source_record_id, project_id, resolver_version, matched_rule, features_json, score, decision, status)
    VALUES (${rec!.id}, ${projectId}, 'test', 'new_project', '{}', 1, 'auto', 'active')`);
  await db.insert(projectEvents).values({
    projectId, sourceRecordId: rec!.id, eventType: "permit_issued",
    eventDate: new Date(Date.now() - 3 * 86_400_000), observedAt: new Date(Date.now() - 3 * 86_400_000),
    resultingStage: "permit_issued", materialChange: true, confirmed: true, confidence: 1,
  });
  const [ev] = await db.insert(evidenceItems).values({
    sourceRecordId: rec!.id, rawArtifactId: art!.id, factPath: "project.units",
    evidenceText: `MEMO-${RUN}: 20 units.`, pageOrSection: "desc",
    sourceUrl: `https://example.invalid/memo/${RUN}`, authorityGrade: "A", parserVersion: "test",
  }).returning({ id: evidenceItems.id });

  const acct = await db.execute(sql`SELECT id FROM account_profiles WHERE key = 'solis_interiors'`);
  const solisId = (acct.rows[0] as { id: string }).id;
  const [opp] = await db.insert(opportunities).values({
    accountProfileId: solisId,
    projectId, currentScore: 84, route: "interior_trades", state: "priority_review",
    firstQualifiedAt: new Date(),
    rationaleJson: {
      components: { trade_fit: 0.8, package_size_fit: 1, timing: 0.9, geography: 1, evidence_quality: 1 },
      signals: ["drywall_painting_keywords"], route: "interior_trades",
      capacity: { assessment: "likely_fit", explanation: "within serviceable range", provisional: true },
    },
  }).returning({ id: opportunities.id });
  oppId = opp!.id;

  await extractProject(db, new MockProvider([{ text: JSON.stringify({
    facts: [{ path: "project.units", value: 20, evidenceId: ev!.id, confirmed: true, confidence: 0.97 }],
    inferences: [{ type: "trade_fit", value: "interior_plausible", evidenceIds: [ev!.id], confidence: 0.7, reason: "TI scope" }],
    missingCriticalFacts: ["general_contractor"],
  }) }]), projectId, { budget: BUDGET });
  await verifyProject(db, new MockProvider([{ text: JSON.stringify({
    verdicts: [{ path: "project.units", evidenceId: ev!.id, supported: true, reason: "stated" }],
  }) }]), projectId, { budget: BUDGET });
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM opportunity_decision_memos WHERE opportunity_id = ${oppId}`);
  await db.execute(sql`DELETE FROM opportunities WHERE id = ${oppId}`);
  await deleteTestProjects(db, [projectId]);
  await pool.end();
});

describe("S1 decision memo", () => {
  it("assembles facts vs inferences vs missing, with evidenced facts and score components", async () => {
    const memo = (await buildDecisionMemo(db, oppId))!;
    expect(memo).toBeTruthy();
    expect(memo.confirmedFacts).toHaveLength(1);
    expect(memo.confirmedFacts[0]!.evidenceIds.length).toBeGreaterThan(0); // no unsupported facts
    expect(memo.inferences[0]!.type).toBe("trade_fit");
    expect(memo.missingCriticalFacts[0]!.key).toBe("general_contractor");
    // Deterministic score is preserved; components carry their §12 weights.
    expect(memo.score).toBe(84);
    const tradeFit = memo.scoreComponents.find((c) => c.key === "trade_fit")!;
    expect(tradeFit.weight).toBeGreaterThan(0);
    expect(memo.capacityAssessment).toBe("likely_fit");
  });

  it("a permit-issued project is 'monitoring', never bidding_confirmed", async () => {
    const memo = (await buildDecisionMemo(db, oppId))!;
    expect(memo.procurementState).toBe("monitoring");
    expect(memo.verifierStatus).toBe("passed"); // gate passes for this project
  });

  it("regenerate is idempotent: unchanged content does not mint a new version", async () => {
    const first = (await persistDecisionMemo(db, oppId))!;
    expect(first.created).toBe(true);
    expect(first.decisionVersion).toBe(1);

    const second = (await persistDecisionMemo(db, oppId))!;
    expect(second.created).toBe(false); // same content hash
    expect(second.decisionVersion).toBe(1);

    const latest = await latestDecisionMemo(db, oppId);
    expect(latest?.decisionVersion).toBe(1);
  });

  it("a real change mints a new version", async () => {
    await db.update(opportunities).set({ currentScore: 91 }).where(eq(opportunities.id, oppId));
    const bumped = (await persistDecisionMemo(db, oppId))!;
    expect(bumped.created).toBe(true);
    expect(bumped.decisionVersion).toBe(2);
    expect(bumped.memo.score).toBe(91);
  });
});
