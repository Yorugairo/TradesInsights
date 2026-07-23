/**
 * Batch3 #1 — review-queue triage: cluster pending reviews by
 * (rule, reason, candidate project) and decide a whole cluster with the same
 * per-row provenance as one-at-a-time decisions. The queue arrives in
 * pattern-shaped waves (Pierce activation → 1,425 fuzzy-without-support
 * reviews); triage turns per-row work into per-pattern work.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { rawArtifacts, sourceRecords, sourceRuns, type Db } from "@otn/db";
import type { NormalizedSourceRecord } from "@otn/domain";
import {
  decideReviewCluster,
  resolveRecord,
  triageReviewQueue,
  type ResolutionOutcome,
} from "@otn/resolution";
import { deleteTestProjects, resetSource, testDb } from "./helpers.js";

const RUN = randomUUID().slice(0, 8).toUpperCase();
const ADDR_A = `${RUN.slice(0, 4)} Triage Alpha Ave, Olympia, WA 98501`;
const ADDR_B = `${RUN.slice(4, 8)} Triage Beta Blvd, Olympia, WA 98501`;

let db: Db;
let pool: pg.Pool;
let sourceId: string;
let artifactId: string;
const createdProjects = new Set<string>();

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
      normalizedFingerprint: `triage-${normalized.externalId}-${RUN}`,
    })
    .returning({ id: sourceRecords.id });
  const outcome = await resolveRecord(db, {
    id: row!.id,
    normalized,
    rawFields: {},
    firstSeenAt,
  });
  if (outcome.projectId) createdProjects.add(outcome.projectId);
  return outcome;
}

let anchorA: string;
let anchorB: string;

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
      canonicalUrl: `https://example.invalid/triage-test/${RUN}`,
      retrievedAt: new Date(),
      contentType: "application/json",
      httpStatus: 200,
      storageKey: `raw/fake_source/triage-test-${RUN}`,
      sha256: `f${RUN}`.padEnd(64, "6").toLowerCase(),
      byteSize: 2,
      headersJson: {},
      parserVersion: "test",
    })
    .returning({ id: rawArtifacts.id });
  artifactId = artifact!.id;

  // Anchors at two addresses; same-address different-name records become
  // pending reviews pointing at each anchor (the same_address_name_mismatch
  // gate), giving two distinct triage clusters.
  anchorA = (
    await insertAndResolve(
      record({
        externalId: `TA-${RUN}`,
        title: `TA-${RUN} – Alpha Center Offices`,
        addressRaw: ADDR_A,
        normalizedStage: "permit_issued",
      }),
    )
  ).projectId!;
  anchorB = (
    await insertAndResolve(
      record({
        externalId: `TB-${RUN}`,
        title: `TB-${RUN} – Beta Plaza Retail`,
        addressRaw: ADDR_B,
        normalizedStage: "permit_issued",
      }),
    )
  ).projectId!;

  for (let n = 1; n <= 3; n++) {
    const o = await insertAndResolve(
      record({
        externalId: `TA-TI-${RUN}-${n}`,
        title: `TA-TI-${RUN}-${n} – Tenant Improvement Suite ${n}`,
        addressRaw: ADDR_A,
      }),
    );
    expect(o.outcome).toBe("review");
  }
  for (let n = 1; n <= 2; n++) {
    const o = await insertAndResolve(
      record({
        externalId: `TB-TI-${RUN}-${n}`,
        title: `TB-TI-${RUN}-${n} – Tenant Improvement Bay ${n}`,
        addressRaw: ADDR_B,
      }),
    );
    expect(o.outcome).toBe("review");
  }
});

afterAll(async () => {
  await db.execute(sql`
    DELETE FROM resolution_reviews WHERE source_record_id IN
      (SELECT id FROM source_records WHERE source_id = ${sourceId})`);
  await deleteTestProjects(db, [...createdProjects]);
  await pool.end();
});

describe("Batch3 #1 — triage clusters", () => {
  it("clusters pending reviews by (rule, reason, candidate) with samples", async () => {
    const clusters = await triageReviewQueue(db);
    const a = clusters.find((c) => c.candidateProjectId === anchorA)!;
    const b = clusters.find((c) => c.candidateProjectId === anchorB)!;
    expect(a).toBeTruthy();
    expect(a.count).toBe(3);
    expect(a.reasonKey).toBe("same_address_name_mismatch");
    expect(a.candidateName).toContain("Alpha Center"); // canonical_name keeps record casing
    expect(a.sampleTitles.length).toBeGreaterThanOrEqual(1);
    expect(a.sampleTitles[0]).toContain("Tenant Improvement");
    expect(b.count).toBe(2);
  });

  it("bulk reject decides exactly the cluster, with per-row provenance, and leaves others pending", async () => {
    const clusters = await triageReviewQueue(db);
    const a = clusters.find((c) => c.candidateProjectId === anchorA)!;
    const summary = await decideReviewCluster(db, {
      matchedRule: a.matchedRule,
      reasonKey: a.reasonKey,
      candidateProjectId: anchorA,
      decision: "reject",
      decidedBy: "triage-test",
      note: "bulk reject e2e",
    });
    expect(summary.matched).toBe(3);
    expect(summary.decided).toBe(3);
    expect(summary.errors).toEqual([]);
    // Every rejected row is re-resolved away from the anchor — but NOT
    // necessarily into three separate projects. All three TIs share ADDR_A and
    // near-identical titles, so once the first one creates a project the other
    // two legitimately merge into it via the address+name pass; whether they do
    // depends on ordering. Asserting `created === 3` encoded that race and made
    // this test flaky. What the case actually claims is that the cluster was
    // decided exactly, so assert the real invariant: each row landed somewhere,
    // and no row stayed on the anchor.
    expect(summary.created).toBeGreaterThanOrEqual(1);
    expect(summary.created).toBeLessThanOrEqual(3);
    const resolved = await db.execute(sql`
      SELECT count(*)::int AS n FROM record_resolutions rr
      JOIN source_records sr ON sr.id = rr.source_record_id
      WHERE sr.source_id = ${sourceId} AND rr.status = 'active'
        AND rr.project_id <> ${anchorA}
        AND sr.external_id LIKE ${`TA-TI-${RUN}-%`}`);
    expect((resolved.rows[0] as { n: number }).n).toBe(3);

    // Track the new projects for cleanup.
    const created = await db.execute(sql`
      SELECT rr.project_id FROM record_resolutions rr
      JOIN source_records sr ON sr.id = rr.source_record_id
      WHERE sr.source_id = ${sourceId} AND rr.status = 'active'`);
    for (const r of created.rows as { project_id: string }[]) createdProjects.add(r.project_id);

    // Per-row audit: all three rows rejected with the decider + note recorded.
    const audited = await db.execute(sql`
      SELECT count(*) AS n FROM resolution_reviews rv
      JOIN source_records sr ON sr.id = rv.source_record_id
      WHERE sr.source_id = ${sourceId} AND rv.status = 'rejected'
        AND rv.decided_by = 'triage-test' AND rv.decision_note = 'bulk reject e2e'`);
    expect(Number((audited.rows[0] as { n: string }).n)).toBe(3);

    // The B cluster is untouched.
    const after = await triageReviewQueue(db);
    expect(after.find((c) => c.candidateProjectId === anchorA)).toBeUndefined();
    expect(after.find((c) => c.candidateProjectId === anchorB)!.count).toBe(2);

    // Idempotent: rerunning the same cluster decision matches nothing.
    const again = await decideReviewCluster(db, {
      matchedRule: a.matchedRule,
      reasonKey: a.reasonKey,
      candidateProjectId: anchorA,
      decision: "reject",
      decidedBy: "triage-test",
    });
    expect(again.matched).toBe(0);
  });

  it("bulk merge joins every cluster record to the candidate as review_approved", async () => {
    const clusters = await triageReviewQueue(db);
    const b = clusters.find((c) => c.candidateProjectId === anchorB)!;
    const summary = await decideReviewCluster(db, {
      matchedRule: b.matchedRule,
      reasonKey: b.reasonKey,
      candidateProjectId: anchorB,
      decision: "merge",
      decidedBy: "triage-test",
    });
    expect(summary).toMatchObject({ matched: 2, decided: 2, merged: 2 });

    const merged = await db.execute(sql`
      SELECT count(*) AS n FROM record_resolutions
      WHERE project_id = ${anchorB} AND decision = 'review_approved' AND status = 'active'`);
    expect(Number((merged.rows[0] as { n: string }).n)).toBe(2);
  });
});
