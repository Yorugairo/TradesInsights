/**
 * WS-F — the account's natural-language assistant over its OWN opportunities.
 * The model only maps the question to a whitelisted, Zod-validated filter and
 * narrates over rows the deterministic, account-scoped query already retrieved;
 * it never authors SQL. These DB-backed tests prove: NL→filter is whitelisted
 * (out-of-territory county/trade dropped), an injection-y keyword is bound as a
 * parameter and cannot break the query, narration is grounded (a fabricated row
 * id never appears in opportunityIds), one account never sees another's rows,
 * a no-match answer is honest, and a no-provider run still answers
 * deterministically with a visible blocked model_run.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import {
  evidenceItems, opportunities, projectEvents, projects, rawArtifacts,
  sourceRecords, sourceRuns, type Db,
} from "@otn/db";
import { MockProvider, assistantQuery } from "@otn/intelligence";
import { deleteTestProjects, resetSource, testDb } from "./helpers.js";

const RUN = randomUUID().slice(0, 8).toUpperCase();
const BUDGET = { monthlyCapUsd: 100, perJobCapUsd: 0.5 };
const NOW = new Date();
const ISSUE_DATE = new Date(NOW.getTime() - 35 * 86_400_000); // 5 wks ago → drywall window open
const RECENT = new Date(NOW.getTime() - 2 * 86_400_000); // moved within "this week"

let db: Db;
let pool: pg.Pool;
let solisId: string;
let laceyId: string;
let solisProjectId: string;
let laceyProjectId: string;
let solisOppId: string;
let laceyOppId: string;

async function accountId(key: string): Promise<string> {
  const acct = await db.execute(sql`SELECT id FROM account_profiles WHERE key = ${key}`);
  return (acct.rows[0] as { id: string }).id;
}

/** Seed one Thurston project + one opportunity for an account. Text carries the
 * given trade keyword so trade/keyword filters and the bid-window classifier
 * have something to bite on. */
async function seedOpportunity(input: {
  sourceId: string;
  tag: string;
  accountProfileId: string;
  county: string;
  text: string;
  route: string;
  score: number;
}): Promise<{ projectId: string; oppId: string }> {
  const [run] = await db.insert(sourceRuns).values({ sourceId: input.sourceId, status: "succeeded" }).returning({ id: sourceRuns.id });
  const [art] = await db.insert(rawArtifacts).values({
    sourceId: input.sourceId, sourceRunId: run!.id, canonicalUrl: `https://example.invalid/assist/${input.tag}`,
    retrievedAt: new Date(), contentType: "application/json", httpStatus: 200,
    storageKey: `raw/fake_source/assist-${input.tag}`, sha256: input.tag.padEnd(64, "3").toLowerCase(), byteSize: 3,
    headersJson: {}, parserVersion: "test",
  }).returning({ id: rawArtifacts.id });
  const [project] = await db.insert(projects).values({
    canonicalName: `ASSIST-${input.tag}`, permittingJurisdiction: "Test Jurisdiction", county: input.county,
    currentStage: "permit_issued", firstSeenAt: new Date(), lastSeenAt: new Date(),
  }).returning({ id: projects.id });
  const [rec] = await db.insert(sourceRecords).values({
    sourceId: input.sourceId, rawArtifactId: art!.id, externalId: `ASSIST-${input.tag}`, recordType: "permit",
    firstSeenAt: new Date(), lastSeenAt: new Date(), rawFieldsJson: {},
    normalizedJson: {
      title: `ASSIST-${input.tag}`, description: input.text,
      issueDate: ISSUE_DATE.toISOString().slice(0, 10), valuationUsd: 250000,
    },
    normalizedFingerprint: `assist-${input.tag}`,
  }).returning({ id: sourceRecords.id });
  await db.execute(sql`
    INSERT INTO record_resolutions (source_record_id, project_id, resolver_version, matched_rule, features_json, score, decision, status)
    VALUES (${rec!.id}, ${project!.id}, 'test', 'new_project', '{}', 1, 'auto', 'active')`);
  await db.insert(projectEvents).values({
    projectId: project!.id, sourceRecordId: rec!.id, eventType: "permit_issued",
    eventDate: ISSUE_DATE, observedAt: ISSUE_DATE, resultingStage: "permit_issued",
    materialChange: true, confirmed: true, confidence: 1,
  });
  await db.insert(evidenceItems).values({
    sourceRecordId: rec!.id, rawArtifactId: art!.id, factPath: "project.scope",
    evidenceText: input.text, pageOrSection: "desc",
    sourceUrl: `https://example.invalid/assist/${input.tag}`, authorityGrade: "A", parserVersion: "test",
  });
  const [opp] = await db.insert(opportunities).values({
    accountProfileId: input.accountProfileId, projectId: project!.id, currentScore: input.score,
    route: input.route, state: "priority_review", firstQualifiedAt: new Date(), lastMaterialChangeAt: RECENT,
    rationaleJson: { components: { trade_fit: 0.8 }, signals: ["drywall_painting_keywords"], route: input.route },
  }).returning({ id: opportunities.id });
  return { projectId: project!.id, oppId: opp!.id };
}

beforeAll(async () => {
  ({ db, pool } = await testDb());
  const sourceId = await resetSource(db, "fake_source");
  solisId = await accountId("solis_interiors");
  laceyId = await accountId("lacey_glass_commercial");

  const solis = await seedOpportunity({
    sourceId, tag: `${RUN}-A`, accountProfileId: solisId, county: "Thurston",
    text: "interior tenant improvement drywall and paint scope", route: "interior_trades", score: 84,
  });
  solisProjectId = solis.projectId;
  solisOppId = solis.oppId;

  const lacey = await seedOpportunity({
    sourceId, tag: `${RUN}-B`, accountProfileId: laceyId, county: "Thurston",
    text: "commercial storefront curtain wall glazing", route: "commercial_glazing", score: 90,
  });
  laceyProjectId = lacey.projectId;
  laceyOppId = lacey.oppId;
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM opportunities WHERE id IN (${solisOppId}, ${laceyOppId})`);
  await db.execute(sql`DELETE FROM model_runs WHERE job_type = 'assistant_query' AND account_profile_id IN (${solisId}, ${laceyId})`);
  await deleteTestProjects(db, [solisProjectId, laceyProjectId]);
  await pool.end();
});

/** A filter JSON the model might emit. */
function filterJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    counties: [], trades: [], timeframe: "all", bidWindowOpen: false, priorityOnly: false, keyword: null,
    ...over,
  });
}

describe("assistant — NL→filter is deterministic and whitelisted", () => {
  it("drops an out-of-territory county and an out-of-capability trade, then returns scoped rows", async () => {
    // Model proposes Spokane (not in Solis territory) and roofing (not a Solis trade).
    const provider = new MockProvider([
      { text: filterJson({ counties: ["Thurston", "Spokane"], trades: ["drywall", "roofing"], timeframe: "all" }) },
      { text: JSON.stringify({ answer: "1 opportunity in Thurston. [r0]", refs: ["r0"] }) },
    ]);
    const res = await assistantQuery(db, provider, solisId, "drywall work in Thurston or Spokane?", { budget: BUDGET, now: NOW });

    expect(res.filter.counties).toEqual(["Thurston"]); // Spokane dropped
    expect(res.filter.trades).toEqual(["drywall"]); // roofing dropped
    expect(res.opportunityIds).toContain(solisOppId);
    expect(res.status).toBe("succeeded");
  });

  it("binds an injection-y keyword as a parameter — the query cannot be broken and the table survives", async () => {
    const evil = "'; DROP TABLE opportunities; --";
    const provider = new MockProvider([
      { text: filterJson({ counties: ["Thurston"], keyword: evil }) },
      { text: JSON.stringify({ answer: "none.", refs: [] }) },
    ]);
    const res = await assistantQuery(db, provider, solisId, `find ${evil}`, { budget: BUDGET, now: NOW });

    // No throw; the keyword was preserved verbatim (bound, not stripped) and matched nothing.
    expect(res.filter.keyword).toContain("DROP TABLE");
    expect(res.opportunityIds).toEqual([]);

    // The opportunities table is intact — a benign follow-up still returns the seeded row.
    const benign = new MockProvider([
      { text: filterJson({ counties: ["Thurston"] }) },
      { text: JSON.stringify({ answer: "1 opportunity. [r0]", refs: ["r0"] }) },
    ]);
    const after = await assistantQuery(db, benign, solisId, "anything in Thurston?", { budget: BUDGET, now: NOW });
    expect(after.opportunityIds).toContain(solisOppId);
  });
});

describe("assistant — grounded narration", () => {
  it("returns a grounded answer that references only retrieved rows", async () => {
    const provider = new MockProvider([
      { text: filterJson({ counties: ["Thurston"] }) },
      { text: JSON.stringify({ answer: "1 opportunity matches in Thurston, score 84. [r0]", refs: ["r0"] }) },
    ]);
    const res = await assistantQuery(db, provider, solisId, "what's in Thurston?", { budget: BUDGET, now: NOW });
    expect(res.status).toBe("succeeded");
    expect(res.answer).toMatch(/Thurston/);
    expect(res.answer).not.toMatch(/\[r0\]/); // ref tokens stripped from prose
    expect(res.opportunityIds).toEqual([solisOppId]);
  });

  it("rejects a narration that cites a fabricated row id or invents a number — the fake never reaches opportunityIds", async () => {
    const provider = new MockProvider([
      { text: filterJson({ counties: ["Thurston"] }) },
      // r5 does not exist; 999999 is not in any menu row.
      { text: JSON.stringify({ answer: "2 projects in Spokane worth 999999. [r0] [r5]", refs: ["r0", "r5"] }) },
    ]);
    const res = await assistantQuery(db, provider, solisId, "what's in Thurston?", { budget: BUDGET, now: NOW });

    expect(res.status).toBe("rejected");
    // opportunityIds come from the deterministic query, never the model text.
    expect(res.opportunityIds).toEqual([solisOppId]);
    // The served answer is the deterministic template — no Spokane, no 999999.
    expect(res.answer).not.toMatch(/Spokane/);
    expect(res.answer).not.toMatch(/999999/);
  });
});

describe("assistant — account isolation", () => {
  it("never returns another account's opportunities", async () => {
    const provider = new MockProvider([
      { text: filterJson({ counties: ["Thurston"] }) },
      { text: JSON.stringify({ answer: "1 opportunity. [r0]", refs: ["r0"] }) },
    ]);
    const res = await assistantQuery(db, provider, solisId, "everything in Thurston", { budget: BUDGET, now: NOW });
    expect(res.opportunityIds).toContain(solisOppId);
    expect(res.opportunityIds).not.toContain(laceyOppId); // lacey's Thurston opp is invisible to Solis
  });
});

describe("assistant — honest empty + keyless fallback", () => {
  it("answers plainly that nothing matches rather than inventing a result", async () => {
    const provider = new MockProvider([
      { text: filterJson({ counties: ["King"], keyword: "aquarium-nonexistent-zzz" }) },
      { text: JSON.stringify({ answer: "none", refs: [] }) },
    ]);
    const res = await assistantQuery(db, provider, solisId, "aquariums in King?", { budget: BUDGET, now: NOW });
    expect(res.opportunityIds).toEqual([]);
    expect(res.answer).toMatch(/[Nn]othing/);
  });

  it("with no provider, still returns deterministically-filtered rows + a templated answer + a blocked model_run", async () => {
    const res = await assistantQuery(db, null, solisId, "what's winnable in Thurston this week?", { budget: BUDGET, now: NOW });

    expect(res.status).toBe("blocked");
    expect(res.filter.counties).toEqual(["Thurston"]);
    expect(res.filter.bidWindowOpen).toBe(true);
    expect(res.opportunityIds).toContain(solisOppId); // deterministic query still ran
    expect(res.answer.length).toBeGreaterThan(0);
    expect(res.modelRunId).toBeTruthy();

    const row = await db.execute(sql`
      SELECT status, account_profile_id, project_id FROM model_runs
      WHERE job_type = 'assistant_query' AND account_profile_id = ${solisId} AND status = 'blocked'
      ORDER BY created_at DESC LIMIT 1`);
    const persisted = row.rows[0] as { status: string; account_profile_id: string; project_id: string | null };
    expect(persisted.status).toBe("blocked");
    expect(persisted.account_profile_id).toBe(solisId);
    expect(persisted.project_id).toBeNull(); // account-scoped, not tied to one project
  });
});
