/**
 * Stage-change follow-through (applyRecordUpdates): a record whose source
 * content changes AFTER first resolution (the runner updates normalized_json
 * + fingerprint in place — e.g. a permit application later issued) must
 * advance its project's stage and emit the stage-change event. Before this
 * pass those transitions were silently dropped: resolveUnresolved skips
 * actively-resolved records.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type pg from "pg";
import {
  projectEvents,
  rawArtifacts,
  sourceRecords,
  sourceRuns,
  type Db,
} from "@otn/db";
import type { NormalizedSourceRecord } from "@otn/domain";
import { applyRecordUpdates, resolveRecord } from "@otn/resolution";
import { deleteTestProjects, resetSource, testDb } from "./helpers.js";

const RUN = randomUUID().slice(0, 8).toUpperCase();

let db: Db;
let pool: pg.Pool;
let sourceId: string;
let artifactId: string;
let recordId: string;
let projectId: string;

function permitRecord(overrides: Partial<NormalizedSourceRecord>): NormalizedSourceRecord {
  return {
    sourceKey: "fake_source",
    externalId: `UPD-${RUN}`,
    recordType: "building_permit",
    title: `UPD-${RUN} – Update Follow-Through Test Bldg`,
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
    statusRaw: "applied",
    normalizedStage: "permit_applied",
    applicationDate: "2026-05-01",
    issueDate: null,
    sourceUpdatedAt: null,
    valuationUsd: null,
    units: null,
    lots: null,
    squareFeet: null,
    organizations: [],
    sourceUrl: "https://example.invalid/upd",
    evidence: [],
    ...overrides,
  };
}

/** Simulate the runner's in-place update of a republished record. */
async function republish(record: NormalizedSourceRecord, version: string): Promise<void> {
  await db
    .update(sourceRecords)
    .set({
      normalizedJson: record,
      normalizedFingerprint: `upd-${RUN}-${version}`,
      lastSeenAt: new Date(),
    })
    .where(eq(sourceRecords.id, recordId));
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
      canonicalUrl: `https://example.invalid/update-test/${RUN}`,
      retrievedAt: new Date(),
      contentType: "application/json",
      httpStatus: 200,
      storageKey: `raw/fake_source/update-test-${RUN}`,
      sha256: RUN.padEnd(64, "3").toLowerCase(),
      byteSize: 2,
      headersJson: {},
      parserVersion: "test",
    })
    .returning({ id: rawArtifacts.id });
  artifactId = artifact!.id;

  const initial = permitRecord({});
  const [row] = await db
    .insert(sourceRecords)
    .values({
      sourceId,
      rawArtifactId: artifactId,
      externalId: initial.externalId,
      recordType: initial.recordType,
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      rawFieldsJson: {},
      normalizedJson: initial,
      normalizedFingerprint: `upd-${RUN}-v1`,
    })
    .returning({ id: sourceRecords.id });
  recordId = row!.id;
  const outcome = await resolveRecord(db, {
    id: recordId,
    normalized: initial,
    rawFields: {},
    firstSeenAt: new Date(),
  });
  expect(outcome.outcome).toBe("created");
  projectId = outcome.projectId!;
});

afterAll(async () => {
  await deleteTestProjects(db, [projectId]);
  await pool.end();
});

async function currentStage(): Promise<string> {
  const res = await db.execute(sql`SELECT current_stage FROM projects WHERE id = ${projectId}`);
  return (res.rows[0] as { current_stage: string }).current_stage;
}

describe("applyRecordUpdates — stage-change follow-through", () => {
  it("advances the project and emits a material stage-change event on issuance", async () => {
    expect(await currentStage()).toBe("permit_applied");

    await republish(
      permitRecord({ statusRaw: "issued", normalizedStage: "permit_issued", issueDate: "2026-07-10" }),
      "v2",
    );
    const summary = await applyRecordUpdates(db, {
      includeTestSources: true,
      sourceRecordIds: [recordId],
    });
    expect(summary).toMatchObject({ checked: 1, stageAdvanced: 1, errors: 0 });
    expect(await currentStage()).toBe("permit_issued");

    const events = await db
      .select()
      .from(projectEvents)
      .where(eq(projectEvents.projectId, projectId));
    const change = events.find((e) => e.materialChange);
    expect(change).toBeTruthy();
    expect(change!.priorStage).toBe("permit_applied");
    expect(change!.resultingStage).toBe("permit_issued");
    expect(change!.eventType).toBe("permit_issued");
    // The event carries the SOURCE-stated issue date, not our fetch time.
    expect(change!.eventDate?.toISOString().slice(0, 10)).toBe("2026-07-10");
  });

  it("is idempotent: the processed content version is never re-applied", async () => {
    const again = await applyRecordUpdates(db, {
      includeTestSources: true,
      sourceRecordIds: [recordId],
    });
    expect(again.checked).toBe(0);
  });

  it("a non-stage content change refreshes without a material event", async () => {
    await republish(
      permitRecord({
        statusRaw: "issued",
        normalizedStage: "permit_issued",
        issueDate: "2026-07-10",
        description: "roof material amendment",
        organizations: [{ name: `Update GC ${RUN} LLC`, role: "primary_contractor", evidenceText: "x" }],
      }),
      "v3",
    );
    const summary = await applyRecordUpdates(db, {
      includeTestSources: true,
      sourceRecordIds: [recordId],
    });
    expect(summary).toMatchObject({ checked: 1, stageAdvanced: 0, errors: 0 });
    // The update's new organization role landed on the project.
    const roles = await db.execute(sql`
      SELECT o.canonical_name FROM project_roles pr
      JOIN organizations o ON o.id = pr.organization_id
      WHERE pr.project_id = ${projectId} AND pr.role = 'primary_contractor'`);
    expect(roles.rows.length).toBe(1);
    const events = await db
      .select()
      .from(projectEvents)
      .where(eq(projectEvents.projectId, projectId));
    expect(events.filter((e) => e.materialChange).length).toBe(1); // still just the issuance
  });

  it("never regresses a stage from a single record update (spec §9)", async () => {
    await republish(
      permitRecord({ statusRaw: "under review", normalizedStage: "entitlement" }),
      "v4",
    );
    const summary = await applyRecordUpdates(db, {
      includeTestSources: true,
      sourceRecordIds: [recordId],
    });
    expect(summary).toMatchObject({ checked: 1, stageAdvanced: 0 });
    expect(await currentStage()).toBe("permit_issued");
  });
});
