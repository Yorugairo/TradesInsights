/**
 * M2.4 — development/phase hierarchy (spec §10 pass 6, §19 "subdivision with
 * phases and clustered building permits").
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray, sql } from "drizzle-orm";
import type pg from "pg";
import {
  projects,
  rawArtifacts,
  sourceRecords,
  sourceRuns,
  type Db,
} from "@otn/db";
import type { NormalizedSourceRecord } from "@otn/domain";
import {
  buildDevelopments,
  developmentName,
  resolveRecord,
  type ResolutionOutcome,
} from "@otn/resolution";
import { deleteTestProjects, resetSource, testDb } from "./helpers.js";

let db: Db;
let pool: pg.Pool;
let sourceId: string;
let artifactId: string;
const createdProjects = new Set<string>();
let createdDevelopmentId: string | null = null;

const RUN = randomUUID().slice(0, 8).toUpperCase();
const DEV_NAME = `Copper Falls ${RUN}`;

async function resolveTracked(row: Parameters<typeof resolveRecord>[1]): Promise<ResolutionOutcome> {
  const outcome = await resolveRecord(db, row);
  if (outcome.projectId) createdProjects.add(outcome.projectId);
  return outcome;
}

function record(overrides: Partial<NormalizedSourceRecord>): NormalizedSourceRecord {
  return {
    sourceKey: "fake_source",
    externalId: "X",
    recordType: "planning_application",
    title: "X",
    description: null,
    permittingJurisdiction: "Test Jurisdiction",
    county: "Thurston",
    city: null,
    addressRaw: null,
    parcelIds: [],
    geometry: null,
    applicationType: null,
    permitType: null,
    documentType: null,
    statusRaw: null,
    normalizedStage: "unknown",
    applicationDate: null,
    issueDate: null,
    sourceUpdatedAt: null,
    valuationUsd: null,
    units: null,
    lots: null,
    squareFeet: null,
    organizations: [],
    sourceUrl: "https://example.invalid/x",
    evidence: [],
    ...overrides,
  };
}

async function insertAndResolve(
  normalized: NormalizedSourceRecord,
): Promise<ResolutionOutcome> {
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
      normalizedFingerprint: `dev-${normalized.externalId}-${RUN}`,
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
      canonicalUrl: `https://example.invalid/dev-test/${RUN}`,
      retrievedAt: new Date(),
      contentType: "application/json",
      httpStatus: 200,
      storageKey: `raw/fake_source/dev-test-${RUN}`,
      sha256: `d${RUN}`.padEnd(64, "2").toLowerCase(),
      byteSize: 2,
      headersJson: {},
      parserVersion: "test",
    })
    .returning({ id: rawArtifacts.id });
  artifactId = artifact!.id;
});

afterAll(async () => {
  await deleteTestProjects(db, [...createdProjects]);
  if (createdDevelopmentId) {
    await db.execute(sql`DELETE FROM developments WHERE id = ${createdDevelopmentId}`);
  }
  await pool.end();
});

describe("developmentName", () => {
  it("extracts base + phase label and detects plats", () => {
    expect(developmentName("LP25-00001 – Plat of Columbia Creek Heights")).toEqual({
      base: "COLUMBIA CREEK HEIGHTS",
      phaseLabel: null,
      isPlat: true,
    });
    expect(developmentName("B26-1 – Copper Falls Phase 2")).toEqual({
      base: "COPPER FALLS",
      phaseLabel: "PHASE 2",
      isPlat: false,
    });
    expect(developmentName("X – Maple Hills Div 5")).toEqual({
      base: "MAPLE HILLS",
      phaseLabel: "DIV 5",
      isPlat: false,
    });
    // Generic or too-short bases never group.
    expect(developmentName("B1 – REROOF")).toBeNull();
    expect(developmentName("B1 – Warehouse")).toBeNull();
  });
});

describe("M2.4 development grouping", () => {
  it("groups plat + phased projects sharing an organization into one development", async () => {
    const org = [{ name: `Copper Falls Dev ${RUN} LLC`, role: "applicant", evidenceText: "x" }];
    const plat = await insertAndResolve(
      record({
        externalId: `PLAT-${RUN}`,
        title: `PLAT-${RUN} – Plat of ${DEV_NAME}`,
        normalizedStage: "entitlement",
        organizations: org,
        parcelIds: [`88${RUN.replace(/\D/g, "3").padEnd(9, "3")}`.slice(0, 11)],
      }),
    );
    const ph1 = await insertAndResolve(
      record({
        externalId: `PH1-${RUN}`,
        title: `PH1-${RUN} – ${DEV_NAME} Phase 1`,
        recordType: "building_permit",
        normalizedStage: "permit_issued",
        organizations: org,
      }),
    );
    const ph2 = await insertAndResolve(
      record({
        externalId: `PH2-${RUN}`,
        title: `PH2-${RUN} – ${DEV_NAME} Phase 2`,
        recordType: "building_permit",
        normalizedStage: "permit_applied",
        organizations: org,
      }),
    );
    expect(plat.outcome).toBe("created");
    expect(ph1.outcome).toBe("created");
    expect(ph2.outcome).toBe("created");

    const summary = await buildDevelopments(db);
    expect(summary.developmentsFormed).toBeGreaterThanOrEqual(1);

    const rows = await db
      .select({
        id: projects.id,
        developmentId: projects.developmentId,
        parentProjectId: projects.parentProjectId,
      })
      .from(projects)
      .where(inArray(projects.id, [plat.projectId!, ph1.projectId!, ph2.projectId!]));

    const devIds = new Set(rows.map((r) => r.developmentId));
    expect(devIds.size).toBe(1);
    expect([...devIds][0]).not.toBeNull();
    createdDevelopmentId = [...devIds][0]!;

    // The plat record parents the phases.
    const platRow = rows.find((r) => r.id === plat.projectId)!;
    const phase1 = rows.find((r) => r.id === ph1.projectId)!;
    const phase2 = rows.find((r) => r.id === ph2.projectId)!;
    expect(platRow.parentProjectId).toBeNull();
    expect(phase1.parentProjectId).toBe(plat.projectId);
    expect(phase2.parentProjectId).toBe(plat.projectId);
  });

  it("does not group same-name projects without org/parcel/proximity support", async () => {
    const a = await insertAndResolve(
      record({
        externalId: `NS1-${RUN}`,
        title: `NS1-${RUN} – Silverline Commons ${RUN} Phase 1`,
        recordType: "building_permit",
      }),
    );
    const b = await insertAndResolve(
      record({
        externalId: `NS2-${RUN}`,
        title: `NS2-${RUN} – Silverline Commons ${RUN} Phase 2`,
        recordType: "building_permit",
      }),
    );
    await buildDevelopments(db);
    const rows = await db
      .select({ developmentId: projects.developmentId })
      .from(projects)
      .where(inArray(projects.id, [a.projectId!, b.projectId!]));
    expect(rows.every((r) => r.developmentId === null)).toBe(true);
  });
});
