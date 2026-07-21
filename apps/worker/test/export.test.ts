/**
 * WS-D — CRM export (exportPursuits): DB-backed selection, ACCOUNT ISOLATION,
 * and outbound-webhook governance.
 *
 * Proves: (1) only ACTIONABLE opportunities export (priority_review/promoted, or
 * an OPEN pursuit) — monitoring-only and closed-pursuit rows are excluded; (2) one
 * account's export NEVER contains another account's rows (both directions); (3)
 * the webhook POST goes ONLY to the caller-supplied url and carries ONLY the
 * caller account's rows; (4) a non-2xx webhook yields webhookStatus "failed"
 * without throwing; (5) no webhook url ⇒ "skipped" with the CSV still produced.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import type pg from "pg";
import {
  accountProfiles, coverageEntries, evidenceItems, opportunities, organizations,
  projects, rawArtifacts, sourceRecords, sourceRuns, type Db,
} from "@otn/db";
import { exportPursuits } from "@otn/delivery";
import { deleteTestProjects, resetSource, testDb } from "./helpers.js";

const RUN = randomUUID().slice(0, 8).toUpperCase();
const A = `EXPA-${RUN}`;
const B = `EXPB-${RUN}`;

let db: Db;
let pool: pg.Pool;
let sourceId: string;
let artifactId: string;
let accountA: string;
let accountB: string;
let gcOrgId: string;
const projectIds: string[] = [];
const recordIds: string[] = [];
const accountIds: string[] = [];

async function seedProjectRecord(
  name: string,
  opts: { stage?: string; valuation?: number; issueDate?: string; sourceUrl?: string } = {},
): Promise<{ projectId: string; recordId: string }> {
  const [p] = await db.insert(projects).values({
    canonicalName: name, permittingJurisdiction: `City ${RUN}`, county: "Thurston",
    currentStage: opts.stage ?? "permit_issued", firstSeenAt: new Date(), lastSeenAt: new Date(),
  }).returning({ id: projects.id });
  projectIds.push(p!.id);
  const [rec] = await db.insert(sourceRecords).values({
    sourceId, rawArtifactId: artifactId, externalId: name, recordType: "permit",
    firstSeenAt: new Date(), lastSeenAt: new Date(), rawFieldsJson: {},
    normalizedJson: {
      title: name,
      description: "tenant improvement drywall and paint",
      ...(opts.valuation !== undefined ? { valuationUsd: opts.valuation } : {}),
      ...(opts.issueDate ? { issueDate: opts.issueDate } : {}),
    },
    normalizedFingerprint: `fp-${name}`,
  }).returning({ id: sourceRecords.id });
  recordIds.push(rec!.id);
  await db.execute(sql`
    INSERT INTO record_resolutions (source_record_id, project_id, resolver_version, matched_rule, features_json, score, decision, status)
    VALUES (${rec!.id}, ${p!.id}, 'test', 'new_project', '{}', 1, 'auto', 'active')`);
  if (opts.sourceUrl) {
    await db.insert(evidenceItems).values({
      sourceRecordId: rec!.id, rawArtifactId: artifactId, factPath: "project.stage",
      evidenceText: "Permit issued.", pageOrSection: "desc",
      sourceUrl: opts.sourceUrl, authorityGrade: "A", parserVersion: "test",
    });
  }
  return { projectId: p!.id, recordId: rec!.id };
}

async function seedOpp(accountId: string, projectId: string, state: string, score: number): Promise<string> {
  const [o] = await db.insert(opportunities).values({
    accountProfileId: accountId, projectId, currentScore: score, route: "interior_trades", state,
  }).returning({ id: opportunities.id });
  return o!.id;
}

/** Seed a pursuit directly at an arbitrary state (bypasses the transition machine
 * — this is fixture setup, not a behavior under test). */
async function seedPursuit(accountId: string, oppId: string, state: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO pursuits (account_profile_id, opportunity_id, state, owner_user_id)
    VALUES (${accountId}, ${oppId}, ${state}, 'tester')`);
}

beforeAll(async () => {
  ({ db, pool } = await testDb());
  sourceId = await resetSource(db, "fake_source");
  await db.update(coverageEntries).set({ freshnessState: "green" }).where(eq(coverageEntries.sourceId, sourceId));
  const [run] = await db.insert(sourceRuns).values({ sourceId, status: "succeeded" }).returning({ id: sourceRuns.id });
  const [art] = await db.insert(rawArtifacts).values({
    sourceId, sourceRunId: run!.id, canonicalUrl: `https://example.invalid/export/${RUN}`,
    retrievedAt: new Date(), contentType: "text/html", httpStatus: 200,
    storageKey: `raw/fake_source/export-${RUN}`, sha256: RUN.padEnd(64, "7").toLowerCase(), byteSize: 5,
    headersJson: {}, parserVersion: "test",
  }).returning({ id: rawArtifacts.id });
  artifactId = art!.id;

  for (const [key, name] of [["a", `Account A ${RUN}`], ["b", `Account B ${RUN}`]] as const) {
    const [acct] = await db.insert(accountProfiles).values({
      key: `test_export_${key}_${RUN.toLowerCase()}`, name, active: true,
      capabilitiesJson: [], territoryJson: {}, deliveryConfigJson: {},
    }).returning({ id: accountProfiles.id });
    accountIds.push(acct!.id);
    if (key === "a") accountA = acct!.id;
    else accountB = acct!.id;
  }

  // ── Account A: 3 actionable + 2 excluded ──
  const pa1 = await seedProjectRecord(`${A}-priority`, { valuation: 250_000, issueDate: "2026-07-01", sourceUrl: `https://permits.example.gov/${A}-priority` });
  const oa1 = await seedOpp(accountA, pa1.projectId, "priority_review", 88);
  // Verified GC on the priority project (proves the reused digest loader surfaces
  // name + verified flag + global public-business phone).
  const [gc] = await db.insert(organizations).values({
    canonicalName: `ACME BUILDERS ${RUN}`, verifiedAt: new Date(),
  }).returning({ id: organizations.id });
  gcOrgId = gc!.id;
  await db.execute(sql`
    INSERT INTO project_roles (project_id, organization_id, role, source_record_id, confirmed, first_seen_at, last_seen_at)
    VALUES (${pa1.projectId}, ${gcOrgId}, 'primary_contractor', ${pa1.recordId}, true, now(), now())`);
  await db.execute(sql`
    INSERT INTO organization_contacts (organization_id, account_profile_id, name, role, phone, source_type)
    VALUES (${gcOrgId}, NULL, ${`ACME BUILDERS ${RUN}`}, 'L&I registered phone', '+13605550123', 'public_business')`);
  void oa1;

  const pa2 = await seedProjectRecord(`${A}-digestopen`, { valuation: 120_000 });
  const oa2 = await seedOpp(accountA, pa2.projectId, "weekly_digest", 70);
  await seedPursuit(accountA, oa2, "qualified"); // OPEN pursuit → actionable

  const pa3 = await seedProjectRecord(`${A}-digestnone`, { valuation: 90_000 });
  await seedOpp(accountA, pa3.projectId, "weekly_digest", 66); // no pursuit → excluded

  const pa4 = await seedProjectRecord(`${A}-digestwon`, { valuation: 90_000 });
  const oa4 = await seedOpp(accountA, pa4.projectId, "weekly_digest", 66);
  await seedPursuit(accountA, oa4, "won"); // closed pursuit → excluded

  const pa5 = await seedProjectRecord(`${A}-promoted`, { valuation: 300_000 });
  await seedOpp(accountA, pa5.projectId, "promoted", 95); // promoted → actionable

  // ── Account B: 1 actionable (isolation control) ──
  const pb1 = await seedProjectRecord(`${B}-priority`, { valuation: 500_000 });
  await seedOpp(accountB, pb1.projectId, "priority_review", 80);
});

afterAll(async () => {
  for (const acc of accountIds) {
    await db.execute(sql`DELETE FROM pursuits WHERE account_profile_id = ${acc}`);
    await db.execute(sql`DELETE FROM opportunities WHERE account_profile_id = ${acc}`);
  }
  if (gcOrgId) await db.execute(sql`DELETE FROM organization_contacts WHERE organization_id = ${gcOrgId}`);
  if (recordIds.length > 0) {
    await db.delete(evidenceItems).where(inArray(evidenceItems.sourceRecordId, recordIds));
  }
  await deleteTestProjects(db, projectIds);
  if (recordIds.length > 0) {
    await db.delete(sourceRecords).where(inArray(sourceRecords.id, recordIds));
  }
  if (gcOrgId) await db.execute(sql`DELETE FROM organizations WHERE id = ${gcOrgId}`);
  for (const acc of accountIds) await db.execute(sql`DELETE FROM account_profiles WHERE id = ${acc}`);
  await pool.end();
});

function projectNames(payloadOpps: { project: string }[]): string[] {
  return payloadOpps.map((o) => o.project).sort();
}

describe("exportPursuits — actionable selection", () => {
  it("exports only priority_review/promoted or open-pursuit opportunities", async () => {
    const res = await exportPursuits(db, accountA, {});
    expect(res.exported).toBe(3);
    expect(projectNames(res.payload.opportunities)).toEqual(
      [`${A}-digestopen`, `${A}-priority`, `${A}-promoted`].sort(),
    );
    // The monitoring-only and closed-pursuit rows are absent.
    const names = res.payload.opportunities.map((o) => o.project);
    expect(names).not.toContain(`${A}-digestnone`);
    expect(names).not.toContain(`${A}-digestwon`);
  });

  it("surfaces the verified GC (name + verified flag + global phone) and source url", async () => {
    const res = await exportPursuits(db, accountA, {});
    const priority = res.payload.opportunities.find((o) => o.project === `${A}-priority`)!;
    expect(priority.gcName).toContain(`ACME BUILDERS ${RUN}`);
    expect(priority.gcVerified).toBe(true);
    expect(priority.gcPhone).toBe("+13605550123");
    expect(priority.amount).toBe(250_000);
    expect(priority.sourceUrl).toContain("permits.example.gov");
    // Bid-window inference is attached (deterministic overlay, never null).
    expect(priority.bidWindow).toBeTruthy();
  });
});

describe("exportPursuits — account isolation (governance #2)", () => {
  it("account A's export never contains account B's rows", async () => {
    const res = await exportPursuits(db, accountA, {});
    const csv = res.csv;
    expect(csv).toContain(`${A}-priority`);
    expect(csv).not.toContain(`${B}-priority`); // B is invisible to A
    for (const o of res.payload.opportunities) expect(o.project.startsWith(A)).toBe(true);
  });

  it("account B's export contains only B's row", async () => {
    const res = await exportPursuits(db, accountB, {});
    expect(res.exported).toBe(1);
    expect(res.payload.opportunities[0]!.project).toBe(`${B}-priority`);
    expect(res.csv).not.toContain(A);
  });
});

describe("exportPursuits — outbound webhook (governance #1/#3)", () => {
  it("POSTs ONLY to the configured url and carries ONLY the caller account's rows", async () => {
    const calls: { url: unknown; body: unknown }[] = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url, body: init?.body });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const WEBHOOK = "https://hooks.example.com/account-a";
    const res = await exportPursuits(db, accountA, { webhookUrl: WEBHOOK, fetchImpl });

    expect(res.webhookStatus).toBe("sent");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(WEBHOOK); // the account's own configured url ONLY
    const posted = JSON.parse(String(calls[0]!.body)) as { opportunities: { project: string }[] };
    expect(posted.opportunities.length).toBe(3);
    for (const o of posted.opportunities) expect(o.project.startsWith(A)).toBe(true); // no B rows cross the seam
  });

  it("returns webhookStatus 'failed' (no throw) on a non-2xx response; CSV still produced", async () => {
    const fetchImpl = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const res = await exportPursuits(db, accountA, { webhookUrl: "https://hooks.example.com/account-a", fetchImpl });
    expect(res.webhookStatus).toBe("failed");
    expect(res.webhookReason).toContain("500");
    expect(res.csv.split("\r\n").filter(Boolean).length).toBe(4); // header + 3 rows
  });

  it("no webhook url ⇒ webhookStatus 'skipped' with the CSV still produced", async () => {
    const res = await exportPursuits(db, accountA, {});
    expect(res.webhookStatus).toBe("skipped");
    expect(res.csv.split("\r\n")[0]).toContain("opportunity_id");
    expect(res.csv.split("\r\n").filter(Boolean).length).toBe(4);
  });
});
