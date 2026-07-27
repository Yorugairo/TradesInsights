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
  projectExternalIds,
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
  reevaluatePendingReviews,
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

    const pending = await listPendingReviews(db, 10_000); // live corpus carries real pending reviews
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
    const pending = await listPendingReviews(db, 10_000); // live corpus carries real pending reviews
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

/**
 * Re-evaluation: a parked review is a verdict on the evidence available WHEN IT
 * WAS PARKED, and nothing ever re-asked the question. 2,505 rows had piled up,
 * the oldest four days old, and pass 1b deliberately adds more.
 *
 * The three properties that matter are pinned here: an authoritative id that
 * AGREES with the parked candidate merges into it; one that DISAGREES rejects
 * and re-resolves onto the right project (this is the 46 split permits repaired
 * by hand on 2026-07-27); and a review with no new evidence is left completely
 * alone, because "nobody has looked at this in a while" is not evidence.
 *
 * The strong evidence is created by registering the permit number against a
 * project directly. That is exactly what arriving evidence looks like to the
 * resolver — `project_external_ids` is the only thing pass 1 reads — and it
 * avoids standing up a second source just to reach the same state.
 */
describe("re-evaluation clears reviews that new evidence has made unambiguous", () => {
  const REEV_ADDRESS = `${RUN.slice(0, 4)} Reevaluate Way, Olympia, WA 98502`;
  const AGREE_ID = `REEVA-${RUN}`;
  const DIVERGE_ID = `REEVD-${RUN}`;
  let candidateProjectId: string;
  let otherProjectId: string;
  let agreeReviewId: string;
  let divergeReviewId: string;

  async function reviewFor(externalId: string): Promise<string> {
    const [rv] = await db
      .select({ id: resolutionReviews.id })
      .from(resolutionReviews)
      .innerJoin(sourceRecords, eq(sourceRecords.id, resolutionReviews.sourceRecordId))
      .where(
        and(eq(sourceRecords.externalId, externalId), eq(resolutionReviews.status, "pending")),
      );
    return rv!.id;
  }

  it("seeds an anchor, two same-address reviews, and an unrelated project", async () => {
    const anchor = await resolveTracked(
      await insertRecord(
        record({
          externalId: `REEVANCH-${RUN}`,
          title: `Reevaluate Anchor ${RUN}`,
          addressRaw: REEV_ADDRESS,
          normalizedStage: "permit_issued",
        }),
      ),
    );
    candidateProjectId = anchor.projectId!;

    // Same address, an unrelated name → address_name / same_address_name_mismatch.
    for (const [externalId, title] of [
      [AGREE_ID, `Zeta Bakery Fitout ${RUN}`],
      [DIVERGE_ID, `Omega Laundromat Fitout ${RUN}`],
    ] as const) {
      const outcome = await resolveTracked(
        await insertRecord(record({ externalId, title, addressRaw: REEV_ADDRESS })),
      );
      expect(outcome.outcome).toBe("review");
    }
    agreeReviewId = await reviewFor(AGREE_ID);
    divergeReviewId = await reviewFor(DIVERGE_ID);

    const other = await resolveTracked(
      await insertRecord(
        record({
          externalId: `REEVOTH-${RUN}`,
          title: `Reevaluate Other ${RUN}`,
          addressRaw: `${RUN.slice(0, 4)} Elsewhere Rd, Olympia, WA 98503`,
        }),
      ),
    );
    otherProjectId = other.projectId!;
    expect(otherProjectId).not.toBe(candidateProjectId);
  });

  it("leaves an unchanged ambiguous review completely alone", async () => {
    const summary = await reevaluatePendingReviews(db, {
      apply: true,
      reviewIds: [agreeReviewId, divergeReviewId],
    });
    expect(summary.scanned).toBe(2);
    expect(summary.resolved).toBe(0);
    expect(summary.stillAmbiguous).toBe(2);
    expect(summary.errors).toHaveLength(0);

    // Still pending — a fuzzy verdict is never strong enough on its own, which
    // is the whole safety property. Age is not evidence.
    const [rv] = await db
      .select()
      .from(resolutionReviews)
      .where(eq(resolutionReviews.id, agreeReviewId));
    expect(rv!.status).toBe("pending");
  });

  it("defaults to dry-run and writes nothing", async () => {
    // Evidence arrives: this permit number is now registered on the very project
    // the review was parked against.
    await db.insert(projectExternalIds).values({
      projectId: candidateProjectId,
      authority: "Test Jurisdiction",
      idType: "primary",
      externalId: AGREE_ID,
    });

    const dry = await reevaluatePendingReviews(db, { reviewIds: [agreeReviewId] });
    expect(dry.apply).toBe(false);
    expect(dry.resolved).toBe(1);
    expect(dry.byRule["official_id"]).toBe(1);

    const [rv] = await db
      .select()
      .from(resolutionReviews)
      .where(eq(resolutionReviews.id, agreeReviewId));
    expect(rv!.status).toBe("pending");
    expect(rv!.decidedBy).toBeNull();
  });

  it("merges when the authoritative id agrees with the parked candidate", async () => {
    const summary = await reevaluatePendingReviews(db, {
      apply: true,
      reviewIds: [agreeReviewId],
    });
    expect(summary.resolved).toBe(1);
    expect(summary.mismatched).toBe(0);

    const [rv] = await db
      .select()
      .from(resolutionReviews)
      .where(eq(resolutionReviews.id, agreeReviewId));
    expect(rv!.status).toBe("merged");
    expect(rv!.decidedBy).toBe("system/reevaluation");

    const [res] = await db
      .select()
      .from(recordResolutions)
      .where(
        and(
          eq(recordResolutions.sourceRecordId, rv!.sourceRecordId),
          eq(recordResolutions.status, "active"),
        ),
      );
    expect(res!.projectId).toBe(candidateProjectId);
  });

  it("rejects and re-resolves when the authoritative id names a DIFFERENT project", async () => {
    // The shape of all 46 split permits: the review points at one project and
    // the permit number turns out to belong to another. Merging into the parked
    // candidate here would bind the record to the project the evidence overruled.
    await db.insert(projectExternalIds).values({
      projectId: otherProjectId,
      authority: "Test Jurisdiction",
      idType: "primary",
      externalId: DIVERGE_ID,
    });

    const summary = await reevaluatePendingReviews(db, {
      apply: true,
      reviewIds: [divergeReviewId],
    });
    expect(summary.resolved).toBe(1);
    expect(summary.mismatched).toBe(0);
    expect(summary.byRule["official_id"]).toBe(1);

    const [rv] = await db
      .select()
      .from(resolutionReviews)
      .where(eq(resolutionReviews.id, divergeReviewId));
    expect(rv!.status).toBe("rejected");
    expect(rv!.decidedBy).toBe("system/reevaluation");

    const [res] = await db
      .select()
      .from(recordResolutions)
      .where(
        and(
          eq(recordResolutions.sourceRecordId, rv!.sourceRecordId),
          eq(recordResolutions.status, "active"),
        ),
      );
    // Landed on the project the permit number actually names, NOT the candidate.
    expect(res!.projectId).toBe(otherProjectId);
    expect(res!.projectId).not.toBe(candidateProjectId);
  });

  it("reports an empty queue as zero rather than failing", async () => {
    const summary = await reevaluatePendingReviews(db, { reviewIds: [] , limit: 0 });
    expect(summary.scanned).toBe(0);
    expect(summary.resolved).toBe(0);
    expect(summary.errors).toHaveLength(0);
  });
});
