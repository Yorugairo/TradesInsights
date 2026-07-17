/**
 * P1 — GC league table + relationship targets: deterministic rollup over
 * roles/projects/valuations; relevance = the router's judgment (opportunity
 * rows), data-quality names flagged not deleted, worked/blocked orgs never
 * become "targets".
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import {
  accountProfiles,
  organizations,
  projects,
  rawArtifacts,
  sourceRecords,
  sourceRuns,
  type Db,
} from "@otn/db";
import { orgActivityRollup, relationshipTargets } from "@otn/intelligence";
import { resetSource, testDb } from "./helpers.js";

const RUN = randomUUID().slice(0, 8).toUpperCase();

let db: Db;
let pool: pg.Pool;
let accountId: string;
let recordId: string; // role provenance (project_roles.source_record_id NOT NULL)
const orgIds: string[] = [];
const projectIds: string[] = [];

async function seedOrg(name: string): Promise<string> {
  const [o] = await db
    .insert(organizations)
    .values({ canonicalName: `${name} ${RUN}` })
    .returning({ id: organizations.id });
  orgIds.push(o!.id);
  return o!.id;
}

async function seedProjectWithRole(
  orgId: string,
  n: number,
  opts: { routed?: boolean; valuation?: number } = {},
): Promise<string> {
  const [p] = await db
    .insert(projects)
    .values({
      canonicalName: `ORGT-${RUN}-${n}`,
      permittingJurisdiction: `Org Test City ${RUN}`,
      county: "Thurston",
      currentStage: "permit_issued",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    })
    .returning({ id: projects.id });
  projectIds.push(p!.id);
  await db.execute(sql`
    INSERT INTO project_roles
      (project_id, organization_id, role, source_record_id, confirmed, first_seen_at, last_seen_at)
    VALUES (${p!.id}, ${orgId}, 'applicant', ${recordId}, true, now(), now())`);
  if (opts.routed) {
    await db.execute(sql`
      INSERT INTO opportunities (account_profile_id, project_id, current_score, state)
      VALUES (${accountId}, ${p!.id}, 70, 'weekly_digest')`);
  }
  return p!.id;
}

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
      canonicalUrl: `https://example.invalid/org-test/${RUN}`,
      retrievedAt: new Date(),
      contentType: "application/json",
      httpStatus: 200,
      storageKey: `raw/fake_source/org-test-${RUN}`,
      sha256: `a${RUN}`.padEnd(64, "8").toLowerCase(),
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
      externalId: `ORGT-${RUN}`,
      recordType: "building_permit",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      rawFieldsJson: {},
      normalizedJson: { title: `ORGT-${RUN}` },
      normalizedFingerprint: `orgt-${RUN}`,
    })
    .returning({ id: sourceRecords.id });
  recordId = rec!.id;

  const [account] = await db
    .insert(accountProfiles)
    .values({
      key: `test_org_${RUN.toLowerCase()}`,
      name: `Org Test ${RUN}`,
      active: true,
      capabilitiesJson: [],
      territoryJson: { counties_included: ["Thurston"] },
      deliveryConfigJson: {},
    })
    .returning({ id: accountProfiles.id });
  accountId = account!.id;

  // A: clean GC, 3 projects, 2 routed → the target.
  const a = await seedOrg("TRIAGE BUILDERS LLC");
  await seedProjectWithRole(a, 1, { routed: true });
  await seedProjectWithRole(a, 2, { routed: true });
  await seedProjectWithRole(a, 3);
  // B: placeholder name → flagged, hidden by default.
  const b = await seedOrg("NO PRIMARY APPLICANT AVAILABLE");
  await seedProjectWithRole(b, 4, { routed: true });
  await seedProjectWithRole(b, 5, { routed: true });
  // C: likely individual → flagged, hidden by default.
  const c = await seedOrg("JANE DOE");
  await seedProjectWithRole(c, 6, { routed: true });
  await seedProjectWithRole(c, 7, { routed: true });
  // D: already worked (active_relationship) → league yes, target no.
  const d = await seedOrg("KNOWN GC INC");
  await seedProjectWithRole(d, 8, { routed: true });
  await seedProjectWithRole(d, 9, { routed: true });
  await db.execute(sql`
    INSERT INTO account_organization_relationships
      (account_profile_id, organization_id, relationship_state)
    VALUES (${accountId}, ${d}, 'active_relationship')`);
  // E: blocked → never a target.
  const e = await seedOrg("BLOCKED CONTRACTORS CORP");
  await seedProjectWithRole(e, 10, { routed: true });
  await seedProjectWithRole(e, 11, { routed: true });
  await db.execute(sql`
    INSERT INTO account_organization_relationships
      (account_profile_id, organization_id, relationship_state, blocked)
    VALUES (${accountId}, ${e}, 'do_not_pursue', true)`);
  // F+G: legal-suffix variants of one GC → one league row, variants listed.
  const f = await seedOrg("COLE DRYWALL");
  await seedProjectWithRole(f, 12, { routed: true });
  await seedProjectWithRole(f, 13);
  const [gOrg] = await db
    .insert(organizations)
    .values({ canonicalName: `COLE DRYWALL ${RUN}, LLC` })
    .returning({ id: organizations.id });
  orgIds.push(gOrg!.id);
  await seedProjectWithRole(gOrg!.id, 14, { routed: true });
  await seedProjectWithRole(gOrg!.id, 15);
  // H: individual with a fused mailing address → split, flagged, hidden.
  const [hOrg] = await db
    .insert(organizations)
    .values({ canonicalName: `HULDA QUX ${RUN} 500 UNION STREET SUITE 410 SEATTLE WA 98101` })
    .returning({ id: organizations.id });
  orgIds.push(hOrg!.id);
  await seedProjectWithRole(hOrg!.id, 16, { routed: true });
  await seedProjectWithRole(hOrg!.id, 17, { routed: true });
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM opportunities WHERE account_profile_id = ${accountId}`);
  await db.execute(sql`
    DELETE FROM account_organization_relationships WHERE account_profile_id = ${accountId}`);
  for (const p of projectIds) {
    await db.execute(sql`DELETE FROM project_roles WHERE project_id = ${p}`);
    await db.execute(sql`DELETE FROM projects WHERE id = ${p}`);
  }
  for (const o of orgIds) await db.execute(sql`DELETE FROM organizations WHERE id = ${o}`);
  await db.execute(sql`DELETE FROM account_profiles WHERE id = ${accountId}`);
  await pool.end();
});

describe("P1 org activity rollup", () => {
  it("ranks by router-judged relevance and hides flagged names by default", async () => {
    const rows = await orgActivityRollup(db, { accountProfileId: accountId, minProjects: 2 });
    const names = rows.map((r) => r.name);
    expect(names).toContain(`TRIAGE BUILDERS LLC ${RUN}`);
    expect(names).toContain(`KNOWN GC INC ${RUN}`);
    expect(names).not.toContain(`NO PRIMARY APPLICANT AVAILABLE ${RUN}`); // placeholder hidden
    expect(names).not.toContain(`JANE DOE ${RUN}`); // likely individual hidden

    const a = rows.find((r) => r.name.startsWith("TRIAGE BUILDERS"))!;
    expect(a.projects).toBe(3);
    expect(a.relevantProjects).toBe(2); // only ROUTED projects count as relevant
    expect(a.counties).toEqual(["Thurston"]);
    expect(a.relationshipState).toBeNull();
  });

  it("flags (not deletes) placeholder and individual names when included", async () => {
    const rows = await orgActivityRollup(db, {
      accountProfileId: accountId,
      minProjects: 2,
      includeFlagged: true,
    });
    const b = rows.find((r) => r.name.startsWith("NO PRIMARY APPLICANT"))!;
    expect(b.flags).toContain("placeholder");
    const c = rows.find((r) => r.name.startsWith("JANE DOE"))!;
    expect(c.flags).toContain("likely_individual");
  });

  it("groups legal-suffix variants into one league row with variants listed", async () => {
    const rows = await orgActivityRollup(db, { accountProfileId: accountId, minProjects: 2 });
    const cole = rows.filter((r) => r.name.startsWith("COLE DRYWALL"));
    expect(cole).toHaveLength(1); // one row, not one per spelling
    expect(cole[0]!.variantNames.sort()).toEqual(
      [`COLE DRYWALL ${RUN}`, `COLE DRYWALL ${RUN}, LLC`].sort(),
    );
    expect(cole[0]!.projects).toBe(4);
    expect(cole[0]!.relevantProjects).toBe(2);
  });

  it("splits fused addresses, flags the individual, hides by default", async () => {
    const byDefault = await orgActivityRollup(db, { accountProfileId: accountId, minProjects: 2 });
    expect(byDefault.some((r) => r.name.includes("HULDA QUX"))).toBe(false);
    const included = await orgActivityRollup(db, {
      accountProfileId: accountId,
      minProjects: 2,
      includeFlagged: true,
    });
    const h = included.find((r) => r.name === `HULDA QUX ${RUN}`)!;
    expect(h).toBeDefined(); // display name is the split name, not the fused blob
    expect(h.flags).toContain("address_in_name");
    expect(h.flags).toContain("likely_individual");
  });

  it("targets = relevant + unworked; worked and blocked orgs never appear", async () => {
    const targets = await relationshipTargets(db, accountId, { minRelevantProjects: 2 });
    const names = targets.map((t) => t.name);
    expect(names).toContain(`TRIAGE BUILDERS LLC ${RUN}`);
    expect(names).not.toContain(`KNOWN GC INC ${RUN}`); // active relationship
    expect(names).not.toContain(`BLOCKED CONTRACTORS CORP ${RUN}`); // suppressed (§9)
  });
});
