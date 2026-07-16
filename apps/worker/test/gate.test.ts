/**
 * M3.4 — independent verifier + §15 publication gate: every gate condition
 * exercised against real stored rows, verifier verdicts consumed from
 * model_runs, and the visible blocked_on_verifier state without keys.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type pg from "pg";
import {
  accountProfiles,
  coverageEntries,
  evidenceItems,
  opportunities,
  projectEvents,
  projects,
  rawArtifacts,
  sourceRecords,
  sourceRuns,
  type Db,
} from "@otn/db";
import {
  MockProvider,
  evaluateGate,
  extractProject,
  verifyProject,
  type GateResult,
} from "@otn/intelligence";
import { deleteTestProjects, resetSource, testDb } from "./helpers.js";

const RUN = randomUUID().slice(0, 8).toUpperCase();
const BUDGET = { monthlyCapUsd: 100, perJobCapUsd: 0.5 };

let db: Db;
let pool: pg.Pool;
let sourceId: string;
let projectId: string;
let opportunityId: string;
let recordId: string;
let evUnitsId: string;
let evApplicantId: string;

function check(result: GateResult, name: string) {
  const c = result.checks.find((c) => c.name === name);
  if (!c) throw new Error(`missing gate check ${name}`);
  return c;
}

async function runValidExtraction(): Promise<void> {
  const provider = new MockProvider([
    {
      text: JSON.stringify({
        facts: [
          { path: "project.units", value: 78, evidenceId: evUnitsId, confirmed: true, confidence: 0.99 },
        ],
        inferences: [
          {
            type: "trade_fit",
            value: "interior_plausible",
            evidenceIds: [evApplicantId],
            confidence: 0.7,
            reason: "TI description without package detail.",
          },
        ],
        missingCriticalFacts: ["general_contractor"],
      }),
    },
  ]);
  const result = await extractProject(db, provider, projectId, { budget: BUDGET });
  expect(result.status).toBe("succeeded");
}

function verifierResponse(supported: boolean, reason: string) {
  return JSON.stringify({
    verdicts: [{ path: "project.units", evidenceId: evUnitsId, supported, reason }],
  });
}

beforeAll(async () => {
  ({ db, pool } = await testDb());
  sourceId = await resetSource(db, "fake_source");
  await db
    .update(coverageEntries)
    .set({ freshnessState: "green" })
    .where(eq(coverageEntries.sourceId, sourceId));

  const [run] = await db
    .insert(sourceRuns)
    .values({ sourceId, status: "succeeded" })
    .returning({ id: sourceRuns.id });
  const [artifact] = await db
    .insert(rawArtifacts)
    .values({
      sourceId,
      sourceRunId: run!.id,
      canonicalUrl: `https://example.invalid/gate-test/${RUN}`,
      retrievedAt: new Date(),
      contentType: "application/json",
      httpStatus: 200,
      storageKey: `raw/fake_source/gate-test-${RUN}`,
      sha256: RUN.padEnd(64, "1").toLowerCase(),
      byteSize: 2,
      headersJson: {},
      parserVersion: "test",
    })
    .returning({ id: rawArtifacts.id });

  const [project] = await db
    .insert(projects)
    .values({
      canonicalName: `GATE-${RUN} Tenant Improvement`,
      permittingJurisdiction: "Test Jurisdiction",
      county: "Thurston",
      currentStage: "permit_applied",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    })
    .returning({ id: projects.id });
  projectId = project!.id;

  const [record] = await db
    .insert(sourceRecords)
    .values({
      sourceId,
      rawArtifactId: artifact!.id,
      externalId: `GATE-${RUN}`,
      recordType: "permit",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      rawFieldsJson: {},
      normalizedJson: { title: `GATE-${RUN} Tenant Improvement` },
      normalizedFingerprint: `gate-test-${RUN}`,
    })
    .returning({ id: sourceRecords.id });
  recordId = record!.id;

  await db.execute(sql`
    INSERT INTO record_resolutions
      (source_record_id, project_id, resolver_version, matched_rule,
       features_json, score, decision, status)
    VALUES (${recordId}, ${projectId}, 'test', 'new_project', '{}', 1, 'auto', 'active')`);

  await db.insert(projectEvents).values({
    projectId,
    sourceRecordId: recordId,
    eventType: "permit_application",
    eventDate: new Date(),
    observedAt: new Date(),
    resultingStage: "permit_applied",
    materialChange: true,
    confirmed: true,
    confidence: 1,
  });

  const inserted = await db
    .insert(evidenceItems)
    .values([
      {
        sourceRecordId: recordId,
        rawArtifactId: artifact!.id,
        factPath: "project.units",
        evidenceText: "Tenant improvement of 78 suites, interior walls and finishes.",
        pageOrSection: "description",
        sourceUrl: `https://example.invalid/gate-test/${RUN}`,
        authorityGrade: "A",
        parserVersion: "test",
      },
      {
        sourceRecordId: recordId,
        rawArtifactId: artifact!.id,
        factPath: "roles.applicant",
        evidenceText: "Applicant: Gate Test Interiors LLC.",
        pageOrSection: "parties",
        sourceUrl: `https://example.invalid/gate-test/${RUN}`,
        authorityGrade: "A",
        parserVersion: "test",
      },
    ])
    .returning({ id: evidenceItems.id, factPath: evidenceItems.factPath });
  evUnitsId = inserted.find((r) => r.factPath === "project.units")!.id;
  evApplicantId = inserted.find((r) => r.factPath === "roles.applicant")!.id;

  const [account] = await db.select({ id: accountProfiles.id }).from(accountProfiles).limit(1);
  const [opp] = await db
    .insert(opportunities)
    .values({
      accountProfileId: account!.id,
      projectId,
      currentScore: 72,
      state: "weekly_digest",
    })
    .returning({ id: opportunities.id });
  opportunityId = opp!.id;

  await runValidExtraction();
});

afterAll(async () => {
  await db.delete(opportunities).where(eq(opportunities.projectId, projectId));
  await deleteTestProjects(db, [projectId]);
  await pool.end();
});

describe("M3.4 publication gate (spec §15)", () => {
  it("is blocked_on_verifier (visible, not fail) before any verification runs", async () => {
    const result = (await evaluateGate(db, opportunityId))!;
    expect(result.status).toBe("blocked_on_verifier");
    expect(result.publishable).toBe(false);
    expect(check(result, "verifier").pass).toBeNull();
    // Every deterministic check already passes.
    for (const c of result.checks.filter((c) => c.name !== "verifier")) {
      expect(c.pass, `${c.name}: ${c.detail}`).toBe(true);
    }
  });

  it("stays blocked (never passes) when verification itself is key-blocked", async () => {
    const v = await verifyProject(db, null, projectId, { budget: BUDGET });
    expect(v.status).toBe("blocked");
    const result = (await evaluateGate(db, opportunityId))!;
    expect(result.status).toBe("blocked_on_verifier");
  });

  it("publishes only after the independent verifier supports every fact", async () => {
    const v = await verifyProject(
      db,
      new MockProvider([{ text: verifierResponse(true, "78 suites stated explicitly") }]),
      projectId,
      { budget: BUDGET },
    );
    expect(v.status).toBe("succeeded");
    expect(v.allSupported).toBe(true);

    const result = (await evaluateGate(db, opportunityId))!;
    expect(result.status).toBe("pass");
    expect(result.publishable).toBe(true);
  });

  it("fails when the verifier rejects an unsupported fact (§11 reject rules)", async () => {
    await verifyProject(
      db,
      new MockProvider([{ text: verifierResponse(false, "unit count is not stated in the cited text") }]),
      projectId,
      { budget: BUDGET },
    );
    const result = (await evaluateGate(db, opportunityId))!;
    expect(result.status).toBe("fail");
    expect(check(result, "verifier").detail).toContain("project.units");
    // Restore a passing verification for later tests.
    await verifyProject(db, new MockProvider([{ text: verifierResponse(true, "stated") }]), projectId, {
      budget: BUDGET,
    });
  });

  it("suppresses opportunities supported only by a red source", async () => {
    await db
      .update(coverageEntries)
      .set({ freshnessState: "red" })
      .where(eq(coverageEntries.sourceId, sourceId));
    const result = (await evaluateGate(db, opportunityId))!;
    expect(result.status).toBe("fail");
    expect(check(result, "source_health").detail).toContain("suppressed");
    await db
      .update(coverageEntries)
      .set({ freshnessState: "green" })
      .where(eq(coverageEntries.sourceId, sourceId));
  });

  it("fails without A-grade evidence on the core event", async () => {
    await db.update(evidenceItems).set({ authorityGrade: "B" }).where(eq(evidenceItems.sourceRecordId, recordId));
    const result = (await evaluateGate(db, opportunityId))!;
    expect(check(result, "a_grade_core_event").pass).toBe(false);
    await db.update(evidenceItems).set({ authorityGrade: "A" }).where(eq(evidenceItems.sourceRecordId, recordId));
  });

  it("fails facts_evidenced when a model fact cites D-grade (never publishable) or lone C-grade evidence", async () => {
    await db.update(evidenceItems).set({ authorityGrade: "D" }).where(eq(evidenceItems.id, evUnitsId));
    let result = (await evaluateGate(db, opportunityId))!;
    expect(check(result, "facts_evidenced").detail).toContain("D-grade");

    await db.update(evidenceItems).set({ authorityGrade: "C" }).where(eq(evidenceItems.id, evUnitsId));
    result = (await evaluateGate(db, opportunityId))!;
    expect(check(result, "facts_evidenced").detail).toContain("C-grade");

    await db.update(evidenceItems).set({ authorityGrade: "A" }).where(eq(evidenceItems.id, evUnitsId));
  });

  it("fails while an identity contradiction is pending review", async () => {
    await db.execute(sql`
      INSERT INTO resolution_reviews
        (source_record_id, candidate_project_id, matched_rule, features_json,
         score, reasons_json, resolver_version, status)
      VALUES (${recordId}, ${projectId}, 'address_name', '{}', 0.5, '["generic_name"]', 'test', 'pending')`);
    const result = (await evaluateGate(db, opportunityId))!;
    expect(check(result, "no_identity_contradiction").pass).toBe(false);
    await db.execute(sql`
      DELETE FROM resolution_reviews WHERE source_record_id = ${recordId} AND status = 'pending'`);
  });

  it("fails when activity is stale for trade timing (§15 active/current)", async () => {
    const old = new Date(Date.now() - 400 * 86_400_000);
    await db.update(projectEvents).set({ eventDate: old, observedAt: old }).where(eq(projectEvents.projectId, projectId));
    const result = (await evaluateGate(db, opportunityId))!;
    expect(check(result, "timing_current").pass).toBe(false);
    const now = new Date();
    await db.update(projectEvents).set({ eventDate: now, observedAt: now }).where(eq(projectEvents.projectId, projectId));
  });

  it("fails below the account's digest threshold", async () => {
    await db.update(opportunities).set({ currentScore: 40 }).where(eq(opportunities.id, opportunityId));
    const result = (await evaluateGate(db, opportunityId))!;
    expect(check(result, "score_threshold").pass).toBe(false);
    await db.update(opportunities).set({ currentScore: 72 }).where(eq(opportunities.id, opportunityId));
  });

  it("fails (not blocked) when the latest verification was rejected for contract violations", async () => {
    const v = await verifyProject(
      db,
      new MockProvider([{ text: "Everything looks fine to me." }]),
      projectId,
      { budget: BUDGET },
    );
    expect(v.status).toBe("rejected");
    const result = (await evaluateGate(db, opportunityId))!;
    expect(result.status).toBe("fail");
    expect(check(result, "verifier").detail).toContain("rejected");
  });

  it("ends publishable once a clean verification lands again", async () => {
    await verifyProject(db, new MockProvider([{ text: verifierResponse(true, "stated") }]), projectId, {
      budget: BUDGET,
    });
    const result = (await evaluateGate(db, opportunityId))!;
    expect(result.status).toBe("pass");
    expect(result.publishable).toBe(true);
  });
});
