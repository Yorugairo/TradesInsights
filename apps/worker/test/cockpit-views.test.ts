/**
 * WS-3 Task 9 — insights_public cockpit contract views (migration 0025).
 * Proves the PII hard rules and account scoping AT THE VIEW LAYER, because the
 * registry cockpit reads these views with no further filtering:
 *   - cross-account isolation (account A never sees B's rows)
 *   - account-private sources never surface (grounding + valuation)
 *   - individual-flagged org names never surface as GC / league rows
 *   - verified registry-linked GC name+phone DOES surface
 *   - digest withheld counts are disclosed, never hidden
 *   - the reader role can read ONLY the views, never insights.* base tables
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import {
  accountProfiles,
  deliveries,
  opportunities,
  organizationContacts,
  organizations,
  projectRoles,
  projects,
  pursuits,
  rawArtifacts,
  sourceRecords,
  sourceRuns,
  sources,
  type Db,
} from "@otn/db";
import { deleteTestProjects, resetSource, testDb } from "./helpers.js";

const RUN = randomUUID().slice(0, 8).toLowerCase();
// Letters-only tag for ORG NAMES: the views' address-in-name guard rejects 3+
// consecutive digits, so a hex run id inside a fixture org name would trip it.
const ORG_TAG = RUN.replace(/[0-9]/g, (d) => "ghijklmnop".charAt(Number(d))).toUpperCase();

let db: Db;
let pool: pg.Pool;
let publicSourceId: string;
let privateSourceId: string;
let accountAId: string;
let accountBId: string;
const ACCOUNT_A = `test_ckpt_a_${RUN}`;
const ACCOUNT_B = `test_ckpt_b_${RUN}`;
let projectIds: string[] = [];
let recordIds: string[] = [];
let artifactIds: string[] = [];
let orgBuildersId: string;
let orgSmithId: string;
let oppAlphaId: string;

async function mkArtifact(sourceId: string, tag: string): Promise<string> {
  const [run] = await db
    .insert(sourceRuns)
    .values({ sourceId, status: "succeeded" })
    .returning({ id: sourceRuns.id });
  const [artifact] = await db
    .insert(rawArtifacts)
    .values({
      sourceId,
      sourceRunId: run!.id,
      canonicalUrl: `https://example.invalid/cockpit-views/${RUN}/${tag}`,
      retrievedAt: new Date(),
      contentType: "application/json",
      httpStatus: 200,
      storageKey: `raw/test/cockpit-views-${RUN}-${tag}`,
      sha256: `${tag}${RUN}`.padEnd(64, "c").slice(0, 64),
      byteSize: 2,
      headersJson: {},
      parserVersion: "test",
    })
    .returning({ id: rawArtifacts.id });
  artifactIds.push(artifact!.id);
  return artifact!.id;
}

async function mkProject(name: string): Promise<string> {
  const [project] = await db
    .insert(projects)
    .values({
      canonicalName: name,
      permittingJurisdiction: "Cockpit Test City",
      county: "Thurston",
      currentStage: "permit_applied",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    })
    .returning({ id: projects.id });
  projectIds.push(project!.id);
  return project!.id;
}

async function mkRecord(
  sourceId: string,
  artifactId: string,
  projectId: string,
  externalId: string,
  normalized: Record<string, unknown>,
): Promise<string> {
  const [record] = await db
    .insert(sourceRecords)
    .values({
      sourceId,
      rawArtifactId: artifactId,
      externalId,
      recordType: "permit",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      rawFieldsJson: {},
      normalizedJson: normalized,
      normalizedFingerprint: `cockpit-${RUN}-${externalId}`,
    })
    .returning({ id: sourceRecords.id });
  recordIds.push(record!.id);
  await db.execute(sql`
    INSERT INTO record_resolutions
      (source_record_id, project_id, resolver_version, matched_rule, features_json, score, decision, status)
    VALUES (${record!.id}, ${projectId}, 'test', 'new_project', '{}', 1, 'auto', 'active')`);
  return record!.id;
}

async function viewRows<T>(text: string, params: unknown[]): Promise<T[]> {
  const res = await pool.query(text, params as never[]);
  return res.rows as T[];
}

beforeAll(async () => {
  ({ db, pool } = await testDb());
  publicSourceId = await resetSource(db, "fake_source");

  const [accountA] = await db
    .insert(accountProfiles)
    .values({
      key: ACCOUNT_A,
      name: `Cockpit Test A ${RUN}`,
      active: true,
      capabilitiesJson: [],
      territoryJson: { counties_included: ["Thurston"] },
      deliveryConfigJson: { priority_review_min: 80, weekly_digest_min: 65 },
    })
    .returning({ id: accountProfiles.id });
  accountAId = accountA!.id;
  const [accountB] = await db
    .insert(accountProfiles)
    .values({
      key: ACCOUNT_B,
      name: `Cockpit Test B ${RUN}`,
      active: true,
      capabilitiesJson: [],
      territoryJson: { counties_included: ["Thurston"] },
      deliveryConfigJson: { priority_review_min: 80, weekly_digest_min: 65 },
    })
    .returning({ id: accountProfiles.id });
  accountBId = accountB!.id;

  // Account-private source (customer bid inbox class) owned by A.
  const [privateSource] = await db
    .insert(sources)
    .values({
      key: `test_cockpit_private_${RUN}`,
      name: "Cockpit Private Inbox",
      authority: "Customer-authorized (test)",
      priority: "P1",
      landingUrl: "https://private.invalid/cockpit-inbox",
      format: "json_export",
      accessClass: "private_authorized",
      cadence: "on_demand",
      enabled: false,
      accountProfileId: accountAId,
    })
    .returning({ id: sources.id });
  privateSourceId = privateSource!.id;

  const pubArtifact = await mkArtifact(publicSourceId, "pub");
  const privArtifact = await mkArtifact(privateSourceId, "priv");

  // P1 Alpha: public grounding + a PRIVATE record with a larger valuation that
  // must never surface. GC = entity-named, verified, global public phone.
  const alphaId = await mkProject(`Cockpit Alpha ${RUN}`);
  const alphaPubRecord = await mkRecord(publicSourceId, pubArtifact, alphaId, `alpha-pub-${RUN}`, {
    title: "Alpha",
    valuationUsd: 500000,
  });
  await mkRecord(privateSourceId, privArtifact, alphaId, `alpha-priv-${RUN}`, {
    title: "Alpha private",
    valuationUsd: 9999999,
  });

  // P2 Bravo: grounded ONLY in the private source — must never surface at all.
  const bravoId = await mkProject(`Cockpit Bravo ${RUN}`);
  await mkRecord(privateSourceId, privArtifact, bravoId, `bravo-priv-${RUN}`, {
    title: "Bravo",
  });

  // P3 Charlie: account B's opportunity (cross-account isolation probe).
  const charlieId = await mkProject(`Cockpit Charlie ${RUN}`);
  await mkRecord(publicSourceId, pubArtifact, charlieId, `charlie-pub-${RUN}`, {
    title: "Charlie",
  });

  // P4 Delta: only role-holder is an individual name — GC fields must be null.
  const deltaId = await mkProject(`Cockpit Delta ${RUN}`);
  const deltaRecord = await mkRecord(publicSourceId, pubArtifact, deltaId, `delta-pub-${RUN}`, {
    title: "Delta",
  });

  // P5 Echo: second project for the builders org (league ≥2-projects floor).
  const echoId = await mkProject(`Cockpit Echo ${RUN}`);
  const echoRecord = await mkRecord(publicSourceId, pubArtifact, echoId, `echo-pub-${RUN}`, {
    title: "Echo",
  });

  const [builders] = await db
    .insert(organizations)
    .values({ canonicalName: `COCKPIT ${ORG_TAG} BUILDERS LLC`, verifiedAt: new Date() })
    .returning({ id: organizations.id });
  orgBuildersId = builders!.id;
  const [smith] = await db
    .insert(organizations)
    .values({ canonicalName: "JOHN SMITH" })
    .returning({ id: organizations.id });
  orgSmithId = smith!.id;
  await db.insert(organizationContacts).values({
    organizationId: orgBuildersId,
    accountProfileId: null,
    name: "Main Office",
    phone: "+13605550123",
    sourceType: "public_business",
  });

  const now = new Date();
  await db.insert(projectRoles).values([
    // Alpha: strongest role is the verified business GC; the individual also
    // holds a weaker role and must lose the pick AND stay out of the league.
    { projectId: alphaId, organizationId: orgBuildersId, role: "primary_contractor", sourceRecordId: alphaPubRecord, confirmed: true, firstSeenAt: now, lastSeenAt: now },
    { projectId: alphaId, organizationId: orgSmithId, role: "contractor", sourceRecordId: alphaPubRecord, confirmed: true, firstSeenAt: now, lastSeenAt: now },
    // Delta: ONLY an individual on record — the view must surface no GC.
    { projectId: deltaId, organizationId: orgSmithId, role: "primary_contractor", sourceRecordId: deltaRecord, confirmed: true, firstSeenAt: now, lastSeenAt: now },
    // Echo: builders' second project (league floor).
    { projectId: echoId, organizationId: orgBuildersId, role: "applicant", sourceRecordId: echoRecord, confirmed: true, firstSeenAt: now, lastSeenAt: now },
  ]);

  const [oppAlpha] = await db
    .insert(opportunities)
    .values({ accountProfileId: accountAId, projectId: alphaId, state: "priority_review", currentScore: 88, lastMaterialChangeAt: now })
    .returning({ id: opportunities.id });
  oppAlphaId = oppAlpha!.id;
  await db.insert(opportunities).values([
    { accountProfileId: accountAId, projectId: bravoId, state: "promoted", currentScore: 75 },
    { accountProfileId: accountBId, projectId: charlieId, state: "priority_review", currentScore: 82 },
    { accountProfileId: accountAId, projectId: deltaId, state: "new", currentScore: 70 },
  ]);

  await db.insert(pursuits).values({
    accountProfileId: accountAId,
    opportunityId: oppAlphaId,
    state: "qualifying",
    ownerUserId: "test-user",
  });

  const periodEnd = now;
  const periodStart = new Date(now.getTime() - 7 * 86_400_000);
  const older = new Date(now.getTime() - 14 * 86_400_000);
  await db.insert(deliveries).values([
    {
      accountProfileId: accountAId,
      deliveryType: "weekly_digest",
      periodStart: older,
      periodEnd: new Date(now.getTime() - 8 * 86_400_000),
      status: "sent",
      sentAt: older,
      idempotencyKey: `cockpit-views-${RUN}-old`,
      metadataJson: { items: [{}], reviewQueue: [], suppressed: { gateFailed: 9, blockedOnVerifier: 9, customerSuppressed: 9 }, candidateCount: 1 },
    },
    {
      accountProfileId: accountAId,
      deliveryType: "weekly_digest",
      periodStart,
      periodEnd,
      status: "sent",
      sentAt: now,
      idempotencyKey: `cockpit-views-${RUN}-latest`,
      metadataJson: { items: [{}, {}], reviewQueue: [{}], suppressed: { gateFailed: 1, blockedOnVerifier: 2, customerSuppressed: 3 }, candidateCount: 9, easyWins: [oppAlphaId] },
    },
  ]);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM pursuits WHERE account_profile_id IN (${accountAId}, ${accountBId})`);
  await db.execute(sql`DELETE FROM deliveries WHERE account_profile_id IN (${accountAId}, ${accountBId})`);
  await db.execute(sql`DELETE FROM opportunities WHERE account_profile_id IN (${accountAId}, ${accountBId})`);
  await db.execute(sql`DELETE FROM organization_contacts WHERE organization_id IN (${orgBuildersId}, ${orgSmithId})`);
  await deleteTestProjects(db, projectIds);
  await db.execute(sql`DELETE FROM organizations WHERE id IN (${orgBuildersId}, ${orgSmithId})`);
  if (recordIds.length > 0) {
    await db.execute(sql`DELETE FROM source_records WHERE id IN ${sql.raw(`('${recordIds.join("','")}')`)}`);
  }
  if (artifactIds.length > 0) {
    await db.execute(sql`DELETE FROM raw_artifacts WHERE id IN ${sql.raw(`('${artifactIds.join("','")}')`)}`);
  }
  await db.execute(sql`DELETE FROM source_runs WHERE source_id = ${privateSourceId}`);
  await db.execute(sql`DELETE FROM sources WHERE id = ${privateSourceId}`);
  await db.execute(sql`DELETE FROM account_profiles WHERE id IN (${accountAId}, ${accountBId})`);
  await pool.end();
});

interface OppRow {
  opportunity_id: string;
  project_name: string;
  county: string;
  permitting_jurisdiction: string;
  max_valuation: number | null;
  gc_name: string | null;
  gc_verified: boolean | null;
  gc_phone: string | null;
}

describe("insights_public cockpit views (0025)", () => {
  it("scopes opportunities to the account and drops private-only projects", async () => {
    const aRows = await viewRows<OppRow>(
      "SELECT * FROM insights_public.cockpit_opportunities_v1 WHERE account_key = $1",
      [ACCOUNT_A],
    );
    const names = aRows.map((r) => r.project_name);
    expect(names).toContain(`Cockpit Alpha ${RUN}`);
    expect(names).toContain(`Cockpit Delta ${RUN}`);
    // Private-only grounding never surfaces; cross-account rows never surface.
    expect(names).not.toContain(`Cockpit Bravo ${RUN}`);
    expect(names).not.toContain(`Cockpit Charlie ${RUN}`);
    // county + jurisdiction present on every row (governance).
    for (const row of aRows) {
      expect(row.county).toBe("Thurston");
      expect(row.permitting_jurisdiction).toBeTruthy();
    }

    const bRows = await viewRows<OppRow>(
      "SELECT * FROM insights_public.cockpit_opportunities_v1 WHERE account_key = $1",
      [ACCOUNT_B],
    );
    expect(bRows.map((r) => r.project_name)).toEqual([`Cockpit Charlie ${RUN}`]);
  });

  it("never lets an account-private valuation raise the public number", async () => {
    const [alpha] = await viewRows<OppRow>(
      "SELECT * FROM insights_public.cockpit_opportunities_v1 WHERE account_key = $1 AND opportunity_id = $2",
      [ACCOUNT_A, oppAlphaId],
    );
    expect(alpha).toBeDefined();
    expect(Number(alpha!.max_valuation)).toBe(500000);
  });

  it("surfaces the verified business GC with its global public phone", async () => {
    const [alpha] = await viewRows<OppRow>(
      "SELECT * FROM insights_public.cockpit_opportunities_v1 WHERE account_key = $1 AND opportunity_id = $2",
      [ACCOUNT_A, oppAlphaId],
    );
    expect(alpha!.gc_name).toBe(`COCKPIT ${ORG_TAG} BUILDERS LLC`);
    expect(alpha!.gc_verified).toBe(true);
    expect(alpha!.gc_phone).toBe("+13605550123");
  });

  it("suppresses individual-flagged names from GC fields entirely", async () => {
    const [delta] = await viewRows<OppRow>(
      "SELECT * FROM insights_public.cockpit_opportunities_v1 WHERE account_key = $1 AND project_name = $2",
      [ACCOUNT_A, `Cockpit Delta ${RUN}`],
    );
    expect(delta).toBeDefined();
    expect(delta!.gc_name).toBeNull();
    expect(delta!.gc_phone).toBeNull();
  });

  it("flags easy wins from the latest digest's stored list (never re-derived)", async () => {
    const rows = await viewRows<OppRow & { is_easy_win: boolean }>(
      "SELECT opportunity_id, project_name, is_easy_win FROM insights_public.cockpit_opportunities_v1 WHERE account_key = $1",
      [ACCOUNT_A],
    );
    const alpha = rows.find((r) => r.opportunity_id === oppAlphaId);
    const delta = rows.find((r) => r.project_name === `Cockpit Delta ${RUN}`);
    // Alpha is the sole opportunity in the latest delivery's easyWins metadata.
    expect(alpha?.is_easy_win).toBe(true);
    // Delta shares the account + latest delivery but is NOT in the list.
    expect(delta?.is_easy_win).toBe(false);
  });

  it("discloses withheld digest counts from the LATEST delivery", async () => {
    const rows = await viewRows<Record<string, unknown>>(
      "SELECT * FROM insights_public.cockpit_digest_status_v1 WHERE account_key = $1",
      [ACCOUNT_A],
    );
    expect(rows).toHaveLength(1);
    const status = rows[0]!;
    expect(Number(status["item_count"])).toBe(2);
    expect(Number(status["review_queue_count"])).toBe(1);
    expect(Number(status["suppressed_gate_failed"])).toBe(1);
    expect(Number(status["suppressed_blocked_on_verifier"])).toBe(2);
    expect(Number(status["suppressed_customer"])).toBe(3);
    expect(Number(status["candidate_count"])).toBe(9);
  });

  it("keeps pursuits account-scoped", async () => {
    const aRows = await viewRows<Record<string, unknown>>(
      "SELECT * FROM insights_public.cockpit_pursuits_v1 WHERE account_key = $1",
      [ACCOUNT_A],
    );
    expect(aRows).toHaveLength(1);
    expect(aRows[0]!["state"]).toBe("qualifying");
    expect(aRows[0]!["project_name"]).toBe(`Cockpit Alpha ${RUN}`);
    const bRows = await viewRows<Record<string, unknown>>(
      "SELECT * FROM insights_public.cockpit_pursuits_v1 WHERE account_key = $1",
      [ACCOUNT_B],
    );
    expect(bRows).toHaveLength(0);
  });

  it("league lists business orgs only — individuals never appear", async () => {
    const rows = await viewRows<Record<string, unknown>>(
      "SELECT * FROM insights_public.cockpit_gc_league_v1 WHERE account_key = $1",
      [ACCOUNT_A],
    );
    const names = rows.map((r) => r["gc_name"]);
    expect(names).toContain(`COCKPIT ${ORG_TAG} BUILDERS LLC`);
    expect(names).not.toContain("JOHN SMITH");
    const builders = rows.find((r) => r["gc_name"] === `COCKPIT ${ORG_TAG} BUILDERS LLC`)!;
    expect(Number(builders["projects"])).toBeGreaterThanOrEqual(2);
    expect(builders["verified"]).toBe(true);
  });

  it("rolls up account band counts", async () => {
    const rows = await viewRows<Record<string, unknown>>(
      "SELECT * FROM insights_public.cockpit_account_v1 WHERE account_key = $1",
      [ACCOUNT_A],
    );
    expect(rows).toHaveLength(1);
    const account = rows[0]!;
    expect(Number(account["opportunities_priority"])).toBe(1);
    expect(Number(account["opportunities_promoted"])).toBe(1);
    expect(Number(account["opportunities_new"])).toBe(1);
    expect(Number(account["opportunities_active"])).toBe(3);
  });

  it("reader role sees the views and NOTHING under insights.*", async () => {
    const client = await pool.connect();
    try {
      await client.query("SET ROLE insights_cockpit_reader");
      const ok = await client.query(
        "SELECT count(*) FROM insights_public.cockpit_account_v1",
      );
      expect(Number(ok.rows[0].count)).toBeGreaterThanOrEqual(0);
      await expect(
        client.query("SELECT count(*) FROM insights.opportunities"),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await client.query("RESET ROLE");
      client.release();
    }
  });
});
