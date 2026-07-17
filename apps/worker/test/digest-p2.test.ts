/**
 * P2 — the 10-minute digest: easy-win cut, top-block sections (winnable now /
 * GCs worth meeting / deadlines / radar), one-tap action tokens (single-use,
 * hashed, expiring), and deterministic outreach talking points.
 */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import {
  accountProfiles,
  opportunities,
  organizations,
  projectEvents,
  projects,
  rawArtifacts,
  sourceRecords,
  sourceRuns,
  type Db,
} from "@otn/db";
import { MockProvider, buildDecisionMemo, createPursuit, extractProject, verifyProject } from "@otn/intelligence";
import {
  buildDigest,
  consumeActionToken,
  deliverDigest,
  issueActionTokens,
  peekActionToken,
  renderDigestHtml,
} from "@otn/delivery";
import { deleteTestProjects, resetSource, testDb } from "./helpers.js";

const RUN = randomUUID().slice(0, 8).toUpperCase();
const BUDGET = { monthlyCapUsd: 100, perJobCapUsd: 0.5 };
const PERIOD_END = new Date();
const PERIOD_START = new Date(PERIOD_END.getTime() - 7 * 86_400_000);
// Lacey-ish home point; the easy-win project sits ~2 km away.
const HOME = { lon: -122.823, lat: 47.046 };

let db: Db;
let pool: pg.Pool;
let sourceId: string;
let artifactId: string;
let accountId: string;
let easyProjectId: string;
let easyOppId: string;
let farProjectId: string;
let orgId: string;

async function seedGateReadyProject(
  name: string,
  opts: { lon: number; lat: number; valuation: number; withOrg: boolean },
): Promise<{ projectId: string; opportunityId: string }> {
  const [project] = await db
    .insert(projects)
    .values({
      canonicalName: name,
      permittingJurisdiction: "Test Jurisdiction",
      county: "Thurston",
      currentStage: "permit_issued",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      geometry: sql`ST_SetSRID(ST_MakePoint(${opts.lon}, ${opts.lat}), 4326)` as never,
    })
    .returning({ id: projects.id });
  const [record] = await db
    .insert(sourceRecords)
    .values({
      sourceId,
      rawArtifactId: artifactId,
      externalId: name,
      recordType: "permit",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      rawFieldsJson: {},
      normalizedJson: { title: name, valuationUsd: opts.valuation, issueDate: "2026-07-01" },
      normalizedFingerprint: `p2-${name}`,
    })
    .returning({ id: sourceRecords.id });
  await db.execute(sql`
    INSERT INTO record_resolutions
      (source_record_id, project_id, resolver_version, matched_rule, features_json, score, decision, status)
    VALUES (${record!.id}, ${project!.id}, 'test', 'new_project', '{}', 1, 'auto', 'active')`);
  await db.insert(projectEvents).values({
    projectId: project!.id,
    sourceRecordId: record!.id,
    eventType: "permit_issued",
    eventDate: new Date(PERIOD_END.getTime() - 3 * 86_400_000),
    observedAt: new Date(PERIOD_END.getTime() - 3 * 86_400_000),
    resultingStage: "permit_issued",
    materialChange: true,
    confirmed: true,
    confidence: 1,
  });
  const evRows = await db.execute(sql`
    INSERT INTO evidence_items
      (source_record_id, raw_artifact_id, fact_path, evidence_text, page_or_section,
       source_url, authority_grade, parser_version)
    VALUES (${record!.id}, ${artifactId}, 'project.units',
      ${`${name}: interior buildout of 12 suites.`}, 'description',
      ${`https://example.invalid/p2/${name}`}, 'A', 'test')
    RETURNING id`);
  const ev = evRows.rows as { id: string }[];
  if (opts.withOrg) {
    await db.execute(sql`
      INSERT INTO project_roles
        (project_id, organization_id, role, source_record_id, confirmed, first_seen_at, last_seen_at)
      VALUES (${project!.id}, ${orgId}, 'applicant', ${record!.id}, true, now(), now())`);
  }
  const [opp] = await db
    .insert(opportunities)
    .values({
      accountProfileId: accountId,
      projectId: project!.id,
      currentScore: 88,
      state: "priority_review",
      firstQualifiedAt: new Date(),
      lastMaterialChangeAt: new Date(PERIOD_END.getTime() - 3 * 86_400_000),
    })
    .returning({ id: opportunities.id });

  // Full pipeline: extraction + all-supported verification → gate pass + auto.
  const extract = await extractProject(
    db,
    new MockProvider([
      {
        text: JSON.stringify({
          facts: [
            { path: "project.units", value: 12, evidenceId: ev[0]!.id, confirmed: true, confidence: 0.97 },
          ],
          inferences: [],
          missingCriticalFacts: [],
        }),
      },
    ]),
    project!.id,
    { budget: BUDGET },
  );
  expect(extract.status).toBe("succeeded");
  const verify = await verifyProject(
    db,
    new MockProvider([
      {
        text: JSON.stringify({
          verdicts: [
            { path: "project.units", evidenceId: ev[0]!.id, supported: true, reason: "stated" },
          ],
        }),
      },
    ]),
    project!.id,
    { budget: BUDGET },
  );
  expect(verify.allSupported).toBe(true);
  return { projectId: project!.id, opportunityId: opp!.id };
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
      canonicalUrl: `https://example.invalid/p2-test/${RUN}`,
      retrievedAt: new Date(),
      contentType: "application/json",
      httpStatus: 200,
      storageKey: `raw/fake_source/p2-test-${RUN}`,
      sha256: `b${RUN}`.padEnd(64, "1").toLowerCase(),
      byteSize: 2,
      headersJson: {},
      parserVersion: "test",
    })
    .returning({ id: rawArtifacts.id });
  artifactId = artifact!.id;

  const [org] = await db
    .insert(organizations)
    .values({ canonicalName: `P2 GENERAL CONTRACTORS LLC ${RUN}` })
    .returning({ id: organizations.id });
  orgId = org!.id;

  const [account] = await db
    .insert(accountProfiles)
    .values({
      key: `test_p2_${RUN.toLowerCase()}`,
      name: `P2 Test ${RUN}`,
      active: true,
      capabilitiesJson: [],
      territoryJson: { counties_included: ["Thurston"] },
      deliveryConfigJson: {
        priority_review_min: 80,
        weekly_digest_min: 65,
        easy_win: {
          home_lon: HOME.lon,
          home_lat: HOME.lat,
          radius_km: 60,
          max_age_days: 60,
          min_valuation_usd: 50_000,
          max_valuation_usd: 2_000_000,
        },
      },
    })
    .returning({ id: accountProfiles.id });
  accountId = account!.id;

  // Easy win: 2 km from home, $400k, GC on record, permit issued 3 days ago.
  const easy = await seedGateReadyProject(`P2-EASY-${RUN}`, {
    lon: HOME.lon + 0.02,
    lat: HOME.lat,
    valuation: 400_000,
    withOrg: true,
  });
  easyProjectId = easy.projectId;
  easyOppId = easy.opportunityId;
  // Same profile but ~200 km away → NOT an easy win (radius fails).
  const far = await seedGateReadyProject(`P2-FAR-${RUN}`, {
    lon: HOME.lon + 2.5,
    lat: HOME.lat + 1.2,
    valuation: 400_000,
    withOrg: true,
  });
  farProjectId = far.projectId;

  // A future bid-invitation deadline in the account's private inbox.
  await db.execute(sql`
    INSERT INTO bid_invitations
      (account_profile_id, gc_organization_id, invitation_status, bid_due_at, scope_summary, match_status)
    VALUES (${accountId}, ${orgId}, 'invited',
      ${new Date(PERIOD_END.getTime() + 5 * 86_400_000).toISOString()},
      'Drywall + paint, Building C', 'review')`);
});

afterAll(async () => {
  await db.execute(sql`
    DELETE FROM action_tokens WHERE account_profile_id = ${accountId}`);
  await db.execute(sql`
    DELETE FROM delivery_items WHERE delivery_id IN
      (SELECT id FROM deliveries WHERE account_profile_id = ${accountId})`);
  await db.execute(sql`DELETE FROM deliveries WHERE account_profile_id = ${accountId}`);
  await db.execute(sql`DELETE FROM bid_invitations WHERE account_profile_id = ${accountId}`);
  await db.execute(sql`
    DELETE FROM pursuit_transitions WHERE pursuit_id IN
      (SELECT id FROM pursuits WHERE account_profile_id = ${accountId})`);
  await db.execute(sql`DELETE FROM pursuits WHERE account_profile_id = ${accountId}`);
  await db.execute(sql`DELETE FROM opportunities WHERE account_profile_id = ${accountId}`);
  await deleteTestProjects(db, [easyProjectId, farProjectId]);
  await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}`);
  await db.execute(sql`DELETE FROM account_profiles WHERE id = ${accountId}`);
  await pool.end();
});

describe("P2 — easy-win cut and top block", () => {
  it("flags only in-radius, right-stage, org-known, in-band items as winnable", async () => {
    const model = await buildDigest(db, accountId, { start: PERIOD_START, end: PERIOD_END });
    const winIds = model.easyWins.map((i) => i.projectId);
    expect(winIds).toContain(easyProjectId);
    expect(winIds).not.toContain(farProjectId); // outside the service radius

    expect(model.deadlines.length).toBe(1);
    expect(model.deadlines[0]!.scope).toContain("Drywall");

    const html = renderDigestHtml(model);
    expect(html).toContain("Winnable now");
    expect(html).toContain("Deadlines from your inbox");
    // The §18 sections are still present in full (spec-compliant, audited).
    expect(html).toContain("1. Priority new opportunities");
  });

  it("caps easy wins at 3", async () => {
    const model = await buildDigest(db, accountId, { start: PERIOD_START, end: PERIOD_END });
    expect(model.easyWins.length).toBeLessThanOrEqual(3);
  });
});

describe("P2 — one-tap action tokens", () => {
  it("delivery embeds action links; tokens are single-use and hashed", async () => {
    const model = await buildDigest(db, accountId, { start: PERIOD_START, end: PERIOD_END });
    const delivery = await deliverDigest(db, model, { actionBaseUrl: "https://app.otn.test" });
    expect(delivery.created).toBe(true);

    const stored = await db.execute(
      sql`SELECT rendered_content FROM deliveries WHERE id = ${delivery.deliveryId}`,
    );
    const html = (stored.rows[0] as { rendered_content: string }).rendered_content;
    expect(html).toContain("https://app.otn.test/api/action?t=");

    // Raw tokens never land in the DB — only hashes.
    const raw = /api\/action\?t=([A-Za-z0-9_-]+)/.exec(html)![1]!;
    const inDb = await db.execute(
      sql`SELECT 1 FROM action_tokens WHERE token_hash = ${raw}`,
    );
    expect(inDb.rows.length).toBe(0);

    // Peek (the GET confirmation page) is safe and replayable — a mail
    // scanner prefetching the link consumes nothing.
    const peek1 = await peekActionToken(db, raw);
    const peek2 = await peekActionToken(db, raw);
    expect(peek1.ok).toBe(true);
    expect(peek2.ok).toBe(true);

    const first = await consumeActionToken(db, raw);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.accountProfileId).toBe(accountId);
      expect(["pursue", "dismiss"]).toContain(first.action);
    }
    const second = await consumeActionToken(db, raw);
    expect(second).toEqual({ ok: false, reason: "already_used" });
  });

  it("rejects garbage and expired tokens without leaking anything", async () => {
    expect(await consumeActionToken(db, "not-a-token")).toEqual({ ok: false, reason: "invalid" });
    const links = await issueActionTokens(db, {
      accountProfileId: accountId,
      deliveryId: (
        (await db.execute(sql`SELECT id FROM deliveries WHERE account_profile_id = ${accountId} LIMIT 1`))
          .rows[0] as { id: string }
      ).id,
      opportunityIds: [easyOppId],
      baseUrl: "https://app.otn.test",
      ttlDays: 14,
    });
    const raw = /t=([A-Za-z0-9_-]+)/.exec(links.get(easyOppId)!.pursue)![1]!;
    const hash = createHash("sha256").update(raw).digest("hex");
    await db.execute(sql`
      UPDATE action_tokens SET expires_at = now() - interval '1 hour'
      WHERE token_hash = ${hash}`);
    expect(await consumeActionToken(db, raw)).toEqual({ ok: false, reason: "expired" });
  });

  it("a consumed pursue token creates exactly one audited pursuit", async () => {
    const del = (
      (await db.execute(sql`SELECT id FROM deliveries WHERE account_profile_id = ${accountId} LIMIT 1`))
        .rows[0] as { id: string }
    ).id;
    const links = await issueActionTokens(db, {
      accountProfileId: accountId,
      deliveryId: del,
      opportunityIds: [easyOppId],
      baseUrl: "https://app.otn.test",
    });
    const raw = /t=([A-Za-z0-9_-]+)/.exec(links.get(easyOppId)!.pursue)![1]!;
    const consumed = await consumeActionToken(db, raw);
    expect(consumed.ok).toBe(true);
    if (consumed.ok) {
      await createPursuit(db, {
        accountProfileId: consumed.accountProfileId,
        opportunityId: consumed.opportunityId,
        ownerUserId: "email-one-tap",
      });
    }
    const pursuits = await db.execute(sql`
      SELECT actor_id FROM pursuit_transitions pt
      JOIN pursuits p ON p.id = pt.pursuit_id
      WHERE p.account_profile_id = ${accountId} AND p.opportunity_id = ${easyOppId}`);
    expect(pursuits.rows.length).toBe(1);
    expect((pursuits.rows[0] as { actor_id: string }).actor_id).toBe("email-one-tap");
  });
});

describe("P2 — outreach talking points (evidence-only)", () => {
  it("memo carries deterministic bullets: roles, stage/dates, valuation", async () => {
    const memo = await buildDecisionMemo(db, easyOppId);
    expect(memo).toBeTruthy();
    const joined = memo!.talkingPoints.join(" | ");
    expect(joined).toContain(`P2 GENERAL CONTRACTORS LLC ${RUN}`);
    expect(joined).toContain("applicant");
    expect(joined).toContain("permit issued 2026-07-01");
    expect(joined).toContain("$400,000");
  });
});
