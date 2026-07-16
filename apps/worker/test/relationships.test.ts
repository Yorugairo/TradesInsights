/**
 * S4 (strengthening addendum §7) — GC relationship intelligence: relationship
 * state is account-specific (the same GC is "preferred" for one account and
 * "do_not_pursue" for another), public project roles stay distinct from
 * customer-supplied relationship state, and blocked/do_not_pursue suppress that
 * account's alerts.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { accountProfiles, organizations, projects, rawArtifacts, sourceRecords, sourceRuns, type Db } from "@otn/db";
import {
  addContact, getOrganizationView, isAlertSuppressed, setRelationship,
} from "@otn/intelligence";
import { deleteTestProjects, resetSource, testDb } from "./helpers.js";

const RUN = randomUUID().slice(0, 8).toUpperCase();
let db: Db;
let pool: pg.Pool;
let accountA: string;
let accountB: string;
let orgId: string;
let projectId: string;

beforeAll(async () => {
  ({ db, pool } = await testDb());
  const mk = async (key: string) => {
    const [a] = await db.insert(accountProfiles).values({
      key, name: key, active: true, capabilitiesJson: [], territoryJson: {}, deliveryConfigJson: {},
    }).returning({ id: accountProfiles.id });
    return a!.id;
  };
  accountA = await mk(`test_rel_a_${RUN.toLowerCase()}`);
  accountB = await mk(`test_rel_b_${RUN.toLowerCase()}`);

  const [org] = await db.insert(organizations).values({
    canonicalName: `ACME GC ${RUN} LLC`, status: "active", verifiedAt: new Date(),
  }).returning({ id: organizations.id });
  orgId = org!.id;

  const [p] = await db.insert(projects).values({
    canonicalName: `REL-${RUN}`, permittingJurisdiction: "Test Jurisdiction", county: "Thurston",
    currentStage: "permit_applied", firstSeenAt: new Date(), lastSeenAt: new Date(),
  }).returning({ id: projects.id });
  projectId = p!.id;

  const sourceId = await resetSource(db, "fake_source");
  const [run] = await db.insert(sourceRuns).values({ sourceId, status: "succeeded" }).returning({ id: sourceRuns.id });
  const [art] = await db.insert(rawArtifacts).values({
    sourceId, sourceRunId: run!.id, canonicalUrl: `https://example.invalid/rel/${RUN}`,
    retrievedAt: new Date(), contentType: "text/html", httpStatus: 200,
    storageKey: `raw/fake_source/rel-${RUN}`, sha256: RUN.padEnd(64, "7").toLowerCase(), byteSize: 7,
    headersJson: {}, parserVersion: "test",
  }).returning({ id: rawArtifacts.id });
  const [rec] = await db.insert(sourceRecords).values({
    sourceId, rawArtifactId: art!.id, externalId: `REL-${RUN}`, recordType: "permit",
    firstSeenAt: new Date(), lastSeenAt: new Date(), rawFieldsJson: {},
    normalizedJson: { title: `REL-${RUN}` }, normalizedFingerprint: `rel-${RUN}`,
  }).returning({ id: sourceRecords.id });
  // A PUBLIC project role (shared graph) — same for every account.
  await db.execute(sql`
    INSERT INTO project_roles (project_id, organization_id, role, source_record_id, confirmed, confidence, first_seen_at, last_seen_at)
    VALUES (${projectId}, ${orgId}, 'primary_contractor', ${rec!.id}, true, 1, now(), now())`);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM relationship_interactions WHERE relationship_id IN (SELECT id FROM account_organization_relationships WHERE organization_id = ${orgId})`);
  await db.execute(sql`DELETE FROM account_organization_relationships WHERE organization_id = ${orgId}`);
  await db.execute(sql`DELETE FROM organization_contacts WHERE organization_id = ${orgId}`);
  await db.execute(sql`DELETE FROM project_roles WHERE organization_id = ${orgId}`);
  await deleteTestProjects(db, [projectId]);
  await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}`);
  await db.execute(sql`DELETE FROM account_profiles WHERE id IN (${accountA}, ${accountB})`);
  await pool.end();
});

describe("S4 GC relationships", () => {
  it("relationship state is account-specific for the same GC", async () => {
    await setRelationship(db, { accountProfileId: accountA, organizationId: orgId, relationshipState: "preferred", preferred: true, ownerUserId: "alice" });
    await setRelationship(db, { accountProfileId: accountB, organizationId: orgId, relationshipState: "do_not_pursue", blocked: true });

    const viewA = (await getOrganizationView(db, orgId, accountA))!;
    const viewB = (await getOrganizationView(db, orgId, accountB))!;
    expect(viewA.relationship?.relationshipState).toBe("preferred");
    expect(viewB.relationship?.relationshipState).toBe("do_not_pursue");
    // Public roles are shared (same for both accounts) and stay distinct from state.
    expect(viewA.publicRoles.some((r) => r.projectId === projectId && r.role === "primary_contractor")).toBe(true);
    expect(viewB.publicRoles.length).toBe(viewA.publicRoles.length);
  });

  it("blocked / do_not_pursue suppress that account's alerts (only)", async () => {
    expect(await isAlertSuppressed(db, accountA, orgId)).toBe(false); // preferred
    expect(await isAlertSuppressed(db, accountB, orgId)).toBe(true); // do_not_pursue + blocked
  });

  it("keeps public and customer-supplied contacts distinct by provenance", async () => {
    await addContact(db, { organizationId: orgId, accountProfileId: accountA, name: "Public Listing", sourceType: "public_business" });
    await addContact(db, { organizationId: orgId, accountProfileId: accountA, name: "Dana Lee", role: "estimator", email: "dana@acme.example", sourceType: "customer_supplied", customerVerified: true });
    const view = (await getOrganizationView(db, orgId, accountA))!;
    const verified = view.contacts.find((c) => c.customerVerified);
    const publicOnly = view.contacts.find((c) => c.sourceType === "public_business");
    expect(verified?.name).toBe("Dana Lee");
    expect(publicOnly?.customerVerified).toBe(false);
    // Account B never sees account A's contacts.
    const viewB = (await getOrganizationView(db, orgId, accountB))!;
    expect(viewB.contacts).toHaveLength(0);
  });
});
