/**
 * WS-E — the grounded, pre-drafted GC outreach message. A brief-twin over the
 * deterministic decision memo: every path (blocked/error/rejected/succeeded)
 * writes an account-scoped `outreach_draft` model_run; a draft that cites an
 * unknown ref or invents a number is rejected and never surfaced. Without a
 * model key the draft is blocked (visible state), never fabricated. It only
 * DRAFTS + persists + returns — nothing is ever sent.
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
  MockProvider, extractProject, verifyProject, generateOutreach, latestOutreach,
  buildDecisionMemo, buildBriefMenu,
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
    sourceId, sourceRunId: run!.id, canonicalUrl: `https://example.invalid/outreach/${RUN}`,
    retrievedAt: new Date(), contentType: "application/json", httpStatus: 200,
    storageKey: `raw/fake_source/outreach-${RUN}`, sha256: RUN.padEnd(64, "5").toLowerCase(), byteSize: 3,
    headersJson: {}, parserVersion: "test",
  }).returning({ id: rawArtifacts.id });

  const [project] = await db.insert(projects).values({
    canonicalName: `OUTREACH-${RUN}`, permittingJurisdiction: "Test Jurisdiction", county: "Thurston",
    currentStage: "permit_issued", firstSeenAt: new Date(), lastSeenAt: new Date(),
  }).returning({ id: projects.id });
  projectId = project!.id;
  const [rec] = await db.insert(sourceRecords).values({
    sourceId, rawArtifactId: art!.id, externalId: `OUTREACH-${RUN}`, recordType: "permit",
    firstSeenAt: new Date(), lastSeenAt: new Date(), rawFieldsJson: {},
    normalizedJson: { title: `OUTREACH-${RUN}`, units: 20 }, normalizedFingerprint: `outreach-${RUN}`,
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
    evidenceText: `OUTREACH-${RUN}: 20 units.`, pageOrSection: "desc",
    sourceUrl: `https://example.invalid/outreach/${RUN}`, authorityGrade: "A", parserVersion: "test",
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

/** A valid draft: a short GC intro that cites only real menu refs. The project
 * reference rests on c_summary, the grounded 20-unit fact on f0 (the only
 * number, from the confirmed fact), the value prop on c_why, the soft ask on
 * c_action. No GC name is in the menu (no confirmed roles), so it addresses the
 * project team generically — never an invented name. */
function validDraft(): string {
  return JSON.stringify({
    segments: [
      { text: "I came across your permit-issued project in Thurston County and wanted to introduce our shop to the project team.", kind: "context", refs: ["c_summary"] },
      { text: "It's a 20-unit interior scope that fits our crews well.", kind: "fact", refs: ["f0"] },
      { text: "We're a local drywall and paint subcontractor on the interior-trades route.", kind: "context", refs: ["c_why"] },
      { text: "We'd welcome the chance to be considered for the interior scope.", kind: "context", refs: ["c_action"] },
    ],
  });
}

async function accountId(): Promise<string> {
  const acct = await db.execute(sql`SELECT id FROM account_profiles WHERE key = 'solis_interiors'`);
  return (acct.rows[0] as { id: string }).id;
}

describe("grounded GC outreach draft", () => {
  it("blocks (visible state) when no model key is configured — no draft, a recorded run", async () => {
    const res = await generateOutreach(db, null, oppId, { budget: BUDGET });
    expect(res.status).toBe("blocked");
    expect(res.modelRunId).toBeTruthy();
    expect(res.draft).toBeUndefined();
    expect(await latestOutreach(db, oppId, await accountId(), projectId)).toBeNull();

    // A blocked outreach_draft row is recorded (the ledger/audit trail), not thrown.
    const row = await db.execute(sql`
      SELECT status FROM model_runs
      WHERE project_id = ${projectId} AND job_type = 'outreach_draft' AND status = 'blocked'
      ORDER BY created_at DESC LIMIT 1`);
    expect((row.rows[0] as { status: string } | undefined)?.status).toBe("blocked");
  });

  it("accepts a compliant draft, persists it account-scoped, and cites only menu refs", async () => {
    const res = await generateOutreach(db, new MockProvider([{ text: validDraft() }]), oppId, { budget: BUDGET });
    expect(res.status).toBe("succeeded");
    expect(res.draft!.message).toMatch(/Thurston County/);
    expect(res.draft!.message).toMatch(/20-unit/);
    expect(res.draft!.segments).toHaveLength(4);

    // Grounding: every cited ref exists in the verified memo menu — nothing invented.
    const memo = (await buildDecisionMemo(db, oppId))!;
    const menuRefs = new Set(buildBriefMenu(memo).map((m) => m.refId));
    for (const seg of res.draft!.segments) {
      for (const ref of seg.refs) expect(menuRefs.has(ref)).toBe(true);
    }

    const acct = await accountId();
    const latest = await latestOutreach(db, oppId, acct, projectId);
    expect(latest?.message).toBe(res.draft!.message);

    // Persisted as an account-scoped outreach_draft model run.
    const row = await db.execute(sql`
      SELECT job_type, account_profile_id, status FROM model_runs
      WHERE project_id = ${projectId} AND job_type = 'outreach_draft' AND status = 'succeeded'
      ORDER BY created_at DESC LIMIT 1`);
    const persisted = row.rows[0] as { job_type: string; account_profile_id: string; status: string };
    expect(persisted.job_type).toBe("outreach_draft");
    expect(persisted.account_profile_id).toBe(acct);
  });

  it("rejects a draft that invents a number — no fabricated message is surfaced", async () => {
    const bad = JSON.stringify({
      segments: [{ text: "A 320-unit project we'd love to bid.", kind: "fact", refs: ["f0"] }],
    });
    const res = await generateOutreach(db, new MockProvider([{ text: bad }]), oppId, { budget: BUDGET });
    expect(res.status).toBe("rejected");
    expect(res.reason).toMatch(/unsubstantiated_number/);
    expect(res.draft).toBeUndefined();
  });

  it("rejects a draft citing an unknown ref (fabricated citation)", async () => {
    const bad = JSON.stringify({
      segments: [{ text: "Introducing our shop.", kind: "context", refs: ["c_bogus"] }],
    });
    const res = await generateOutreach(db, new MockProvider([{ text: bad }]), oppId, { budget: BUDGET });
    expect(res.status).toBe("rejected");
    expect(res.reason).toMatch(/unknown_ref/);
  });
});
