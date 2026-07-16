/**
 * M3.6 — idempotent weekly digest (spec §18): gate-passing items only,
 * exclusive section assignment, suppression disclosed in the coverage
 * section, delivery idempotency per (account, week), Mailpit send, and the
 * "never label an unchanged repeated project as new" rule.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type pg from "pg";
import {
  accountProfiles,
  coverageEntries,
  evidenceItems,
  opportunities,
  projectEvents,
  projects,
  rawArtifacts,
  sourceRecords,
  sourceRuns,
  type Db,
} from "@otn/db";
import { MockProvider, extractProject, verifyProject } from "@otn/intelligence";
import {
  buildDigest,
  deliverDigest,
  deliveryQualityMetrics,
  renderDigestHtml,
  weeklyIdempotencyKey,
} from "@otn/delivery";
import { deleteTestProjects, resetSource, testDb } from "./helpers.js";

const RUN = randomUUID().slice(0, 8).toUpperCase();
const BUDGET = { monthlyCapUsd: 100, perJobCapUsd: 0.5 };
const PERIOD_END = new Date();
const PERIOD_START = new Date(PERIOD_END.getTime() - 7 * 86_400_000);

let db: Db;
let pool: pg.Pool;
let sourceId: string;
let accountId: string;
let projectPassId: string;
let projectBlockedId: string;

async function seedProject(name: string, artifactId: string, withEvent: boolean) {
  const [project] = await db
    .insert(projects)
    .values({
      canonicalName: name,
      permittingJurisdiction: "Test Jurisdiction",
      county: "Thurston",
      currentStage: "permit_applied",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
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
      normalizedJson: { title: name },
      normalizedFingerprint: `digest-${name}`,
    })
    .returning({ id: sourceRecords.id });
  await db.execute(sql`
    INSERT INTO record_resolutions
      (source_record_id, project_id, resolver_version, matched_rule, features_json, score, decision, status)
    VALUES (${record!.id}, ${project!.id}, 'test', 'new_project', '{}', 1, 'auto', 'active')`);
  if (withEvent) {
    await db.insert(projectEvents).values({
      projectId: project!.id,
      sourceRecordId: record!.id,
      eventType: "permit_application",
      eventDate: new Date(PERIOD_END.getTime() - 2 * 86_400_000),
      observedAt: new Date(PERIOD_END.getTime() - 2 * 86_400_000),
      resultingStage: "permit_applied",
      materialChange: true,
      confirmed: true,
      confidence: 1,
    });
  }
  const [ev] = await db
    .insert(evidenceItems)
    .values({
      sourceRecordId: record!.id,
      rawArtifactId: artifactId,
      factPath: "project.units",
      evidenceText: `${name}: tenant improvement of 42 suites.`,
      pageOrSection: "description",
      sourceUrl: `https://example.invalid/digest-test/${name}`,
      authorityGrade: "A",
      parserVersion: "test",
    })
    .returning({ id: evidenceItems.id });
  return { projectId: project!.id, evidenceId: ev!.id };
}

beforeAll(async () => {
  ({ db, pool } = await testDb());
  sourceId = await resetSource(db, "fake_source");
  await db
    .update(coverageEntries)
    .set({ freshnessState: "green" })
    .where(eq(coverageEntries.sourceId, sourceId));

  const [run] = await db
    .insert(sourceRuns)
    .values({ sourceId, status: "succeeded" })
    .returning({ id: sourceRuns.id });
  const [artifact] = await db
    .insert(rawArtifacts)
    .values({
      sourceId,
      sourceRunId: run!.id,
      canonicalUrl: `https://example.invalid/digest-test/${RUN}`,
      retrievedAt: new Date(),
      contentType: "application/json",
      httpStatus: 200,
      storageKey: `raw/fake_source/digest-test-${RUN}`,
      sha256: RUN.padEnd(64, "2").toLowerCase(),
      byteSize: 2,
      headersJson: {},
      parserVersion: "test",
    })
    .returning({ id: rawArtifacts.id });

  // Dedicated test account so delivery history never touches pilot accounts.
  const [account] = await db
    .insert(accountProfiles)
    .values({
      key: `test_digest_${RUN.toLowerCase()}`,
      name: `Digest Test ${RUN}`,
      active: true,
      capabilitiesJson: [],
      territoryJson: { counties_included: ["Thurston"] },
      deliveryConfigJson: { priority_review_min: 80, weekly_digest_min: 65 },
    })
    .returning({ id: accountProfiles.id });
  accountId = account!.id;

  // Project A: full pipeline — extraction + all-supported verification → gate pass.
  const a = await seedProject(`DIGEST-A-${RUN}`, artifact!.id, true);
  projectPassId = a.projectId;
  await db.insert(opportunities).values({
    accountProfileId: accountId,
    projectId: projectPassId,
    currentScore: 88,
    state: "priority_review",
    firstQualifiedAt: new Date(),
  });

  const extract = await extractProject(
    db,
    new MockProvider([
      {
        text: JSON.stringify({
          facts: [
            { path: "project.units", value: 42, evidenceId: a.evidenceId, confirmed: true, confidence: 0.98 },
          ],
          inferences: [
            {
              type: "trade_fit",
              value: "interior_plausible",
              evidenceIds: [a.evidenceId],
              confidence: 0.7,
              reason: "TI without package detail.",
            },
          ],
          missingCriticalFacts: ["general_contractor"],
        }),
      },
    ]),
    projectPassId,
    { budget: BUDGET },
  );
  expect(extract.status).toBe("succeeded");
  const verify = await verifyProject(
    db,
    new MockProvider([
      {
        text: JSON.stringify({
          verdicts: [
            { path: "project.units", evidenceId: a.evidenceId, supported: true, reason: "stated" },
          ],
        }),
      },
    ]),
    projectPassId,
    { budget: BUDGET },
  );
  expect(verify.allSupported).toBe(true);

  // Project B: no extraction → blocked_on_verifier → suppressed, disclosed.
  const b = await seedProject(`DIGEST-B-${RUN}`, artifact!.id, true);
  projectBlockedId = b.projectId;
  await db.insert(opportunities).values({
    accountProfileId: accountId,
    projectId: projectBlockedId,
    currentScore: 70,
    state: "weekly_digest",
  });
});

afterAll(async () => {
  await db.execute(sql`
    DELETE FROM delivery_items WHERE delivery_id IN
      (SELECT id FROM deliveries WHERE account_profile_id = ${accountId})`);
  await db.execute(sql`DELETE FROM deliveries WHERE account_profile_id = ${accountId}`);
  await db.execute(sql`DELETE FROM opportunities WHERE account_profile_id = ${accountId}`);
  await deleteTestProjects(db, [projectPassId, projectBlockedId]);
  await db.execute(sql`DELETE FROM account_profiles WHERE id = ${accountId}`);
  await pool.end();
});

describe("M3.6 weekly digest", () => {
  it("includes only gate-passing items and discloses suppression", async () => {
    const model = await buildDigest(db, accountId, { start: PERIOD_START, end: PERIOD_END });
    expect(model.sections.priorityNew.map((i) => i.projectId)).toContain(projectPassId);
    const item = model.sections.priorityNew.find((i) => i.projectId === projectPassId)!;
    expect(item.isNew).toBe(true);
    expect(item.confirmedFacts.join(" ")).toContain("project.units");
    expect(item.inferences[0]).toContain("[inference]");
    expect(item.missingCriticalFacts).toContain("general_contractor");
    expect(item.sourceLinks.length).toBeGreaterThan(0);
    expect(item.whatChanged).toContain("permit_application");
    // Project B is withheld, and the withholding is disclosed, not silent.
    const allIds = [
      ...model.sections.priorityNew,
      ...model.sections.stageChanges,
      ...model.sections.missingFacts,
      ...model.sections.monitoring,
    ].map((i) => i.projectId);
    expect(allIds).not.toContain(projectBlockedId);
    expect(model.suppressed.blockedOnVerifier).toBeGreaterThanOrEqual(1);

    const html = renderDigestHtml(model);
    for (const heading of [
      "1. Priority new opportunities",
      "2. Material stage changes",
      "3. Missing-fact verification queue",
      "4. Monitoring",
      "5. Coverage &amp; source health",
    ]) {
      expect(html).toContain(heading);
    }
    expect(html).toContain("withheld pending independent verification");
  });

  it("delivery is idempotent per (account, week)", async () => {
    const model = await buildDigest(db, accountId, { start: PERIOD_START, end: PERIOD_END });
    const first = await deliverDigest(db, model);
    expect(first.created).toBe(true);
    expect(first.status).toBe("draft");
    expect(first.idempotencyKey).toBe(weeklyIdempotencyKey(model.accountKey, PERIOD_END));

    const second = await deliverDigest(db, model);
    expect(second.created).toBe(false);
    expect(second.deliveryId).toBe(first.deliveryId);

    const items = await db.execute(sql`
      SELECT count(*) AS n FROM delivery_items WHERE delivery_id = ${first.deliveryId}`);
    expect(Number((items.rows[0] as { n: string }).n)).toBe(1); // no duplicates
  });

  it("sends once via SMTP (Mailpit) and never re-sends", async () => {
    const model = await buildDigest(db, accountId, { start: PERIOD_START, end: PERIOD_END });
    const recipient = `digest-${RUN.toLowerCase()}@pilot.otn.local`;
    const sent = await deliverDigest(db, model, { send: true, recipient });
    expect(sent.status).toBe("sent");
    expect(sent.sent).toBe(true);

    const again = await deliverDigest(db, model, { send: true, recipient });
    expect(again.status).toBe("sent");
    expect(again.sent).toBe(false); // idempotent: already sent

    const res = await fetch(
      `http://localhost:8025/api/v1/search?query=to:${encodeURIComponent(recipient)}`,
    );
    const box = (await res.json()) as { messages_count: number };
    expect(box.messages_count).toBe(1);
  });

  it("never labels an unchanged repeated project as new", async () => {
    // Next week's digest, no new events in that period.
    const nextEnd = new Date(PERIOD_END.getTime() + 7 * 86_400_000);
    const model = await buildDigest(db, accountId, { start: PERIOD_END, end: nextEnd });
    const inPriorityNew = model.sections.priorityNew.some((i) => i.projectId === projectPassId);
    expect(inPriorityNew).toBe(false);
    const item = [
      ...model.sections.stageChanges,
      ...model.sections.missingFacts,
      ...model.sections.monitoring,
    ].find((i) => i.projectId === projectPassId)!;
    expect(item.isNew).toBe(false);
    expect(item.whatChanged).toBe("no change since your last digest");
  });

  it("M4.2: duplicate and expired rates are measured, not asserted", async () => {
    // Deliver next week's digest too (repeat item, correctly not-new).
    const nextEnd = new Date(PERIOD_END.getTime() + 7 * 86_400_000);
    const model = await buildDigest(db, accountId, { start: PERIOD_END, end: nextEnd });
    await deliverDigest(db, model);

    const clean = await deliveryQualityMetrics(db, { accountProfileId: accountId });
    expect(clean.deliveries).toBe(2);
    expect(clean.items).toBe(2);
    expect(clean.duplicateNewItems).toBe(0); // prevented by delivery history
    expect(clean.expiredItems).toBe(0); // prevented by the §15 timing check
    expect(clean.gates).toEqual({ duplicatePass: true, expiredPass: true });

    // The metric itself must detect violations: fabricate a delivery whose
    // metadata claims the same opportunity as "new" again.
    const model2 = await buildDigest(db, accountId, {
      start: nextEnd,
      end: new Date(nextEnd.getTime() + 7 * 86_400_000),
    });
    const items = [
      ...model2.sections.priorityNew,
      ...model2.sections.stageChanges,
      ...model2.sections.missingFacts,
      ...model2.sections.monitoring,
    ];
    await db.execute(sql`
      INSERT INTO deliveries
        (account_profile_id, delivery_type, period_start, period_end, status,
         idempotency_key, metadata_json)
      VALUES
        (${accountId}, 'weekly_digest', ${nextEnd.toISOString()},
         ${new Date(nextEnd.getTime() + 7 * 86_400_000).toISOString()}, 'draft',
         ${`test-dup-${RUN}`},
         ${JSON.stringify({
           items: items.map((i) => ({
             opportunityId: i.opportunityId,
             projectId: i.projectId,
             isNew: true, // deliberately wrong — the metric must catch this
             whatChanged: "fabricated",
           })),
         })})`);
    const dirty = await deliveryQualityMetrics(db, { accountProfileId: accountId });
    expect(dirty.duplicateNewItems).toBeGreaterThanOrEqual(1);
    expect(dirty.gates.duplicatePass).toBe(false); // 1/3 ≥ 3%
  });
});
