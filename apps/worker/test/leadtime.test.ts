/**
 * #2 — lead-time backtest: evidence lead time (how many days before the
 * permit-issued milestone the graph first knew about a project) and per-source
 * detection lag (first_seen_at vs stated event_date), both reproduced from
 * stored events. Nulls for empty sets — never fabricated zeros.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import {
  accountProfiles,
  opportunities,
  projectEvents,
  projects,
  rawArtifacts,
  sourceRecords,
  sourceRuns,
  type Db,
} from "@otn/db";
import { detectionLagBySource, evidenceLeadTime, firstLookByCoverage } from "@otn/delivery";
import { deleteTestProjects, resetSource, testDb } from "./helpers.js";

const RUN = randomUUID().slice(0, 8).toUpperCase();
const DAY = 86_400_000;
const NOW = new Date();
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

let db: Db;
let pool: pg.Pool;
let sourceId: string;
let accountId: string;
const projectIds: string[] = [];

async function seedProject(
  name: string,
  artifactId: string,
  events: { date: Date; stage: string | null; firstSeen?: Date }[],
): Promise<string> {
  const [project] = await db
    .insert(projects)
    .values({
      canonicalName: name,
      permittingJurisdiction: "Test Jurisdiction",
      county: "Thurston",
      currentStage: "permit_issued",
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    })
    .returning({ id: projects.id });
  projectIds.push(project!.id);
  for (const [i, e] of events.entries()) {
    const [record] = await db
      .insert(sourceRecords)
      .values({
        sourceId,
        rawArtifactId: artifactId,
        externalId: `${name}-${i}`,
        recordType: "permit",
        firstSeenAt: e.firstSeen ?? NOW,
        lastSeenAt: e.firstSeen ?? NOW,
        rawFieldsJson: {},
        normalizedJson: { title: name },
        normalizedFingerprint: `lead-${name}-${i}`,
      })
      .returning({ id: sourceRecords.id });
    await db.insert(projectEvents).values({
      projectId: project!.id,
      sourceRecordId: record!.id,
      eventType: e.stage === "permit_issued" ? "permit_issued" : "application_submitted",
      eventDate: e.date,
      observedAt: e.firstSeen ?? NOW,
      resultingStage: e.stage,
      materialChange: true,
      confirmed: true,
      confidence: 1,
    });
  }
  await db.insert(opportunities).values({
    accountProfileId: accountId,
    projectId: project!.id,
    currentScore: 70,
    state: "weekly_digest",
  });
  return project!.id;
}

beforeAll(async () => {
  ({ db, pool } = await testDb());
  sourceId = await resetSource(db, "fake_source");
  const [run] = await db
    .insert(sourceRuns)
    .values({ sourceId, status: "succeeded" })
    .returning({ id: sourceRuns.id });
  const [artifact] = await db
    .insert(rawArtifacts)
    .values({
      sourceId,
      sourceRunId: run!.id,
      canonicalUrl: `https://example.invalid/leadtime-test/${RUN}`,
      retrievedAt: NOW,
      contentType: "application/json",
      httpStatus: 200,
      storageKey: `raw/fake_source/leadtime-test-${RUN}`,
      sha256: RUN.padEnd(64, "7").toLowerCase(),
      byteSize: 2,
      headersJson: {},
      parserVersion: "test",
    })
    .returning({ id: rawArtifacts.id });

  const [account] = await db
    .insert(accountProfiles)
    .values({
      key: `test_lead_${RUN.toLowerCase()}`,
      name: `Lead Test ${RUN}`,
      active: true,
      capabilitiesJson: [],
      territoryJson: { counties_included: ["Thurston"] },
      deliveryConfigJson: {},
    })
    .returning({ id: accountProfiles.id });
  accountId = account!.id;

  // P1: SEPA/application 120 days before the permit → 100 days of notice.
  await seedProject(`LEAD-A-${RUN}`, artifact!.id, [
    { date: daysAgo(120), stage: "entitlement" },
    { date: daysAgo(20), stage: "permit_issued" },
  ]);
  // P2: the permit itself was the first sighting → 0 days, no early warning.
  await seedProject(`LEAD-B-${RUN}`, artifact!.id, [
    { date: daysAgo(10), stage: "permit_issued" },
  ]);
  // P3: never reached permit_issued → excluded from the backtest, not guessed.
  await seedProject(`LEAD-C-${RUN}`, artifact!.id, [
    { date: daysAgo(30), stage: "entitlement" },
  ]);
  // Detection-lag fixture: event dated 5 days before its record was first seen.
  await seedProject(`LEAD-D-${RUN}`, artifact!.id, [
    { date: daysAgo(5), stage: "permit_issued", firstSeen: NOW },
  ]);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM opportunities WHERE account_profile_id = ${accountId}`);
  await deleteTestProjects(db, projectIds);
  await db.execute(sql`DELETE FROM account_profiles WHERE id = ${accountId}`);
  await pool.end();
});

describe("#2 evidence lead time", () => {
  it("measures advance notice only for projects with a dated permit-issued milestone", async () => {
    const lead = await evidenceLeadTime(db, accountId);
    // A (100d), B (0d), D (0d) are measured; C has no milestone → excluded.
    expect(lead.measured).toBe(3);
    expect(lead.p75Days).toBeGreaterThanOrEqual(49); // interpolated toward A's 100d
    expect(lead.noEarlyWarning).toBe(2); // B and D: first sighting WAS the permit
    expect(lead.shareGte30d).toBeCloseTo(1 / 3, 2); // only A gave ≥30d notice
    expect(lead.shareGte90d).toBeCloseTo(1 / 3, 2);
  });

  it("returns nulls (never zeros) for an account with nothing measured", async () => {
    const [empty] = await db
      .insert(accountProfiles)
      .values({
        key: `test_lead_empty_${RUN.toLowerCase()}`,
        name: `Lead Empty ${RUN}`,
        active: true,
        capabilitiesJson: [],
        territoryJson: {},
        deliveryConfigJson: {},
      })
      .returning({ id: accountProfiles.id });
    try {
      const lead = await evidenceLeadTime(db, empty!.id);
      expect(lead.measured).toBe(0);
      expect(lead.medianDays).toBeNull();
      expect(lead.shareGte30d).toBeNull();
    } finally {
      await db.execute(sql`DELETE FROM account_profiles WHERE id = ${empty!.id}`);
    }
  });
});

describe("#2 detection lag by source", () => {
  it("reports all-time and recent medians per source", async () => {
    const rows = await detectionLagBySource(db, { includeTestSources: true });
    const fake = rows.find((r) => r.sourceKey === "fake_source")!;
    expect(fake).toBeTruthy();
    expect(fake.events).toBeGreaterThanOrEqual(1);
    // All fixture records were first seen NOW with event dates 120/30/20/10/5
    // days back → the recent median over those lags is exactly 20.
    expect(fake.medianDaysRecent).toBe(20);
    expect(fake.medianDaysAllTime).toBe(20);
  });

  it("excludes test-priority sources by default", async () => {
    const rows = await detectionLagBySource(db);
    expect(rows.find((r) => r.sourceKey === "fake_source")).toBeUndefined();
  });
});

describe("first-look advantage by coverage", () => {
  it("credits the earliest-sighting source with days-before-permit, per county", async () => {
    const rows = await firstLookByCoverage(db, { includeTestSources: true, minSamples: 1 });
    const g = rows.find((r) => r.sourceKey === "fake_source" && r.county === "Thurston")!;
    expect(g).toBeTruthy();
    // A (100d lead), B (0), D (0) reached permit_issued; C never did → excluded.
    expect(g.projects).toBe(3);
    expect(g.medianLeadDays).toBe(0); // median of [100, 0, 0] — permit-first dominates
    expect(g.p75Days).toBeGreaterThanOrEqual(49); // interpolates toward A's 100d
    expect(g.shareEarly).toBeCloseTo(1 / 3, 2); // only A's first sighting predated its permit
    expect(g.medianLeadDaysWhenEarly).toBe(100); // when early (A only), 100 days ahead
  });

  it("drops groups below the sample floor rather than publishing a thin number", async () => {
    const rows = await firstLookByCoverage(db, { includeTestSources: true }); // default floor 20
    expect(rows.find((r) => r.sourceKey === "fake_source")).toBeUndefined();
  });

  it("excludes test-priority sources by default", async () => {
    const rows = await firstLookByCoverage(db, { minSamples: 1 });
    expect(rows.find((r) => r.sourceKey === "fake_source")).toBeUndefined();
  });
});
