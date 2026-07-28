/**
 * Data hygiene round 2, T2 — review-queue honesty.
 *
 * `same_address_name_mismatch` is the biggest decidable-LOOKING bucket in the
 * queue, and round 1 measured that 0 of its 784 rows collapse under a more
 * forgiving name comparison. The reason is structural: the resolver compared the
 * source record's TITLE to the candidate project's NAME, and neither of those is
 * a company name. `reclassifyComparanda` re-asks the question against the
 * candidate's ORGANIZATION names and labels each row by what it found.
 *
 * The three cases below are the three outcomes, and the assertions that matter
 * most are the negative ones: no row's status, decider, or decision note is ever
 * written by this pass.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { rawArtifacts, sourceRecords, sourceRuns, type Db } from "@otn/db";
import type { NormalizedSourceRecord } from "@otn/domain";
import {
  AWAITING_ORG_EVIDENCE,
  COMPARANDA_ORG_ROLES,
  reclassifyComparanda,
  resolveRecord,
  triageReviewQueue,
  type ResolutionOutcome,
} from "@otn/resolution";
import { deleteTestProjects, resetSource, testDb } from "./helpers.js";

const RUN = randomUUID().slice(0, 8).toUpperCase();
const ADDR_AGREE = `${RUN.slice(0, 4)} Reclassify Agree Ave, Olympia, WA 98501`;
const ADDR_DISAGREE = `${RUN.slice(4, 8)} Reclassify Disagree Blvd, Olympia, WA 98501`;
const ADDR_NO_ORG = `${RUN.slice(0, 4)} Reclassify Bare Way, Olympia, WA 98501`;

/** The org name the "agree" case will re-compare against, and the title that matches it. */
const AGREE_ORG = `HARBOR ${RUN} BUILDERS LLC`;
const DISAGREE_ORG = `ZEBRA ${RUN} MECHANICAL LLC`;

let db: Db;
let pool: pg.Pool;
let sourceId: string;
let artifactId: string;
const createdProjects = new Set<string>();
let projAgree: string;
let projDisagree: string;
let projNoOrg: string;

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
      normalizedFingerprint: `reclassify-${normalized.externalId}-${RUN}`,
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
      canonicalUrl: `https://example.invalid/reclassify-test/${RUN}`,
      retrievedAt: new Date(),
      contentType: "application/json",
      httpStatus: 200,
      storageKey: `raw/fake_source/reclassify-test-${RUN}`,
      sha256: `c${RUN}`.padEnd(64, "3").toLowerCase(),
      byteSize: 2,
      headersJson: {},
      parserVersion: "test",
    })
    .returning({ id: rawArtifacts.id });
  artifactId = artifact!.id;

  // Anchor 1 — carries an organization whose name the follow-up record repeats.
  projAgree = (
    await insertAndResolve(
      record({
        externalId: `RC-A-${RUN}`,
        title: `RC-A-${RUN} – Harbor Center Offices`,
        addressRaw: ADDR_AGREE,
        normalizedStage: "permit_issued",
        organizations: [
          { name: AGREE_ORG, role: "primary_contractor", evidenceText: "Contractor: " + AGREE_ORG },
        ],
      }),
    )
  ).projectId!;

  // Anchor 2 — carries an organization that has nothing to do with the follow-up.
  projDisagree = (
    await insertAndResolve(
      record({
        externalId: `RC-D-${RUN}`,
        title: `RC-D-${RUN} – Beta Plaza Retail`,
        addressRaw: ADDR_DISAGREE,
        normalizedStage: "permit_issued",
        organizations: [
          {
            name: DISAGREE_ORG,
            role: "primary_contractor",
            evidenceText: "Contractor: " + DISAGREE_ORG,
          },
        ],
      }),
    )
  ).projectId!;

  // Anchor 3 — no organizations at all. This is the 784's shape.
  projNoOrg = (
    await insertAndResolve(
      record({
        externalId: `RC-N-${RUN}`,
        title: `RC-N-${RUN} – Bare Anchor Building`,
        addressRaw: ADDR_NO_ORG,
        normalizedStage: "permit_issued",
      }),
    )
  ).projectId!;

  // The follow-ups: same address, different title ⇒ same_address_name_mismatch.
  // The first one's TITLE is the org name, which is exactly the case the old
  // comparison could never see.
  for (const [addr, title, id] of [
    [ADDR_AGREE, AGREE_ORG, `RC-A-TI-${RUN}`],
    [ADDR_DISAGREE, `Tenant Improvement Suite 9 ${RUN}`, `RC-D-TI-${RUN}`],
    [ADDR_NO_ORG, `Tenant Improvement Bay 4 ${RUN}`, `RC-N-TI-${RUN}`],
  ] as const) {
    const o = await insertAndResolve(
      record({ externalId: id, title, addressRaw: addr }),
    );
    expect(o.outcome).toBe("review");
  }
});

afterAll(async () => {
  await db.execute(sql`
    DELETE FROM resolution_reviews WHERE source_record_id IN
      (SELECT id FROM source_records WHERE source_id = ${sourceId})`);
  await deleteTestProjects(db, [...createdProjects]);
  await db.execute(sql`
    DELETE FROM organizations WHERE canonical_name IN (${AGREE_ORG}, ${DISAGREE_ORG})`);
  await pool.end();
});

/** The review rows this test owns, with the two features_json keys under test. */
async function reviewFacets(): Promise<
  { candidate: string; awaiting: string | null; comparanda: string | null; status: string }[]
> {
  const res = await db.execute(sql`
    SELECT rv.candidate_project_id AS candidate,
           rv.features_json->>'awaiting' AS awaiting,
           rv.features_json->>'comparanda' AS comparanda,
           rv.status
    FROM resolution_reviews rv
    JOIN source_records sr ON sr.id = rv.source_record_id
    WHERE sr.source_id = ${sourceId}`);
  return res.rows as {
    candidate: string;
    awaiting: string | null;
    comparanda: string | null;
    status: string;
  }[];
}

describe("reclassifyComparanda", () => {
  it("writes nothing on a dry run, but reports what it would do", async () => {
    const summary = await reclassifyComparanda(db, { limit: 100 });
    expect(summary.apply).toBe(false);
    expect(summary.scanned).toBe(3);
    expect(summary.upgraded).toBe(1);
    expect(summary.awaitingTagged).toBe(1);
    expect(summary.leftActionable).toBe(1);
    expect(summary.byBasis.exact).toBe(1);

    for (const r of await reviewFacets()) {
      expect(r.awaiting).toBeNull();
      expect(r.comparanda).toBeNull();
    }
  });

  it("labels each row by what the candidate project's organizations actually say", async () => {
    const summary = await reclassifyComparanda(db, { apply: true, limit: 100 });
    expect(summary.apply).toBe(true);
    expect(summary.upgraded).toBe(1);
    expect(summary.awaitingTagged).toBe(1);
    expect(summary.leftActionable).toBe(1);

    const facets = await reviewFacets();
    const agree = facets.find((r) => r.candidate === projAgree)!;
    const disagree = facets.find((r) => r.candidate === projDisagree)!;
    const noOrg = facets.find((r) => r.candidate === projNoOrg)!;

    // Org names agree ⇒ genuinely decidable, and the row says so.
    expect(agree.comparanda).toBe(COMPARANDA_ORG_ROLES);
    expect(agree.awaiting).toBeNull();

    // Org names exist and disagree ⇒ two businesses at one address, which is
    // precisely what a human is for. Untouched.
    expect(disagree.comparanda).toBeNull();
    expect(disagree.awaiting).toBeNull();

    // No org evidence ⇒ nothing to compare; leaves the actionable queue.
    expect(noOrg.awaiting).toBe(AWAITING_ORG_EVIDENCE);
    expect(noOrg.comparanda).toBeNull();
  });

  it("never decides anything — status, decider and note stay untouched", async () => {
    const res = await db.execute(sql`
      SELECT count(*)::int AS n
      FROM resolution_reviews rv
      JOIN source_records sr ON sr.id = rv.source_record_id
      WHERE sr.source_id = ${sourceId}
        AND (rv.status <> 'pending' OR rv.decided_by IS NOT NULL
             OR rv.decided_at IS NOT NULL OR rv.decision_note IS NOT NULL)`);
    expect((res.rows[0] as { n: number }).n).toBe(0);
  });

  it("is idempotent — a second apply re-tags nothing", async () => {
    const again = await reclassifyComparanda(db, { apply: true, limit: 100 });
    expect(again.upgraded).toBe(0);
    expect(again.awaitingTagged).toBe(0);
    expect(again.alreadyTagged).toBe(2);
    expect(again.leftActionable).toBe(1);
  });

  it("moves the tagged cluster out of the operator's actionable queue", async () => {
    const clusters = await triageReviewQueue(db);
    const tagged = clusters.find((c) => c.candidateProjectId === projNoOrg)!;
    expect(tagged.awaiting).toBe(AWAITING_ORG_EVIDENCE);
    expect(tagged.reviewState).toBe("awaiting_evidence");

    // …while the upgraded one stays actionable and carries its evidence.
    const upgraded = clusters.find((c) => c.candidateProjectId === projAgree)!;
    expect(upgraded.comparanda).toBe(COMPARANDA_ORG_ROLES);
    expect(upgraded.reviewState).toBe("actionable");
  });
});
