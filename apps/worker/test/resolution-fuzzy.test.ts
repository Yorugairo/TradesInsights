/**
 * M2.3 — fuzzy/geospatial passes 4–5 with spec §10 review gates. Covers the
 * §19 scenarios "same address with separate TIs" and "fuzzy without
 * parcel/organization support".
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type pg from "pg";
import {
  rawArtifacts,
  resolutionReviews,
  sourceRecords,
  sourceRuns,
  type Db,
} from "@otn/db";
import type { NormalizedSourceRecord } from "@otn/domain";
import { bareTitle, resolveRecord, type ResolutionOutcome } from "@otn/resolution";
import { deleteTestProjects, resetSource, testDb } from "./helpers.js";

let db: Db;
let pool: pg.Pool;
let sourceId: string;
let artifactId: string;
const createdProjects = new Set<string>();

async function resolveTracked(row: Parameters<typeof resolveRecord>[1]): Promise<ResolutionOutcome> {
  const outcome = await resolveRecord(db, row);
  if (outcome.projectId) createdProjects.add(outcome.projectId);
  return outcome;
}

const RUN = randomUUID().slice(0, 8).toUpperCase();
// Distinct synthetic location per run (offshore of Thurston, no real projects).
const LNG = -124.5 - (parseInt(RUN.replace(/\D/g, "1").slice(0, 4), 10) % 100) / 10000;
const LAT = 46.2;

function record(overrides: Partial<NormalizedSourceRecord>): NormalizedSourceRecord {
  return {
    sourceKey: "fake_source",
    externalId: "X",
    recordType: "building_permit",
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

async function insertRecord(
  normalized: NormalizedSourceRecord,
  rawFields: Record<string, unknown>,
): Promise<{ id: string; normalized: NormalizedSourceRecord; rawFields: Record<string, unknown>; firstSeenAt: Date }> {
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
      rawFieldsJson: rawFields,
      normalizedJson: normalized,
      normalizedFingerprint: `fuzzy-${normalized.externalId}-${RUN}`,
    })
    .returning({ id: sourceRecords.id });
  return { id: row!.id, normalized, rawFields, firstSeenAt };
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
      canonicalUrl: `https://example.invalid/fuzzy-test/${RUN}`,
      retrievedAt: new Date(),
      contentType: "application/json",
      httpStatus: 200,
      storageKey: `raw/fake_source/fuzzy-test-${RUN}`,
      sha256: `f${RUN}`.padEnd(64, "1").toLowerCase(),
      byteSize: 2,
      headersJson: {},
      parserVersion: "test",
    })
    .returning({ id: rawArtifacts.id });
  artifactId = artifact!.id;
});

afterAll(async () => {
  await deleteTestProjects(db, [...createdProjects]);
  await pool.end();
});

describe("M2.3 pass 4: address + compatible name", () => {
  const address = `${RUN.slice(0, 4)} FUZZY TEST AVE SE, OLYMPIA, WA 98501`;
  let anchorProjectId: string;

  it("seeds an anchor project with a normalized address", async () => {
    const row = await insertRecord(
      record({
        externalId: `ANCH-${RUN}-1`,
        title: `ANCH-${RUN}-1 – Fuzzy Grove Apartments`,
        addressRaw: address,
        normalizedStage: "entitlement",
      }),
      {},
    );
    const outcome = await resolveTracked(row);
    expect(outcome.outcome).toBe("created");
    anchorProjectId = outcome.projectId!;
  });

  it("auto-merges a same-address record with a compatible name", async () => {
    const row = await insertRecord(
      record({
        externalId: `ADDR-${RUN}-2`,
        title: `ADDR-${RUN}-2 – Fuzzy Grove Apartments Phase Notice`,
        addressRaw: address,
      }),
      {},
    );
    const outcome = await resolveTracked(row);
    expect(outcome.outcome).toBe("merged");
    expect(outcome.rule).toBe("address_name");
    expect(outcome.projectId).toBe(anchorProjectId);
  });

  it("routes a same-address generic-name record (separate TI risk) to review", async () => {
    const row = await insertRecord(
      record({
        externalId: `TI-${RUN}-3`,
        title: `TI-${RUN}-3 – Tenant Improvement`,
        addressRaw: address,
      }),
      {},
    );
    const outcome = await resolveTracked(row);
    expect(outcome.outcome).toBe("review");
    const [review] = await db
      .select()
      .from(resolutionReviews)
      .where(eq(resolutionReviews.sourceRecordId, row.id));
    expect(review!.reasonsJson).toContain("generic_name");
    expect(review!.candidateProjectId).toBe(anchorProjectId);
  });
});

describe("M2.3 pass 5: proximity + organization support", () => {
  let anchorProjectId: string;

  it("seeds an anchor project with geometry and an organization", async () => {
    const row = await insertRecord(
      record({
        externalId: `GEO-${RUN}-1`,
        title: `GEO-${RUN}-1 – Harbor Point Mixed Use`,
        geometry: { type: "Point", coordinates: [LNG, LAT] },
        organizations: [{ name: "Harbor Point Partners LLC", role: "applicant", evidenceText: "x" }],
        normalizedStage: "entitlement",
      }),
      {},
    );
    const outcome = await resolveTracked(row);
    expect(outcome.outcome).toBe("created");
    anchorProjectId = outcome.projectId!;
  });

  it("auto-merges a nearby record sharing an organization", async () => {
    const row = await insertRecord(
      record({
        externalId: `GEO-${RUN}-2`,
        title: `GEO-${RUN}-2 – Harbor Point site development`,
        geometry: { type: "Point", coordinates: [LNG + 0.0003, LAT] }, // ~25 m east
        organizations: [{ name: "Harbor Point Partners, LLC", role: "applicant", evidenceText: "x" }],
      }),
      {},
    );
    const outcome = await resolveTracked(row);
    expect(outcome.outcome).toBe("merged");
    expect(outcome.rule).toBe("proximity_org");
    expect(outcome.projectId).toBe(anchorProjectId);
  });

  it("routes a nearby name-similar record without org/parcel support to review", async () => {
    const row = await insertRecord(
      record({
        externalId: `GEO-${RUN}-3`,
        title: `GEO-${RUN}-3 – Harbor Point Mixed Use utility work`,
        geometry: { type: "Point", coordinates: [LNG, LAT + 0.0003] }, // ~33 m north
      }),
      {},
    );
    const outcome = await resolveTracked(row);
    expect(outcome.outcome).toBe("review");
    const [review] = await db
      .select()
      .from(resolutionReviews)
      .where(eq(resolutionReviews.sourceRecordId, row.id));
    expect(review!.reasonsJson).toContain("fuzzy_without_parcel_or_org_support");
  });

  it("creates a new project for a distant unrelated record", async () => {
    const row = await insertRecord(
      record({
        externalId: `FAR-${RUN}-4`,
        title: `FAR-${RUN}-4 – Completely Different Warehouse`,
        geometry: { type: "Point", coordinates: [LNG + 0.05, LAT + 0.05] }, // ~6 km away
      }),
      {},
    );
    const outcome = await resolveTracked(row);
    expect(outcome.outcome).toBe("created");
    expect(outcome.projectId).not.toBe(anchorProjectId);
  });
});

describe("bareTitle", () => {
  it("strips id prefixes for name comparison", () => {
    expect(bareTitle("SUP25-0002 – Roamers RV Park Project")).toBe("Roamers RV Park Project");
    expect(bareTitle("No prefix title")).toBe("No prefix title");
  });
});
