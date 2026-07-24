/**
 * Corporate-family tier — the identity level ABOVE the legal entity.
 *
 * Two things must hold against a real database:
 *   1. A project worked by two COMPANIES of the same family is counted ONCE.
 *      Enterprise rollup already collapses brands of one entity; a family spans
 *      entities, so it needs its own collapse or every shared job double-counts.
 *   2. The Insights-side person candidates that feed principal ↔ person discovery
 *      admit sole-proprietor humans and refuse company names — the SQL prefilter
 *      must not be looser than `personCoreKey`, or a business name could reach
 *      the principal index.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import {
  organizations,
  projects,
  rawArtifacts,
  sourceRecords,
  sourceRuns,
  type Db,
} from "@otn/db";
import { buildFamilies, corporateFamilyRollup, loadPersonCandidates } from "@otn/intelligence";
import { matchPrincipalsToPeople, buildPrincipalPersonIndex, type RegistryIdentityRow } from "@otn/resolution";
import { resetSource, testDb } from "./helpers.js";

const RUN = randomUUID().slice(0, 8).toUpperCase();
// Letters-only variant for anything that has to survive name normalization —
// person keys strip digits, so a hex run token would make the seeded name and
// the seeded principal disagree for reasons that have nothing to do with the code.
const TAG = RUN.replace(/[0-9]/g, (d) => "ABCDEFGHIJ"[Number(d)]!);
const JURISDICTION = `Family Test City ${RUN}`;
// Registry entity ids are opaque strings on this side; stable per run so two
// test files running in parallel cannot collide on a family id.
const ENTITY_A = `ent-a-${RUN}`;
const ENTITY_B = `ent-b-${RUN}`;
const PRINCIPAL = { name: `Erdahl${TAG}, Darrin Paul`, key: `ERDAHL${TAG}, DARRIN P` };

let db: Db;
let pool: pg.Pool;
let recordId: string;
const orgIds: string[] = [];
const projectIds: string[] = [];

/** A contract row carrying one principal — the registry side of the seam. */
const contractRow = (entityId: string, name: string): RegistryIdentityRow => ({
  entityId,
  ubi: null,
  contractorNumbers: null,
  canonicalName: name,
  canonicalNameNormalized: name.toUpperCase(),
  phone: null,
  cityToken: null,
  stateCode: "WA",
  registeredAddress: null,
  registeredPostalCode: null,
  status: "active",
  principals: [PRINCIPAL],
});

async function seedOrg(name: string, registryRef: string | null): Promise<string> {
  const [o] = await db
    .insert(organizations)
    .values({ canonicalName: `${name} ${TAG}`, registryRef })
    .returning({ id: organizations.id });
  orgIds.push(o!.id);
  return o!.id;
}

async function seedProject(n: number): Promise<string> {
  const [p] = await db
    .insert(projects)
    .values({
      canonicalName: `FAMT-${RUN}-${n}`,
      permittingJurisdiction: JURISDICTION,
      county: "Pierce",
      currentStage: "permit_issued",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    })
    .returning({ id: projects.id });
  projectIds.push(p!.id);
  return p!.id;
}

async function addRole(projectId: string, orgId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO project_roles
      (project_id, organization_id, role, source_record_id, confirmed, first_seen_at, last_seen_at)
    VALUES (${projectId}, ${orgId}, 'primary_contractor', ${recordId}, true, now(), now())`);
}

let orgA: string;
let orgB: string;
let sharedProject: string;

beforeAll(async () => {
  ({ db, pool } = await testDb());
  const sourceId = await resetSource(db, "fake_source");
  const [run] = await db
    .insert(sourceRuns)
    .values({ sourceId, status: "succeeded" })
    .returning({ id: sourceRuns.id });
  const [artifact] = await db
    .insert(rawArtifacts)
    .values({
      sourceId,
      sourceRunId: run!.id,
      canonicalUrl: `https://example.invalid/family-test/${RUN}`,
      retrievedAt: new Date(),
      contentType: "application/json",
      httpStatus: 200,
      storageKey: `raw/fake_source/family-test-${RUN}`,
      sha256: `f${RUN}`.padEnd(64, "3").toLowerCase(),
      byteSize: 2,
      headersJson: {},
      parserVersion: "test",
    })
    .returning({ id: rawArtifacts.id });
  const [rec] = await db
    .insert(sourceRecords)
    .values({
      sourceId,
      rawArtifactId: artifact!.id,
      externalId: `FAMT-${RUN}`,
      recordType: "building_permit",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      rawFieldsJson: {},
      normalizedJson: { title: `FAMT-${RUN}` },
      normalizedFingerprint: `famt-${RUN}`,
    })
    .returning({ id: sourceRecords.id });
  recordId = rec!.id;

  // Two DIFFERENT registry entities under one principal — the whole point of the
  // tier. The enterprise rollup would report these as two unrelated companies.
  orgA = await seedOrg("BLACK LION HEATING", ENTITY_A);
  orgB = await seedOrg("STURM HEATING", ENTITY_B);
  // An unbound org whose name happens to be the principal's — it has no entity,
  // so it must never join the family's activity.
  // Inserted directly rather than through seedOrg: this one's name must stay a
  // clean two-token person name, which is exactly what the discovery lane keys on.
  const [person] = await db
    .insert(organizations)
    .values({ canonicalName: `DARRIN ERDAHL${TAG}` })
    .returning({ id: organizations.id });
  orgIds.push(person!.id);

  sharedProject = await seedProject(1);
  await addRole(sharedProject, orgA);
  await addRole(sharedProject, orgB); // same job, two family members
  const soloA = await seedProject(2);
  await addRole(soloA, orgA);
});

afterAll(async () => {
  for (const p of projectIds) {
    await db.execute(sql`DELETE FROM project_roles WHERE project_id = ${p}`);
    await db.execute(sql`DELETE FROM projects WHERE id = ${p}`);
  }
  for (const o of orgIds) await db.execute(sql`DELETE FROM organizations WHERE id = ${o}`);
  await pool.end();
});

describe("corporateFamilyRollup", () => {
  const rows = () => [
    contractRow(ENTITY_A, `Black Lion Heating ${RUN}`),
    contractRow(ENTITY_B, `Sturm Heating ${RUN}`),
  ];

  it("counts a project shared by two family members ONCE", async () => {
    const { families } = buildFamilies(rows());
    const [rollup] = await corporateFamilyRollup(db, families, { jurisdiction: JURISDICTION });
    // 2 projects, not 3: the shared job collapses before aggregation.
    expect(rollup?.projects).toBe(2);
    expect(rollup?.boundEntityCount).toBe(2);
    expect(rollup?.brandCount).toBe(2);
    expect(rollup?.orgNames.sort()).toEqual([`BLACK LION HEATING ${TAG}`, `STURM HEATING ${TAG}`]);
  });

  it("excludes an unbound org even when its name is the principal's", async () => {
    const { families } = buildFamilies(rows());
    const [rollup] = await corporateFamilyRollup(db, families, { jurisdiction: JURISDICTION });
    expect(rollup?.orgNames).not.toContain(`DARRIN ERDAHL${TAG}`);
  });

  it("returns nothing when there are no families (older contract, no principals)", async () => {
    expect(await corporateFamilyRollup(db, [], { jurisdiction: JURISDICTION })).toEqual([]);
  });
});

describe("principal ↔ person discovery", () => {
  it("admits the sole-proprietor human and refuses the company names", async () => {
    const candidates = await loadPersonCandidates(db);
    const mine = candidates.filter((c) => c.organizationName.includes(TAG));
    expect(mine.map((c) => c.personName)).toEqual([`DARRIN ERDAHL${TAG}`]);
    // Neither company name survives the prefilter — "HEATING" marks a business.
    expect(mine.some((c) => c.personName.includes("HEATING"))).toBe(false);
  });

  it("reaches both registry entities from the unbound person, flagged as new", async () => {
    // Asserts the wiring end to end: an unbound Insights org that is really a
    // person reaches BOTH registry entities that person controls. The key rules
    // themselves are unit-tested in principal-person.test.ts.
    const index = buildPrincipalPersonIndex([
      contractRow(ENTITY_A, "Black Lion Heating"),
      contractRow(ENTITY_B, "Sturm Heating"),
    ]);
    const pairs = matchPrincipalsToPeople(
      [{
        source: "organization",
        organizationId: orgIds[2]!,
        organizationName: `DARRIN ERDAHL${TAG}`,
        personName: `Darrin Erdahl${TAG}`,
        registryRef: null,
      }],
      index,
    );
    // One row PER entity — pair-level review, not one row listing both.
    expect(pairs.map((p) => p.entity.entityId).sort()).toEqual([ENTITY_A, ENTITY_B].sort());
    expect(pairs.every((p) => !p.alreadyBound)).toBe(true);
  });
});
