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
let projectReviewId: string;
let oppReviewId: string;
let projectDiscrepancyId: string;
let accountDiscId: string;

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
          missingCriticalFacts: [],
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

  // Project C: fully verified but with a missing critical fact → gate passes,
  // controlled automation withholds it for a human (M4.3).
  const c = await seedProject(`DIGEST-C-${RUN}`, artifact!.id, true);
  projectReviewId = c.projectId;
  const [oppC] = await db
    .insert(opportunities)
    .values({
      accountProfileId: accountId,
      projectId: projectReviewId,
      currentScore: 82,
      state: "priority_review",
      firstQualifiedAt: new Date(),
    })
    .returning({ id: opportunities.id });
  oppReviewId = oppC!.id;
  const extractC = await extractProject(
    db,
    new MockProvider([
      {
        text: JSON.stringify({
          facts: [
            { path: "project.units", value: 12, evidenceId: c.evidenceId, confirmed: true, confidence: 0.95 },
          ],
          inferences: [],
          missingCriticalFacts: ["general_contractor"],
        }),
      },
    ]),
    projectReviewId,
    { budget: BUDGET },
  );
  expect(extractC.status).toBe("succeeded");
  const verifyC = await verifyProject(
    db,
    new MockProvider([
      {
        text: JSON.stringify({
          verdicts: [
            { path: "project.units", evidenceId: c.evidenceId, supported: true, reason: "stated" },
          ],
        }),
      },
    ]),
    projectReviewId,
    { budget: BUDGET },
  );
  expect(verifyC.allSupported).toBe(true);

  // Project D: two active records that DISAGREE on unit count (the M3.8 41st Ave
  // case, 198 vs 180). Gate passes (attribute disagreement is not an identity
  // contradiction); the brief must show both counts with citations, never one.
  // Isolated under its own account so it never perturbs the delivery-count
  // assertions of the M3.6/M4.2 tests above.
  const [discAccount] = await db
    .insert(accountProfiles)
    .values({
      key: `test_disc_${RUN.toLowerCase()}`,
      name: `Disc Test ${RUN}`,
      active: true,
      capabilitiesJson: [],
      territoryJson: { counties_included: ["Thurston"] },
      deliveryConfigJson: { priority_review_min: 80, weekly_digest_min: 65 },
    })
    .returning({ id: accountProfiles.id });
  accountDiscId = discAccount!.id;
  const d = await seedProject(`DIGEST-D-${RUN}`, artifact!.id, true);
  projectDiscrepancyId = d.projectId;
  await db.execute(sql`
    UPDATE source_records
       SET normalized_json = normalized_json ||
         ${JSON.stringify({ units: 198, sourceUrl: "https://example.invalid/king-notice" })}::jsonb
     WHERE external_id = ${`DIGEST-D-${RUN}`} AND source_id = ${sourceId}`);
  const [recD2] = await db
    .insert(sourceRecords)
    .values({
      sourceId,
      rawArtifactId: artifact!.id,
      externalId: `DIGEST-D2-${RUN}`,
      recordType: "permit",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      rawFieldsJson: {},
      normalizedJson: {
        title: `DIGEST-D-${RUN}`,
        units: 180,
        sourceUrl: "https://example.invalid/seattle-mup",
      },
      normalizedFingerprint: `digest-D2-${RUN}`,
    })
    .returning({ id: sourceRecords.id });
  await db.execute(sql`
    INSERT INTO record_resolutions
      (source_record_id, project_id, resolver_version, matched_rule, features_json, score, decision, status)
    VALUES (${recD2!.id}, ${projectDiscrepancyId}, 'test', 'address_name', '{}', 0.9, 'auto', 'active')`);
  // Every active record must carry evidence (gate: facts_evidenced).
  await db.insert(evidenceItems).values({
    sourceRecordId: recD2!.id,
    rawArtifactId: artifact!.id,
    factPath: "project.units",
    evidenceText: `DIGEST-D-${RUN}: 180 dwelling units.`,
    pageOrSection: "description",
    sourceUrl: "https://example.invalid/seattle-mup",
    authorityGrade: "A",
    parserVersion: "test",
  });
  await db.insert(opportunities).values({
    accountProfileId: accountDiscId,
    projectId: projectDiscrepancyId,
    currentScore: 86,
    state: "priority_review",
    firstQualifiedAt: new Date(),
  });
  const extractD = await extractProject(
    db,
    new MockProvider([
      {
        text: JSON.stringify({
          facts: [
            { path: "project.units", value: 198, evidenceId: d.evidenceId, confirmed: true, confidence: 0.95 },
          ],
          inferences: [],
          missingCriticalFacts: [],
        }),
      },
    ]),
    projectDiscrepancyId,
    { budget: BUDGET },
  );
  expect(extractD.status).toBe("succeeded");
  const verifyD = await verifyProject(
    db,
    new MockProvider([
      {
        text: JSON.stringify({
          verdicts: [
            { path: "project.units", evidenceId: d.evidenceId, supported: true, reason: "stated" },
          ],
        }),
      },
    ]),
    projectDiscrepancyId,
    { budget: BUDGET },
  );
  expect(verifyD.allSupported).toBe(true);
});

afterAll(async () => {
  await db.execute(sql`
    DELETE FROM delivery_items WHERE delivery_id IN
      (SELECT id FROM deliveries WHERE account_profile_id = ${accountId})`);
  await db.execute(sql`DELETE FROM deliveries WHERE account_profile_id = ${accountId}`);
  await db.execute(
    sql`DELETE FROM opportunities WHERE account_profile_id IN (${accountId}, ${accountDiscId})`,
  );
  await deleteTestProjects(db, [
    projectPassId,
    projectBlockedId,
    projectReviewId,
    projectDiscrepancyId,
  ]);
  await db.execute(
    sql`DELETE FROM account_profiles WHERE id IN (${accountId}, ${accountDiscId})`,
  );
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
    expect(item.inclusion.mode).toBe("auto"); // verified, high-confidence, complete
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

  it("M4.3: withholds verified items with missing critical facts for human review", async () => {
    const model = await buildDigest(db, accountId, { start: PERIOD_START, end: PERIOD_END });
    const held = model.reviewQueue.find((i) => i.projectId === projectReviewId);
    expect(held).toBeTruthy();
    expect(held!.inclusion.mode).toBe("review_required");
    expect(held!.inclusion.reasons).toContain("missing_critical_facts");
    // Not in any customer section, but disclosed in the caveat section.
    const sectionIds = [
      ...model.sections.priorityNew,
      ...model.sections.stageChanges,
      ...model.sections.missingFacts,
      ...model.sections.monitoring,
    ].map((i) => i.projectId);
    expect(sectionIds).not.toContain(projectReviewId);
    expect(renderDigestHtml(model)).toContain("held for human review");
  });

  it("M3.8: shows every unit count with its citation when sources disagree", async () => {
    const model = await buildDigest(db, accountDiscId, { start: PERIOD_START, end: PERIOD_END });
    const item = [
      ...model.sections.priorityNew,
      ...model.sections.stageChanges,
      ...model.sections.missingFacts,
      ...model.sections.monitoring,
    ].find((i) => i.projectId === projectDiscrepancyId)!;
    expect(item).toBeTruthy();
    // Both competing counts are surfaced, each carrying its own source link.
    expect(item.unitCountDisagreement).not.toBeNull();
    const values = item.unitCountDisagreement!.map((v) => v.units).sort((a, b) => b - a);
    expect(values).toEqual([198, 180]);
    for (const entry of item.unitCountDisagreement!) {
      expect(entry.sources.length).toBeGreaterThan(0);
      expect(entry.sources[0]!.url).toMatch(/^https:\/\//);
    }
    // The rendered brief presents both, not a single silently-chosen number.
    const html = renderDigestHtml(model);
    expect(html).toContain("Sources disagree on unit count");
    expect(html).toContain("198 units");
    expect(html).toContain("180 units");
    expect(html).toContain("https://example.invalid/king-notice");
    expect(html).toContain("https://example.invalid/seattle-mup");
  });

  it("agreement (or no stated count) produces no disagreement note", async () => {
    // Project A states no unit count in normalized_json → no false-positive note.
    const model = await buildDigest(db, accountId, { start: PERIOD_START, end: PERIOD_END });
    const a = model.sections.priorityNew.find((i) => i.projectId === projectPassId);
    expect(a?.unitCountDisagreement ?? null).toBeNull();
  });

  it("M4.4: a recorded human decision (promote) is the only automation override", async () => {
    await db
      .update(opportunities)
      .set({ state: "promoted" })
      .where(eq(opportunities.id, oppReviewId));
    const model = await buildDigest(db, accountId, { start: PERIOD_START, end: PERIOD_END });
    const item = [
      ...model.sections.priorityNew,
      ...model.sections.stageChanges,
      ...model.sections.missingFacts,
      ...model.sections.monitoring,
    ].find((i) => i.projectId === projectReviewId);
    expect(item).toBeTruthy();
    expect(item!.inclusion.mode).toBe("auto"); // human decided; policy records it
    expect(model.reviewQueue.map((i) => i.projectId)).not.toContain(projectReviewId);
  });
});
