/**
 * M2.6 — permit-cluster velocity (spec §19 "subdivision with phases and
 * clustered building permits"): an N-permit cluster on one development is
 * one signal on the anchor project, not N leads.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import type pg from "pg";
import {
  projectEvents,
  rawArtifacts,
  sourceRecords,
  sourceRuns,
  type Db,
} from "@otn/db";
import type { NormalizedSourceRecord } from "@otn/domain";
import {
  buildDevelopments,
  computeCampusVelocity,
  computeClusterVelocity,
  resolveRecord,
  type ResolutionOutcome,
} from "@otn/resolution";
import { deleteTestProjects, resetSource, testDb } from "./helpers.js";

let db: Db;
let pool: pg.Pool;
let sourceId: string;
let artifactId: string;
const createdProjects = new Set<string>();
let devId: string | null = null;

const RUN = randomUUID().slice(0, 8).toUpperCase();
const DEV = `Velocity Meadows ${RUN}`;
const ORG = [{ name: `Velocity Meadows Homes ${RUN} LLC`, role: "applicant", evidenceText: "x" }];

async function resolveTracked(row: Parameters<typeof resolveRecord>[1]): Promise<ResolutionOutcome> {
  const outcome = await resolveRecord(db, row);
  if (outcome.projectId) createdProjects.add(outcome.projectId);
  return outcome;
}

function permit(n: number): NormalizedSourceRecord {
  return {
    sourceKey: "fake_source",
    externalId: `VM-${RUN}-${n}`,
    recordType: "building_permit",
    title: `VM-${RUN}-${n} – ${DEV} Lot ${n}`,
    description: null,
    permittingJurisdiction: "Test Jurisdiction",
    county: "Thurston",
    city: null,
    addressRaw: null,
    parcelIds: [],
    geometry: null,
    applicationType: null,
    permitType: "NEW CONSTRUCTION",
    documentType: null,
    statusRaw: "issued",
    normalizedStage: "permit_issued",
    applicationDate: null,
    issueDate: new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10),
    sourceUpdatedAt: null,
    valuationUsd: null,
    units: null,
    lots: null,
    squareFeet: null,
    organizations: ORG,
    sourceUrl: "https://example.invalid/x",
    evidence: [],
  };
}

async function insertAndResolve(normalized: NormalizedSourceRecord): Promise<ResolutionOutcome> {
  const firstSeenAt = new Date();
  const [row] = await db
    .insert(sourceRecords)
    .values({
      sourceId,
      rawArtifactId: artifactId,
      externalId: normalized.externalId,
      recordType: normalized.recordType,
      firstSeenAt,
      lastSeenAt: firstSeenAt,
      rawFieldsJson: {},
      normalizedJson: normalized,
      normalizedFingerprint: `vel-${normalized.externalId}-${RUN}`,
    })
    .returning({ id: sourceRecords.id });
  return resolveTracked({ id: row!.id, normalized, rawFields: {}, firstSeenAt });
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
      canonicalUrl: `https://example.invalid/velocity-test/${RUN}`,
      retrievedAt: new Date(),
      contentType: "application/json",
      httpStatus: 200,
      storageKey: `raw/fake_source/velocity-test-${RUN}`,
      sha256: `a${RUN}`.padEnd(64, "5").toLowerCase(),
      byteSize: 2,
      headersJson: {},
      parserVersion: "test",
    })
    .returning({ id: rawArtifacts.id });
  artifactId = artifact!.id;
});

afterAll(async () => {
  await deleteTestProjects(db, [...createdProjects]);
  if (devId) await db.execute(sql`DELETE FROM developments WHERE id = ${devId}`);
  await pool.end();
});

describe("M2.6 cluster velocity", () => {
  it("emits ONE velocity signal on the anchor for a 6-permit cluster", async () => {
    const outcomes = [];
    for (let n = 1; n <= 6; n++) outcomes.push(await insertAndResolve(permit(n)));
    expect(outcomes.every((o) => o.outcome === "created")).toBe(true);

    await buildDevelopments(db);
    const devRows = (
      await db.execute(sql`SELECT development_id FROM projects WHERE id = ${outcomes[0]!.projectId}`)
    ).rows as { development_id: string | null }[];
    const developmentId = devRows[0]?.development_id ?? null;
    expect(developmentId).not.toBeNull();
    devId = developmentId;

    const summary = await computeClusterVelocity(db, { minPermits: 5 });
    expect(summary.velocityEventsEmitted).toBeGreaterThanOrEqual(1);

    // Exactly one velocity event across the whole cluster — not 6.
    const events = await db.execute(sql`
      SELECT pe.project_id FROM project_events pe
      JOIN projects p ON p.id = pe.project_id
      WHERE p.development_id = ${devId} AND pe.event_type = 'cluster_velocity'`);
    expect(events.rows.length).toBe(1);
  });

  it("is idempotent until a new permit lands", async () => {
    const again = await computeClusterVelocity(db, { minPermits: 5 });
    expect(again.velocityEventsEmitted).toBe(0);

    // A NEWER permit re-signals (latest record moved). permit(n) dates n
    // days back, so use n=0 (today) — newer than the existing cluster.
    const o = await insertAndResolve(permit(0));
    expect(o.outcome).toBe("created");
    await buildDevelopments(db);
    const third = await computeClusterVelocity(db, { minPermits: 5 });
    expect(third.velocityEventsEmitted).toBe(1);
  });

  it("stays silent below the threshold", async () => {
    // A different run-scoped development with only 2 permits: covered by
    // grouping but no velocity. Use the minPermits default (5).
    const a = await insertAndResolve({
      ...permit(101),
      externalId: `Q-${RUN}-1`,
      title: `Q-${RUN}-1 – Quiet Corner ${RUN} Lot 1`,
      organizations: [{ name: `Quiet Corner ${RUN} LLC`, role: "applicant", evidenceText: "x" }],
    });
    const b = await insertAndResolve({
      ...permit(102),
      externalId: `Q-${RUN}-2`,
      title: `Q-${RUN}-2 – Quiet Corner ${RUN} Lot 2`,
      organizations: [{ name: `Quiet Corner ${RUN} LLC`, role: "applicant", evidenceText: "x" }],
    });
    await buildDevelopments(db);
    await computeClusterVelocity(db);
    const events = await db
      .select()
      .from(projectEvents)
      .where(and(eq(projectEvents.eventType, "cluster_velocity")));
    const ids = new Set([a.projectId, b.projectId]);
    expect(events.filter((e) => ids.has(e.projectId)).length).toBe(0);
  });
});

describe("M2.6 depth — campus velocity (#3)", () => {
  const CAMPUS_TAGS = ["Falcon", "Dragon", "Starship", "Raptor", "Merlin", "Grasshopper"];
  const campusIds = new Set<string>();

  // Distinct names + distinct orgs (so NOT development-grouped) sharing one
  // numeric parcel BLOCK prefix (6 digits) with distinct lot suffixes — the
  // campus case cluster_velocity misses. `block` is the 6-digit prefix.
  function campusPermit(block: string, n: number): NormalizedSourceRecord {
    const tag = CAMPUS_TAGS[n % CAMPUS_TAGS.length]!;
    return {
      ...permit(n),
      externalId: `CX-${block}-${RUN}-${n}`,
      title: `CX${n}-${RUN} ${tag}works ${RUN}${n}`,
      county: "Lewis",
      parcelIds: [`${block}${n}0`], // e.g. 99110010, 99110020 … → prefix 991100
      organizations: [{ name: `${tag} Ventures ${RUN}${n} LLC`, role: "applicant", evidenceText: "x" }],
    };
  }

  it("emits ONE campus signal for 5 distinct-name projects on one parcel block", async () => {
    for (let n = 1; n <= 5; n++) {
      const o = await insertAndResolve(campusPermit("991100", n));
      expect(o.outcome).toBe("created");
      campusIds.add(o.projectId!);
    }
    const summary = await computeCampusVelocity(db, { county: "Lewis", minProjects: 5, prefixLen: 6 });
    expect(summary.campusEventsEmitted).toBeGreaterThanOrEqual(1);

    // Exactly one campus_velocity across the block — on the anchor, not 5.
    const evs = await db
      .select()
      .from(projectEvents)
      .where(eq(projectEvents.eventType, "campus_velocity"));
    expect(evs.filter((e) => campusIds.has(e.projectId)).length).toBe(1);

    // Idempotent: a second run adds nothing new for the block.
    await computeCampusVelocity(db, { county: "Lewis", minProjects: 5, prefixLen: 6 });
    const evs2 = await db
      .select()
      .from(projectEvents)
      .where(eq(projectEvents.eventType, "campus_velocity"));
    expect(evs2.filter((e) => campusIds.has(e.projectId)).length).toBe(1);
  });

  it("stays silent for a block below the threshold (4 projects)", async () => {
    const below = new Set<string>();
    for (let n = 1; n <= 4; n++) {
      const o = await insertAndResolve(campusPermit("772200", n));
      below.add(o.projectId!);
      campusIds.add(o.projectId!);
    }
    await computeCampusVelocity(db, { county: "Lewis", minProjects: 5, prefixLen: 6 });
    const evs = await db
      .select()
      .from(projectEvents)
      .where(eq(projectEvents.eventType, "campus_velocity"));
    expect(evs.filter((e) => below.has(e.projectId)).length).toBe(0);
  });
  // Cleanup: campus projects are tracked in createdProjects via resolveTracked,
  // so the file-level afterAll deletes them (and their campus_velocity events).
});
