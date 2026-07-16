/**
 * M3.3 — model extraction pipeline (spec §13): contract enforcement against
 * real stored evidence, model_runs persistence (provider/model/prompt
 * version/tokens/cost/latency/result hash), budget blocks, and the visible
 * blocked state without a model key. Uses the MockProvider — the real
 * Anthropic provider is key-activated and exercises the same code path.
 */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type pg from "pg";
import {
  accountProfiles,
  evidenceItems,
  modelRuns,
  opportunities,
  projects,
  rawArtifacts,
  sourceRecords,
  sourceRuns,
  type Db,
} from "@otn/db";
import {
  MockProvider,
  extractProject,
  listExtractionCandidates,
  type ModelExtraction,
} from "@otn/intelligence";
import { deleteTestProjects, resetSource, testDb } from "./helpers.js";

const RUN = randomUUID().slice(0, 8).toUpperCase();

let db: Db;
let pool: pg.Pool;
let projectId: string;
let evidenceUnitsId: string;
let evidenceGcId: string;
let accountId: string;

const BUDGET = { monthlyCapUsd: 100, perJobCapUsd: 0.5 };

function validPayload(): ModelExtraction {
  return {
    facts: [
      {
        path: "project.units",
        value: 78,
        evidenceId: evidenceUnitsId,
        confirmed: true,
        confidence: 0.99,
      },
    ],
    inferences: [
      {
        type: "trade_fit",
        value: "commercial_glazing_plausible",
        evidenceIds: [evidenceGcId],
        confidence: 0.72,
        reason: "System and package are not stated.",
      },
    ],
    missingCriticalFacts: ["procurement_status", "bid_date"],
  };
}

beforeAll(async () => {
  ({ db, pool } = await testDb());
  const sourceId = await resetSource(db, "fake_source");
  const [run] = await db
    .insert(sourceRuns)
    .values({ sourceId, status: "succeeded" })
    .returning({ id: sourceRuns.id });
  const [artifact] = await db
    .insert(rawArtifacts)
    .values({
      sourceId,
      sourceRunId: run!.id,
      canonicalUrl: `https://example.invalid/extraction-test/${RUN}`,
      retrievedAt: new Date(),
      contentType: "application/json",
      httpStatus: 200,
      storageKey: `raw/fake_source/extraction-test-${RUN}`,
      sha256: RUN.padEnd(64, "0").toLowerCase(),
      byteSize: 2,
      headersJson: {},
      parserVersion: "test",
    })
    .returning({ id: rawArtifacts.id });

  const [project] = await db
    .insert(projects)
    .values({
      canonicalName: `EXTRACT-${RUN} Mixed Use Building`,
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
      externalId: `EXTRACT-${RUN}`,
      recordType: "permit",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      rawFieldsJson: {},
      normalizedJson: { title: `EXTRACT-${RUN} Mixed Use Building` },
      normalizedFingerprint: `extract-test-${RUN}`,
    })
    .returning({ id: sourceRecords.id });

  await db.execute(
    (await import("drizzle-orm")).sql`
      INSERT INTO record_resolutions
        (source_record_id, project_id, resolver_version, matched_rule,
         features_json, score, decision, status)
      VALUES (${record!.id}, ${projectId}, 'test', 'new_project', '{}', 1, 'auto', 'active')`,
  );

  const inserted = await db
    .insert(evidenceItems)
    .values([
      {
        sourceRecordId: record!.id,
        rawArtifactId: artifact!.id,
        factPath: "project.units",
        evidenceText: "Construct 78-unit mixed-use building with ground-floor retail.",
        pageOrSection: "description",
        sourceUrl: `https://example.invalid/extraction-test/${RUN}`,
        authorityGrade: "A",
        parserVersion: "test",
      },
      {
        sourceRecordId: record!.id,
        rawArtifactId: artifact!.id,
        factPath: "roles.applicant",
        evidenceText: "Applicant: Cascade Test Development LLC.",
        pageOrSection: "parties",
        sourceUrl: `https://example.invalid/extraction-test/${RUN}`,
        authorityGrade: "A",
        parserVersion: "test",
      },
    ])
    .returning({ id: evidenceItems.id, factPath: evidenceItems.factPath });
  evidenceUnitsId = inserted.find((r) => r.factPath === "project.units")!.id;
  evidenceGcId = inserted.find((r) => r.factPath === "roles.applicant")!.id;

  const [account] = await db.select({ id: accountProfiles.id }).from(accountProfiles).limit(1);
  accountId = account!.id;
  await db.insert(opportunities).values({
    accountProfileId: accountId,
    projectId,
    currentScore: 72,
    state: "weekly_digest",
  });
});

afterAll(async () => {
  await db.delete(opportunities).where(eq(opportunities.projectId, projectId));
  await deleteTestProjects(db, [projectId]);
  await pool.end();
});

describe("M3.3 extraction pipeline", () => {
  it("records a visible blocked run when no model key is configured", async () => {
    const result = await extractProject(db, null, projectId, { budget: BUDGET });
    expect(result.status).toBe("blocked");
    expect(result.modelRunId).toBeTruthy();
    const [row] = await db.select().from(modelRuns).where(eq(modelRuns.id, result.modelRunId!));
    expect(row!.status).toBe("blocked");
    expect(row!.provider).toBe("none");
    expect(row!.error).toContain("no model API key");
  });

  it("lists digest-band projects without a succeeded extraction as candidates", async () => {
    const candidates = await listExtractionCandidates(db, 10_000);
    expect(candidates).toContain(projectId);
  });

  it("validates, persists, and hashes a contract-conforming extraction", async () => {
    const text = JSON.stringify(validPayload());
    const provider = new MockProvider([
      { text, inputTokens: 1234, outputTokens: 321, costUsd: 0.0142 },
    ]);
    const result = await extractProject(db, provider, projectId, { budget: BUDGET });
    expect(result.status).toBe("succeeded");
    expect(result.extraction!.facts[0]!.value).toBe(78);

    // The prompt only ever offers stored evidence IDs.
    expect(provider.calls[0]!.prompt).toContain(evidenceUnitsId);
    expect(provider.calls[0]!.prompt).toContain(evidenceGcId);

    const [row] = await db.select().from(modelRuns).where(eq(modelRuns.id, result.modelRunId!));
    expect(row!.status).toBe("succeeded");
    expect(row!.provider).toBe("mock");
    expect(row!.model).toBe("mock-model");
    expect(row!.promptVersion).toBeTruthy();
    expect(row!.inputTokens).toBe(1234);
    expect(row!.outputTokens).toBe(321);
    expect(row!.costUsd).toBeCloseTo(0.0142, 6);
    expect(row!.latencyMs).toBeGreaterThanOrEqual(0);
    expect(row!.resultHash).toBe(createHash("sha256").update(text).digest("hex"));
    const stored = row!.resultJson as ModelExtraction;
    expect(stored.facts).toHaveLength(1);
    expect(stored.inferences[0]!.type).toBe("trade_fit");
  });

  it("drops the project from the candidate list once extracted", async () => {
    const candidates = await listExtractionCandidates(db, 10_000);
    expect(candidates).not.toContain(projectId);
  });

  it("rejects fabricated evidence IDs but still records the spend", async () => {
    const bad = validPayload();
    bad.facts[0]!.evidenceId = randomUUID();
    const provider = new MockProvider([{ text: JSON.stringify(bad), costUsd: 0.02 }]);
    const result = await extractProject(db, provider, projectId, { budget: BUDGET });
    expect(result.status).toBe("rejected");
    expect(result.reason).toContain("unknown_evidence_id");
    const [row] = await db.select().from(modelRuns).where(eq(modelRuns.id, result.modelRunId!));
    expect(row!.status).toBe("rejected");
    expect(row!.resultJson).toBeNull(); // rejected output is never consumable
    expect(row!.costUsd).toBeCloseTo(0.02, 6); // the spend still counts toward budget
  });

  it("rejects prose output as a contract violation", async () => {
    const provider = new MockProvider([{ text: "The permit shows 78 units." }]);
    const result = await extractProject(db, provider, projectId, { budget: BUDGET });
    expect(result.status).toBe("rejected");
    expect(result.reason).toContain("invalid_json");
  });

  it("blocks before spending when the monthly budget is exhausted", async () => {
    const provider = new MockProvider([{ text: JSON.stringify(validPayload()) }]);
    const result = await extractProject(db, provider, projectId, {
      budget: { monthlyCapUsd: 0, perJobCapUsd: 0.5 },
    });
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("monthly budget exhausted");
    expect(provider.calls).toHaveLength(0); // no model call happened
    const [row] = await db.select().from(modelRuns).where(eq(modelRuns.id, result.modelRunId!));
    expect(row!.status).toBe("blocked");
    expect(row!.costUsd).toBeNull();
  });

  it("blocks a job whose worst case exceeds the per-job cap", async () => {
    const provider = new MockProvider([{ text: JSON.stringify(validPayload()) }]);
    const result = await extractProject(db, provider, projectId, {
      budget: { monthlyCapUsd: 100, perJobCapUsd: 0.000001 },
    });
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("per-job cap");
    expect(provider.calls).toHaveLength(0);
  });

  it("blocks with no configured monthly budget (never 'unlimited')", async () => {
    const provider = new MockProvider([{ text: JSON.stringify(validPayload()) }]);
    const result = await extractProject(db, provider, projectId, {
      budget: { monthlyCapUsd: null, perJobCapUsd: 0.5 },
    });
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("LLM_MONTHLY_BUDGET_USD");
  });

  it("errors cleanly on a project with no evidence (nothing to interpret)", async () => {
    const [empty] = await db
      .insert(projects)
      .values({
        canonicalName: `EXTRACT-EMPTY-${RUN}`,
        permittingJurisdiction: "Test Jurisdiction",
        county: "Thurston",
        currentStage: "unknown",
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      })
      .returning({ id: projects.id });
    try {
      const provider = new MockProvider([{ text: JSON.stringify(validPayload()) }]);
      const result = await extractProject(db, provider, empty!.id, { budget: BUDGET });
      expect(result.status).toBe("error");
      expect(result.reason).toContain("no evidence");
      expect(provider.calls).toHaveLength(0);
    } finally {
      await deleteTestProjects(db, [empty!.id]);
    }
  });
});
