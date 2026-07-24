import { describe, expect, it } from "vitest";
import type { Db } from "@otn/db";
import { queueSummary } from "./cockpit-summary.js";

/**
 * A superset row that satisfies all three Insights-side group-bys at once:
 * `triageReviewQueue` reads matched_rule/n/…, the registry-review group-by reads
 * rule_key/n, the lane count reads n. Returning the same rows for every
 * `db.execute` keeps the stub trivial while exercising the real aggregation.
 */
const superRow = (over: Record<string, unknown> = {}) => ({
  matched_rule: "binding_name_exact",
  reason_key: "same_address_name_mismatch",
  // A DECIDABLE reason: `resolutionReview.clusters` previews only clusters an
  // operator can act on, and the classifier fails closed, so a row with no
  // reasons would (correctly) be filtered out of the preview entirely.
  reasons: ["same_address_name_mismatch"],
  candidate_project_id: null,
  candidate_name: null,
  candidate_county: null,
  n: 3,
  min_score: 0,
  max_score: 0,
  samples: [],
  rule_key: "binding_name_exact",
  ...over,
});

/** Minimal Db: the cockpit's Insights-side helpers use only `db.execute`. */
const stubDb = (rows: Record<string, unknown>[]): Db =>
  ({ execute: async () => ({ rows }) }) as unknown as Db;

describe("queueSummary", () => {
  it("null registry pool ⇒ families and googlePlace are null, never zeroed", async () => {
    const summary = await queueSummary(stubDb([]), null);

    // The required Phase C contract: seam-dependent sections degrade to null.
    expect(summary.families).toBeNull();
    expect(summary.googlePlace).toBeNull();

    // Insights-side sections still resolve (empty DB ⇒ honest zeros).
    expect(summary.resolutionReview.total).toBe(0);
    expect(summary.resolutionReview.clusters).toEqual([]);
    expect(summary.registryReview.total).toBe(0);
    expect(summary.registryReview.byRule).toEqual([]);
    expect(summary.lanes.enrichmentPhoneCandidates30d).toBe(0);
    expect(summary.lanes.domainGated).toBe(true);
  });

  it("sums the canonical counts and caps the cluster preview at 5", async () => {
    // Six clusters of 3 each; the same rows feed every group-by.
    const rows = Array.from({ length: 6 }, (_, i) => superRow({ candidate_project_id: `p${i}` }));
    const summary = await queueSummary(stubDb(rows), null);

    // Resolution review: total is the SUM (6 × 3 = 18); preview capped at 5.
    expect(summary.resolutionReview.total).toBe(18);
    expect(summary.resolutionReview.clusters).toHaveLength(5);

    // Registry review: total sums the per-rule counts; byRule mirrors the rows.
    expect(summary.registryReview.total).toBe(18);
    expect(summary.registryReview.byRule).toHaveLength(6);
    expect(summary.registryReview.byRule[0]).toEqual({ ruleKey: "binding_name_exact", count: 3 });

    // Lane count reads the first row's n.
    expect(summary.lanes.enrichmentPhoneCandidates30d).toBe(3);

    // Still null-seam: no pool was passed.
    expect(summary.families).toBeNull();
    expect(summary.googlePlace).toBeNull();
  });
});
