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
import type pg from "pg";
import type { Db } from "@otn/db";
import { collect, failedInvariants, render, type DataAudit } from "../src/data-audit.js";
import { testDb } from "./helpers.js";

/** A clean audit: every invariant satisfied, every metric deliberately ugly. */
function healthy(over: Partial<DataAudit> = {}): DataAudit {
  return {
    invariants: {
      corroborationNull: 0,
      eventDedupeSurplus: 0,
      unresolvedNotInReview: 2,
      unresolvedTolerance: 10,
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
      bySource: [{ source: "lewis_issued_permits", records: 900, withoutValuation: 900 }],
    },
    ...over,
  };
}

describe("failedInvariants", () => {
  it("passes a graph whose metrics are ugly but whose invariants hold", () => {
    // Every soft number above is at its worst measured value. None is fatal.
    expect(failedInvariants(healthy())).toEqual([]);
  });

  it("fails on underived corroboration, naming the pass that did not run", () => {
    const failures = failedInvariants(
      healthy({
        invariants: {
          corroborationNull: 4,
          eventDedupeSurplus: 0,
          unresolvedNotInReview: 0,
          unresolvedTolerance: 10,
        },
      }),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("corroboration NULL on 4");
  });

  it("fails on duplicate events — the 0035 index not holding is a bug, not drift", () => {
    const failures = failedInvariants(
      healthy({
        invariants: {
          corroborationNull: 0,
          eventDedupeSurplus: 136,
          unresolvedNotInReview: 0,
          unresolvedTolerance: 10,
        },
      }),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("136 duplicate project_event");
  });

  it("tolerates a few unresolved strays and fails on a pile", () => {
    const at = (n: number) =>
      failedInvariants(
        healthy({
          invariants: {
            corroborationNull: 0,
            eventDedupeSurplus: 0,
            unresolvedNotInReview: n,
            unresolvedTolerance: 10,
          },
        }),
      );
    // In flight between a resolve run and a review write — normal.
    expect(at(10)).toEqual([]);
    expect(at(11)).toHaveLength(1);
    expect(at(11)[0]).toContain("11 public record(s) neither resolved nor queued");
  });

  it("reports every broken invariant at once rather than stopping at the first", () => {
    const failures = failedInvariants(
      healthy({
        invariants: {
          corroborationNull: 1,
          eventDedupeSurplus: 1,
          unresolvedNotInReview: 99,
          unresolvedTolerance: 10,
        },
      }),
    );
    expect(failures).toHaveLength(3);
  });
});

describe("render", () => {
  it("prints the person_or_unknown caveat next to the number that invites the mistake", () => {
    const out = render(healthy());
    expect(out).toContain("person_or_unknown");
    expect(out).toContain("sole proprietor, not a defect");
    // The residue must never read as a to-do list.
    expect(out).toContain("NOT a vocabulary to-do list");
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

  beforeAll(async () => {
    ({ db, pool } = await testDb());
  });
  afterAll(async () => {
    await pool.end();
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
      expect(s.withoutValuation).toBeLessThanOrEqual(s.records);
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
