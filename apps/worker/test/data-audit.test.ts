/**
 * Data hygiene round 2, T4/T5 — the codified audit.
 *
 * The property under test is the one that decides whether anyone keeps running
 * this command: a broken invariant fails, and a fact about the world never
 * does. A 57%-person-name rate or an 83% untagged rate is not a defect, and an
 * audit that exits 1 on either would be muted within a week — at which point
 * the real invariants stop being read too.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { rawArtifacts, sourceRecords, sourceRuns, type Db } from "@otn/db";
import { collect, failedInvariants, render, type DataAudit } from "../src/data-audit.js";
import { resetSource, testDb } from "./helpers.js";

/** A clean audit: every invariant satisfied, every metric deliberately ugly. */
function healthy(over: Partial<DataAudit> = {}): DataAudit {
  return {
    invariants: {
      corroborationNull: 0,
      eventDedupeSurplus: 0,
      unresolvedNotInReview: 2,
      unresolvedTolerance: 10,
      splitExternalIds: 0,
      splitExamples: [],
    },
    coverage: {
      projects: 16231,
      located: 15031,
      neverAttemptedWithAddress: 2,
      neverAttemptedNoAddress: 552,
      attemptedNoMatch: 646,
      events: 41305,
    },
    organizations: {
      total: 6220,
      // 57% person_or_unknown — the exact shape production carries, and not a defect.
      byQuality: [
        { quality: "business", count: 2635 },
        { quality: "person_or_unknown", count: 3528 },
        { quality: "junk", count: 57 },
      ],
      collisionGroups: [{ normalizedName: "acme construction", organizations: 3 }],
    },
    junkOrgSafety: {
      junkTotal: 57,
      withRegistryRef: 0,
      withIdentifiers: 0,
      withAccountRelationship: 0,
      violators: [],
    },
    reviews: {
      pending: 2490,
      byRule: [{ rule: "proximity_org", count: 1622 }],
      byAwaiting: [{ awaiting: "org_evidence", count: 784 }],
      comparandaUpgraded: 0,
    },
    trades: {
      projects: 16231,
      tagged: 2694,
      untagged: 13537,
      untaggable: 3126,
      topUnmatched: [{ permitType: "BUILDING", projects: 3573 }],
    },
    valuation: {
      byState: [{ state: "priority_review", opportunities: 1200, withoutValuation: 1090 }],
      // Production's real shape: king publishes jobValue on every row and
      // prices 1,451 of them at zero, puyallup publishes only a permit fee.
      // Both are ugly and neither is a defect — `dropped` is 0 on both.
      bySource: [
        { source: "king_permit_reports", records: 1920, stated: 469, notPublished: 1451, dropped: 0 },
        { source: "puyallup_permits_arcgis", records: 1228, stated: 0, notPublished: 1228, dropped: 0 },
      ],
    },
    ...over,
  };
}

/**
 * `healthy()` with only the invariants you care about overridden. Added when a
 * fifth invariant landed and four call sites had to restate all of them — a
 * fixture that forces you to re-list unrelated fields is a fixture that will be
 * wrong the next time one is added.
 */
function withInvariants(over: Partial<DataAudit["invariants"]>): DataAudit {
  const base = healthy();
  return { ...base, invariants: { ...base.invariants, ...over } };
}

describe("failedInvariants", () => {
  it("passes a graph whose metrics are ugly but whose invariants hold", () => {
    // Every soft number above is at its worst measured value. None is fatal.
    expect(failedInvariants(healthy())).toEqual([]);
  });

  it("treats a DROPPED valuation as a metric, not an invariant", () => {
    // `dropped` is the one valuation bucket that means "we lost something", and
    // it still must not exit 1: it is a source-quality report, and an audit that
    // fails on it gets muted along with the invariants that matter.
    const failures = failedInvariants(
      healthy({
        valuation: {
          byState: [{ state: "priority_review", opportunities: 10, withoutValuation: 9 }],
          bySource: [
            { source: "somewhere", records: 100, stated: 1, notPublished: 0, dropped: 99 },
          ],
        },
      }),
    );
    expect(failures).toEqual([]);
  });

  it("fails on underived corroboration, naming the pass that did not run", () => {
    const failures = failedInvariants(
      withInvariants({ corroborationNull: 4 }),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("corroboration NULL on 4");
  });

  it("fails on duplicate events — the 0035 index not holding is a bug, not drift", () => {
    const failures = failedInvariants(
      withInvariants({ eventDedupeSurplus: 136 }),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("136 duplicate project_event");
  });

  it("tolerates a few unresolved strays and fails on a pile", () => {
    const at = (n: number) =>
      failedInvariants(
        withInvariants({ unresolvedNotInReview: n }),
      );
    // In flight between a resolve run and a review write — normal.
    expect(at(10)).toEqual([]);
    expect(at(11)).toHaveLength(1);
    expect(at(11)[0]).toContain("11 public record(s) neither resolved nor queued");
  });

  it("fails on a split permit and names the id — a count alone is unfixable", () => {
    // The defect this guard exists for: one real permit recorded as two
    // projects. Healed 2026-07-28 by resolver pass 1b; nothing announced the
    // repair, and without this nothing would announce a relapse either.
    const failures = failedInvariants(
      withInvariants({
        splitExternalIds: 2,
        splitExamples: [
          { source: "pierce_permits_arcgis", externalId: "1032039", projects: 2 },
          { source: "king_permit_reports", externalId: "BLD-9", projects: 3 },
        ],
      }),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("2 permit id(s) resolve to more than one project");
    expect(failures[0]).toContain("pierce_permits_arcgis:1032039");
    expect(failures[0]).toContain("pass 1b");
  });

  it("passes when no permit id is split — production's state today", () => {
    expect(failedInvariants(withInvariants({ splitExternalIds: 0 }))).toEqual([]);
  });

  it("reports every broken invariant at once rather than stopping at the first", () => {
    const failures = failedInvariants(
      withInvariants({
        corroborationNull: 1,
        eventDedupeSurplus: 1,
        unresolvedNotInReview: 99,
        splitExternalIds: 1,
        splitExamples: [{ source: "pierce_permits_arcgis", externalId: "26-3410", projects: 2 }],
      }),
    );
    expect(failures).toHaveLength(4);
  });
});

describe("render", () => {
  it("prints the person_or_unknown caveat next to the number that invites the mistake", () => {
    const out = render(healthy());
    expect(out).toContain("person_or_unknown");
    expect(out).toContain("sole proprietor, not a defect");
    // The residue must never read as a to-do list.
    expect(out).toContain("NOT a vocabulary to-do list");
    // The valuation caveat has to sit next to the number that invited the bad
    // inference, in the same place the reader's eye lands.
    expect(out).toContain("not published` is the SOURCE's choice");
    expect(out).toContain("DROPPED");
    // No violators is stated positively — silence would read as "not checked".
    expect(out).toContain("no violators");
  });

  it("names junk-tier violators instead of only counting them", () => {
    const out = render(
      healthy({
        junkOrgSafety: {
          junkTotal: 57,
          withRegistryRef: 1,
          withIdentifiers: 0,
          withAccountRelationship: 0,
          violators: [{ id: "abc", name: "TBD BUILDERS", why: "registry_ref" }],
        },
      }),
    );
    expect(out).toContain("TBD BUILDERS");
    expect(out).toContain("nothing is deleted, ever");
  });
});

describe("collect (against the corpus)", () => {
  let db: Db;
  let pool: pg.Pool;
  let sourceId: string;

  /**
   * Three records that reproduce, exactly, the three shapes that made the old
   * per-source metric misleading. This is the highest-value test in the round:
   * if the `dropped` allow-list ever widens to `%amount%` or `%cost%`, the
   * FeeAmount row moves buckets and this fails.
   */
  const FIXTURES: { externalId: string; raw: Record<string, string> }[] = [
    // Puyallup's shape: a permit FEE, which is not a construction valuation.
    { externalId: "AUDIT-FEE", raw: { FeeAmount: "450.00" } },
    // King's shape: the county priced this permit at zero.
    { externalId: "AUDIT-ZERO", raw: { jobValue: "0" } },
    // Bellevue's shape: the field exists and is empty (and must not crash the cast).
    { externalId: "AUDIT-EMPTY", raw: { VALUATION: "" } },
  ];

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
        canonicalUrl: "https://example.invalid/data-audit-test",
        retrievedAt: new Date(),
        contentType: "application/json",
        httpStatus: 200,
        storageKey: "raw/fake_source/data-audit-test",
        sha256: "a".repeat(64),
        byteSize: 2,
        headersJson: {},
        parserVersion: "test",
      })
      .returning({ id: rawArtifacts.id });
    const now = new Date();
    for (const f of FIXTURES) {
      await db.insert(sourceRecords).values({
        sourceId,
        rawArtifactId: artifact!.id,
        externalId: f.externalId,
        recordType: "building_permit",
        firstSeenAt: now,
        lastSeenAt: now,
        rawFieldsJson: f.raw,
        // valuationUsd absent — every fixture is an unstated valuation.
        normalizedJson: { title: f.externalId, valuationUsd: null },
        normalizedFingerprint: `data-audit-${f.externalId}`,
      });
    }
  });
  afterAll(async () => {
    await db.execute(sql`DELETE FROM source_records WHERE source_id = ${sourceId}`);
    await pool.end();
  });

  it("buckets an unstated valuation by WHY it is unstated", async () => {
    const audit = await collect(db);
    const fake = audit.valuation.bySource.find((s) => s.source === "fake_source")!;
    expect(fake).toBeTruthy();
    expect(fake.records).toBe(FIXTURES.length);
    expect(fake.stated).toBe(0);
    // A fee, a zero and an empty string are all the SOURCE publishing nothing
    // usable. None of them is a gap on our side.
    expect(fake.notPublished).toBe(FIXTURES.length);
    expect(fake.dropped).toBe(0);
  });

  it("counts a positive raw valuation with no normalized value as DROPPED", async () => {
    // The one shape that IS a bug: the number was there and we lost it.
    await db.insert(sourceRecords).values({
      sourceId,
      rawArtifactId: (
        await db.execute<{ id: string }>(
          sql`SELECT id FROM raw_artifacts WHERE source_id = ${sourceId} LIMIT 1`,
        )
      ).rows[0]!.id,
      externalId: "AUDIT-DROPPED",
      recordType: "building_permit",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      rawFieldsJson: { VALUATION: "125000" },
      normalizedJson: { title: "AUDIT-DROPPED", valuationUsd: null },
      normalizedFingerprint: "data-audit-AUDIT-DROPPED",
    });
    const audit = await collect(db);
    const fake = audit.valuation.bySource.find((s) => s.source === "fake_source")!;
    expect(fake.dropped).toBe(1);
    expect(fake.notPublished).toBe(FIXTURES.length);
    // Still only a metric — a real extraction gap does not fail the audit.
    // Asserted per-failure rather than on an empty list: this runs against
    // whatever corpus the machine has, and unrelated invariants may legitimately
    // be failing (a scratch DB with underived corroboration, say). The claim is
    // "no valuation bucket can ever produce a failure", not "this DB is clean".
    for (const f of failedInvariants(audit)) {
      expect(f.toLowerCase()).not.toContain("valuation");
      expect(f.toLowerCase()).not.toContain("dropped");
    }
    await db.execute(
      sql`DELETE FROM source_records WHERE source_id = ${sourceId} AND external_id = 'AUDIT-DROPPED'`,
    );
  });

  it("runs every query and returns a coherent shape", async () => {
    const audit = await collect(db);
    // Structural coherence, not fixed values: this runs against whatever corpus
    // the machine has. Asserting counts here would be asserting the corpus.
    expect(audit.coverage.projects).toBeGreaterThanOrEqual(0);
    // The four coverage buckets partition the project set exactly — this is the
    // assertion that would have caught the original conflated "never attempted".
    expect(
      audit.coverage.located +
        audit.coverage.neverAttemptedWithAddress +
        audit.coverage.neverAttemptedNoAddress +
        audit.coverage.attemptedNoMatch,
    ).toBe(audit.coverage.projects);
    expect(audit.trades.tagged + audit.trades.untagged).toBe(audit.trades.projects);
    expect(audit.trades.untaggable).toBeLessThanOrEqual(audit.trades.untagged);
    expect(
      audit.organizations.byQuality.reduce((n, q) => n + q.count, 0),
    ).toBe(audit.organizations.total);
    expect(audit.reviews.byRule.reduce((n, r) => n + r.count, 0)).toBe(audit.reviews.pending);
    expect(audit.reviews.byAwaiting.reduce((n, r) => n + r.count, 0)).toBe(audit.reviews.pending);
    for (const s of audit.valuation.bySource) {
      // The three buckets partition the record count by construction.
      expect(s.stated + s.notPublished + s.dropped).toBe(s.records);
      expect(s.dropped).toBeGreaterThanOrEqual(0);
    }
    // Archived opportunities are excluded by construction.
    expect(audit.valuation.byState.map((s) => s.state)).not.toContain("archive");
  });

  it("is read-only — running it twice changes nothing", async () => {
    const before = await collect(db);
    const after = await collect(db);
    expect(after).toEqual(before);
  });
});
