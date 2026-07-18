/**
 * The verified decision brief — a model-composed narrative over the
 * deterministic decision memo. Every path (blocked/error/rejected/succeeded)
 * writes an account-scoped `brief_draft` model_run; a draft that cites an
 * unknown ref or invents a number is rejected and never surfaced. Without a
 * model key the brief is blocked (visible state), never fabricated.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import {
  evidenceItems, opportunities, projectEvents, projects, rawArtifacts,
  sourceRecords, sourceRuns, type Db,
} from "@otn/db";
import {
  MockProvider, extractProject, verifyProject, generateBrief, latestBrief, buildDecisionMemo,
  buildBriefMenu,
} from "@otn/intelligence";
import { deleteTestProjects, resetSource, testDb } from "./helpers.js";

const RUN = randomUUID().slice(0, 8).toUpperCase();
const BUDGET = { monthlyCapUsd: 100, perJobCapUsd: 0.5 };

let db: Db;
let pool: pg.Pool;
let projectId: string;
let oppId: string;
let evId: string;

beforeAll(async () => {
  ({ db, pool } = await testDb());
  const sourceId = await resetSource(db, "fake_source");
  const [run] = await db.insert(sourceRuns).values({ sourceId, status: "succeeded" }).returning({ id: sourceRuns.id });
  const [art] = await db.insert(rawArtifacts).values({
    sourceId, sourceRunId: run!.id, canonicalUrl: `https://example.invalid/brief/${RUN}`,
    retrievedAt: new Date(), contentType: "application/json", httpStatus: 200,
    storageKey: `raw/fake_source/brief-${RUN}`, sha256: RUN.padEnd(64, "7").toLowerCase(), byteSize: 3,
    headersJson: {}, parserVersion: "test",
  }).returning({ id: rawArtifacts.id });

  const [project] = await db.insert(projects).values({
    canonicalName: `BRIEF-${RUN}`, permittingJurisdiction: "Test Jurisdiction", county: "Thurston",
    currentStage: "permit_issued", firstSeenAt: new Date(), lastSeenAt: new Date(),
  }).returning({ id: projects.id });
  projectId = project!.id;
  const [rec] = await db.insert(sourceRecords).values({
    sourceId, rawArtifactId: art!.id, externalId: `BRIEF-${RUN}`, recordType: "permit",
    firstSeenAt: new Date(), lastSeenAt: new Date(), rawFieldsJson: {},
    normalizedJson: { title: `BRIEF-${RUN}`, units: 20 }, normalizedFingerprint: `brief-${RUN}`,
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
    evidenceText: `BRIEF-${RUN}: 20 units.`, pageOrSection: "desc",
    sourceUrl: `https://example.invalid/brief/${RUN}`, authorityGrade: "A", parserVersion: "test",
  }).returning({ id: evidenceItems.id });
  evId = ev!.id;

  const acct = await db.execute(sql`SELECT id FROM account_profiles WHERE key = 'solis_interiors'`);
  const solisId = (acct.rows[0] as { id: string }).id;
  const [opp] = await db.insert(opportunities).values({
    accountProfileId: solisId, projectId, currentScore: 84, route: "interior_trades",
    state: "priority_review", firstQualifiedAt: new Date(),
    rationaleJson: {
      components: { trade_fit: 0.8, package_size_fit: 1, timing: 0.9, geography: 1, evidence_quality: 1 },
      signals: ["drywall_painting_keywords"], route: "interior_trades",
      capacity: { assessment: "likely_fit", explanation: "within serviceable range", provisional: true },
    },
  }).returning({ id: opportunities.id });
  oppId = opp!.id;

  await extractProject(db, new MockProvider([{ text: JSON.stringify({
    facts: [{ path: "project.units", value: 20, evidenceId: evId, confirmed: true, confidence: 0.97 }],
    inferences: [{ type: "trade_fit", value: "interior_plausible", evidenceIds: [evId], confidence: 0.7, reason: "TI scope" }],
    missingCriticalFacts: ["general_contractor"],
  }) }]), projectId, { budget: BUDGET });
  await verifyProject(db, new MockProvider([{ text: JSON.stringify({
    verdicts: [{ path: "project.units", evidenceId: evId, supported: true, reason: "stated" }],
  }) }]), projectId, { budget: BUDGET });
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM opportunities WHERE id = ${oppId}`);
  await deleteTestProjects(db, [projectId]);
  await pool.end();
});

/** A valid draft: cites only real menu refs, kinds match, numbers come from
 * the cited items (units=20 is the only number, from fact f0). */
function validDraft(): string {
  return JSON.stringify({
    segments: [
      { text: "A permit-issued project in the account's home territory.", kind: "context", refs: ["c_summary"] },
      { text: "20 units are in scope.", kind: "fact", refs: ["f0"] },
      { text: "Interior trades look like a fit on this scope.", kind: "inference", refs: ["i0"] },
      { text: "Confirm the general contractor before reaching out.", kind: "context", refs: ["c_action"] },
    ],
  });
}

describe("verified decision brief", () => {
  it("blocks (visible state) when no model key is configured — no brief, a recorded run", async () => {
    const res = await generateBrief(db, null, oppId, { budget: BUDGET });
    expect(res.status).toBe("blocked");
    expect(res.modelRunId).toBeTruthy();
    expect(res.brief).toBeUndefined();
    expect(await latestBrief(db, oppId, res.brief?.accountProfileId ?? (await accountId()), projectId)).toBeNull();
  });

  it("menu is built only from already-verified memo items (facts, inferences, context)", async () => {
    const memo = (await buildDecisionMemo(db, oppId))!;
    const menu = buildBriefMenu(memo);
    expect(menu.find((m) => m.refId === "f0")?.text).toContain("project.units = 20");
    expect(menu.find((m) => m.refId === "i0")?.kind).toBe("inference");
    expect(menu.some((m) => m.refId === "c_summary")).toBe(true);
    // No evidence/raw text leaks in beyond what the memo already surfaced.
    expect(menu.every((m) => m.kind === "fact" || m.kind === "inference" || m.kind === "context")).toBe(true);
  });

  it("accepts a compliant draft, persists it, and renders a hedged narrative", async () => {
    const res = await generateBrief(db, new MockProvider([{ text: validDraft() }]), oppId, { budget: BUDGET });
    expect(res.status).toBe("succeeded");
    expect(res.brief!.narrative).toMatch(/20 units are in scope/);
    // The inference segment is hedged in prose.
    expect(res.brief!.narrative.toLowerCase()).toContain("likely");
    expect(res.brief!.segments).toHaveLength(4);

    const acct = await accountId();
    const latest = await latestBrief(db, oppId, acct, projectId);
    expect(latest?.narrative).toBe(res.brief!.narrative);

    // Persisted as an account-scoped brief_draft model run.
    const row = await db.execute(sql`
      SELECT job_type, account_profile_id, status FROM model_runs
      WHERE project_id = ${projectId} AND job_type = 'brief_draft' AND status = 'succeeded'
      ORDER BY created_at DESC LIMIT 1`);
    expect((row.rows[0] as { account_profile_id: string }).account_profile_id).toBe(acct);
  });

  it("rejects a draft that invents a number — no fabricated prose is surfaced", async () => {
    const bad = JSON.stringify({
      segments: [{ text: "A 320-unit development.", kind: "fact", refs: ["f0"] }],
    });
    const res = await generateBrief(db, new MockProvider([{ text: bad }]), oppId, { budget: BUDGET });
    expect(res.status).toBe("rejected");
    expect(res.reason).toMatch(/unsubstantiated_number/);
    expect(res.brief).toBeUndefined();
  });

  it("rejects a draft citing an unknown ref (fabricated citation)", async () => {
    const bad = JSON.stringify({
      segments: [{ text: "20 units.", kind: "fact", refs: ["f99"] }],
    });
    const res = await generateBrief(db, new MockProvider([{ text: bad }]), oppId, { budget: BUDGET });
    expect(res.status).toBe("rejected");
    expect(res.reason).toMatch(/unknown_ref/);
  });
});

async function accountId(): Promise<string> {
  const acct = await db.execute(sql`SELECT id FROM account_profiles WHERE key = 'solis_interiors'`);
  return (acct.rows[0] as { id: string }).id;
}
