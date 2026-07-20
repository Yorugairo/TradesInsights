/**
 * M2.2 — resolver passes 1–3 (spec §10, §19 "same project across SEPA, local
 * notice, and permit"). Runs against the real Postgres from docker compose.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import type pg from "pg";
import {
  organizations,
  projectEvents,
  projectExternalIds,
  projects,
  rawArtifacts,
  recordResolutions,
  resolutionReviews,
  sourceRecords,
  sourceRuns,
  type Db,
} from "@otn/db";
import type { NormalizedSourceRecord } from "@otn/domain";
import {
  findBoundOrganizationByStrongKey,
  persistOrganizationIdentifiers,
  RESOLVER_VERSION,
  resolveRecord,
  type ResolutionOutcome,
} from "@otn/resolution";
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

// Unique per test run so leftover graph rows from prior runs can't collide.
const RUN = randomUUID().slice(0, 8).toUpperCase();
const PARCEL = `9${RUN.replace(/\D/g, "0").padEnd(10, "7")}`.slice(0, 11);

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

async function insertRecord(
  normalized: NormalizedSourceRecord,
  rawFields: Record<string, unknown>,
  firstSeenAt: Date,
): Promise<{ id: string; normalized: NormalizedSourceRecord; rawFields: Record<string, unknown>; firstSeenAt: Date }> {
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
      normalizedFingerprint: `test-${normalized.externalId}-${RUN}`,
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
      canonicalUrl: `https://example.invalid/resolution-test/${RUN}`,
      retrievedAt: new Date(),
      contentType: "application/json",
      httpStatus: 200,
      storageKey: `raw/fake_source/resolution-test-${RUN}`,
      sha256: RUN.padEnd(64, "0").toLowerCase(),
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

describe("WS-B.4 — findBoundOrganizationByStrongKey (registry_ref dedup key)", () => {
  it("returns a registry-bound org sharing a normalized strong key; null for unbound / no key", async () => {
    const ubi = `7${RUN.replace(/[^0-9]/g, "0")}`; // run-unique test UBI (>= 7 chars)
    const boundRef = `b4b4b4b4-0000-0000-0000-${RUN.toLowerCase().padEnd(12, "0").slice(0, 12)}`;
    const unboundUbi = `8${RUN.replace(/[^0-9]/g, "0")}`;
    // A source record to attribute the identifiers to (FK; never resolved).
    const sr = await insertRecord(
      record({ externalId: `B4SR-${RUN}` }),
      {},
      new Date("2026-07-02T00:00:00Z"),
    );
    const [bound] = await db
      .insert(organizations)
      .values({ canonicalName: `RIVERA BUILDERS ${RUN}`, registryRef: boundRef })
      .returning({ id: organizations.id });
    const [unbound] = await db
      .insert(organizations)
      .values({ canonicalName: `PAINTED WORKS ${RUN}` })
      .returning({ id: organizations.id });
    try {
      // Persisted the real way so the finder is tested against the actual normalization.
      await persistOrganizationIdentifiers(db, bound!.id, sr.id, { ubi });
      await persistOrganizationIdentifiers(db, unbound!.id, sr.id, { ubi: unboundUbi });

      // Matches the bound org by a shared strong key, normalized the same way (spaces stripped).
      expect(await findBoundOrganizationByStrongKey(db, `  ${ubi}  `, null)).toBe(bound!.id);
      // Gated to registry_ref IS NOT NULL — an unbound org sharing a key is never collapsed onto.
      expect(await findBoundOrganizationByStrongKey(db, unboundUbi, null)).toBeNull();
      // No strong key ⇒ null.
      expect(await findBoundOrganizationByStrongKey(db, null, null)).toBeNull();
    } finally {
      await db.execute(
        sql`DELETE FROM organization_identifiers WHERE organization_id IN (${bound!.id}, ${unbound!.id})`,
      );
      await db.delete(organizations).where(inArray(organizations.id, [bound!.id, unbound!.id]));
      await db.execute(sql`DELETE FROM source_records WHERE id = ${sr.id}`);
    }
  });
});

describe("M2.2 resolver: SEPA + planning + permit resolve into one project", () => {
  const planningId = `SUP-${RUN}-0001`;
  const sepaFileRef = `SEP-${RUN}-0002`;
  let projectId: string;

  it("creates a project from the first planning record", async () => {
    const row = await insertRecord(
      record({
        externalId: planningId,
        recordType: "planning_application",
        title: `${planningId} – Roamers Test RV Park`,
        normalizedStage: "entitlement",
        statusRaw: "under review",
        parcelIds: [PARCEL],
        addressRaw: `${RUN.slice(0, 4)} Roamers Test Rd, Chehalis, WA 98532`,
        organizations: [{ name: "Roamers Test LLC", role: "applicant", evidenceText: "x" }],
      }),
      { fileNumbers: [planningId, sepaFileRef] },
      new Date("2026-07-01T00:00:00Z"),
    );
    const outcome = await resolveTracked(row);
    expect(outcome.outcome).toBe("created");
    expect(outcome.rule).toBe("new_project");
    projectId = outcome.projectId!;

    const ids = await db
      .select()
      .from(projectExternalIds)
      .where(eq(projectExternalIds.projectId, projectId));
    expect(ids.map((i) => i.externalId).sort()).toEqual([sepaFileRef, planningId].sort());

    const events = await db
      .select()
      .from(projectEvents)
      .where(eq(projectEvents.projectId, projectId));
    // The creating record carries its own event alongside first-seen.
    expect(events.map((e) => e.eventType).sort()).toEqual([
      "application_submitted",
      "project_first_seen",
    ]);
  });

  it("merges a SEPA record via explicit file-number reference (pass 2)", async () => {
    const row = await insertRecord(
      record({
        externalId: `77${RUN.replace(/\D/g, "1")}`,
        recordType: "sepa_document",
        title: `SEPA – Roamers Test RV Park DNS`,
        documentType: "DNS",
        issueDate: "2026-07-03",
        permittingJurisdiction: "Test Jurisdiction",
      }),
      { leadagencyfilenumber: sepaFileRef },
      new Date("2026-07-03T00:00:00Z"),
    );
    const outcome = await resolveTracked(row);
    expect(outcome.outcome).toBe("merged");
    expect(outcome.rule).toBe("explicit_reference");
    expect(outcome.projectId).toBe(projectId);
  });

  it("merges a permit via parcel overlap (pass 3) and advances the stage", async () => {
    const row = await insertRecord(
      record({
        externalId: `B-${RUN}-0100`,
        recordType: "building_permit",
        title: `B-${RUN}-0100 – NEW COMMERCIAL at 123 TEST RD`,
        normalizedStage: "permit_issued",
        statusRaw: "issued",
        issueDate: "2026-07-10",
        parcelIds: [PARCEL],
      }),
      {},
      new Date("2026-07-10T00:00:00Z"),
    );
    const outcome = await resolveTracked(row);
    expect(outcome.outcome).toBe("merged");
    expect(outcome.rule).toBe("parcel_overlap");
    expect(outcome.projectId).toBe(projectId);

    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(project!.currentStage).toBe("permit_issued");

    const events = await db
      .select()
      .from(projectEvents)
      .where(eq(projectEvents.projectId, projectId))
      .orderBy(projectEvents.observedAt);
    const types = events.map((e) => e.eventType);
    expect(types).toEqual([
      "project_first_seen",
      "application_submitted",
      "sepa_determination",
      "permit_issued",
    ]);
    const permitEvent = events[3]!;
    expect(permitEvent.priorStage).toBe("entitlement");
    expect(permitEvent.resultingStage).toBe("permit_issued");
    expect(permitEvent.materialChange).toBe(true);
  });

  it("a record whose own id is a registered official id matches pass 1", async () => {
    // The SEPA file number was registered from the planning record's
    // references; a later record carrying it as its own official id
    // (same jurisdiction) is a pass-1 match.
    const row = await insertRecord(
      record({
        externalId: sepaFileRef,
        recordType: "public_notice",
        title: `${sepaFileRef} – Roamers Test RV Park DNS notice`,
        normalizedStage: "entitlement",
      }),
      {},
      new Date("2026-07-12T00:00:00Z"),
    );
    const outcome = await resolveTracked(row);
    expect(outcome.outcome).toBe("merged");
    expect(outcome.rule).toBe("official_id");
    expect(outcome.projectId).toBe(projectId);
    // Stage never regresses from a lower-stage record.
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(project!.currentStage).toBe("permit_issued");
  });

  it("routes a cross-jurisdiction parcel match to review, not auto-merge", async () => {
    const row = await insertRecord(
      record({
        externalId: `TI-${RUN}-0001`,
        recordType: "building_permit",
        title: `TI-${RUN}-0001 – TENANT IMPROVEMENT`,
        permittingJurisdiction: "Other Jurisdiction",
        parcelIds: [PARCEL],
      }),
      {},
      new Date("2026-07-11T00:00:00Z"),
    );
    const outcome = await resolveTracked(row);
    expect(outcome.outcome).toBe("review");
    const [review] = await db
      .select()
      .from(resolutionReviews)
      .where(eq(resolutionReviews.sourceRecordId, row.id));
    expect(review!.status).toBe("pending");
    expect(review!.reasonsJson).toEqual(["conflicting_jurisdiction"]);
    expect(review!.candidateProjectId).toBe(projectId);
  });

  it("records resolver provenance and loses no source records", async () => {
    const resolutions = await db
      .select()
      .from(recordResolutions)
      .where(eq(recordResolutions.projectId, projectId));
    expect(resolutions.length).toBe(4);
    for (const r of resolutions) {
      expect(r.resolverVersion).toBe(RESOLVER_VERSION);
      expect(r.decision).toBe("auto");
      expect(r.status).toBe("active");
      expect(r.featuresJson).toBeTruthy();
      expect(r.score).toBeGreaterThan(0.9);
    }
    // Every inserted test record still exists (nothing deleted by resolution).
    const recs = await db
      .select({ id: sourceRecords.id })
      .from(sourceRecords)
      .where(
        and(
          eq(sourceRecords.sourceId, sourceId),
          inArray(sourceRecords.recordType, [
            "planning_application",
            "sepa_document",
            "building_permit",
            "public_notice",
          ]),
        ),
      );
    expect(recs.length).toBe(5);
  });
});
