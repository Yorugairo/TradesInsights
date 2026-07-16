/**
 * M2.5 — merge-review/split workflow (spec §10): human decisions recorded,
 * rejected candidates never re-matched, undo keeps source records intact.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type pg from "pg";
import {
  projectEvents,
  projectRoles,
  rawArtifacts,
  recordResolutions,
  resolutionReviews,
  sourceRecords,
  sourceRuns,
  type Db,
} from "@otn/db";
import type { NormalizedSourceRecord } from "@otn/domain";
import {
  decideReview,
  listPendingReviews,
  resolveRecord,
  undoResolution,
  type ResolutionOutcome,
} from "@otn/resolution";
import { deleteTestProjects, resetSource, testDb } from "./helpers.js";

let db: Db;
let pool: pg.Pool;
let sourceId: string;
let artifactId: string;
const createdProjects = new Set<string>();

const RUN = randomUUID().slice(0, 8).toUpperCase();
const ADDRESS = `${RUN.slice(0, 4)} Review Test Blvd, Olympia, WA 98501`;

async function resolveTracked(
  row: Parameters<typeof resolveRecord>[1],
  opts?: Parameters<typeof resolveRecord>[2],
): Promise<ResolutionOutcome> {
  const outcome = await resolveRecord(db, row, opts);
  if (outcome.projectId) createdProjects.add(outcome.projectId);
  return outcome;
}

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

async function insertRecord(normalized: NormalizedSourceRecord) {
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
      normalizedFingerprint: `rev-${normalized.externalId}-${RUN}`,
    })
    .returning({ id: sourceRecords.id });
  return { id: row!.id, normalized, rawFields: {}, firstSeenAt };
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
      canonicalUrl: `https://example.invalid/review-test/${RUN}`,
      retrievedAt: new Date(),
      contentType: "application/json",
      httpStatus: 200,
      storageKey: `raw/fake_source/review-test-${RUN}`,
      sha256: `e${RUN}`.padEnd(64, "4").toLowerCase(),
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

describe("M2.5 merge-review workflow", () => {
  let anchorProjectId: string;
  let tiReviewId: string;
  let tiRecordId: string;

  it("seeds an anchor and a same-address TI review", async () => {
    const anchor = await resolveTracked(
      await insertRecord(
        record({
          externalId: `RANCH-${RUN}`,
          title: `RANCH-${RUN} – Review Plaza Offices`,
          addressRaw: ADDRESS,
          normalizedStage: "permit_issued",
        }),
      ),
    );
    anchorProjectId = anchor.projectId!;

    const ti = await resolveTracked(
      await insertRecord(
        record({
          externalId: `RTI-${RUN}`,
          title: `RTI-${RUN} – Tenant Improvement`,
          addressRaw: ADDRESS,
        }),
      ),
    );
    expect(ti.outcome).toBe("review");
    tiRecordId = ti.sourceRecordId;

    const pending = await listPendingReviews(db);
    const mine = pending.find((r) => r.sourceRecordId === tiRecordId);
    expect(mine).toBeTruthy();
    tiReviewId = mine!.id;
  });

  it("merge decision joins the record with review_approved provenance", async () => {
    const outcome = await decideReview(db, tiReviewId, "merge", {
      decidedBy: "test-reviewer",
      note: "same building, TI belongs to plaza project",
    });
    expect(outcome.outcome).toBe("merged");
    expect(outcome.projectId).toBe(anchorProjectId);

    const [resolution] = await db
      .select()
      .from(recordResolutions)
      .where(
        and(
          eq(recordResolutions.sourceRecordId, tiRecordId),
          eq(recordResolutions.status, "active"),
        ),
      );
    expect(resolution!.decision).toBe("review_approved");
    const [review] = await db
      .select()
      .from(resolutionReviews)
      .where(eq(resolutionReviews.id, tiReviewId));
    expect(review!.status).toBe("merged");
    expect(review!.decidedBy).toBe("test-reviewer");
  });

  it("undo (split) removes derived rows, keeps the source record, and allows re-resolution", async () => {
    await undoResolution(db, tiRecordId, { reason: "wrong merge — separate tenant project" });

    const [resolution] = await db
      .select()
      .from(recordResolutions)
      .where(eq(recordResolutions.sourceRecordId, tiRecordId));
    expect(resolution!.status).toBe("undone");
    expect(resolution!.undoneReason).toContain("separate tenant");

    const events = await db
      .select()
      .from(projectEvents)
      .where(eq(projectEvents.sourceRecordId, tiRecordId));
    expect(events.length).toBe(0);
    const roles = await db
      .select()
      .from(projectRoles)
      .where(eq(projectRoles.sourceRecordId, tiRecordId));
    expect(roles.length).toBe(0);

    // The source record itself is untouched.
    const [rec] = await db
      .select({ id: sourceRecords.id })
      .from(sourceRecords)
      .where(eq(sourceRecords.id, tiRecordId));
    expect(rec).toBeTruthy();
  });

  it("reject decision re-resolves with the candidate excluded → new project", async () => {
    // A fresh review for the same scenario.
    const ti2 = await resolveTracked(
      await insertRecord(
        record({
          externalId: `RTI2-${RUN}`,
          title: `RTI2-${RUN} – Tenant Improvement`,
          addressRaw: ADDRESS,
        }),
      ),
    );
    expect(ti2.outcome).toBe("review");
    const pending = await listPendingReviews(db);
    const reviewId = pending.find((r) => r.sourceRecordId === ti2.sourceRecordId)!.id;

    const outcome = await decideReview(db, reviewId, "reject", {
      decidedBy: "test-reviewer",
      note: "separate tenant project",
    });
    if (outcome.projectId) createdProjects.add(outcome.projectId);
    expect(outcome.outcome).toBe("created");
    expect(outcome.projectId).not.toBe(anchorProjectId);

    const [review] = await db
      .select()
      .from(resolutionReviews)
      .where(eq(resolutionReviews.id, reviewId));
    expect(review!.status).toBe("rejected");
  });
});
