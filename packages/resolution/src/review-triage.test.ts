// Phase 3 — queue navigability. Pure surface only: what counts as a decision a
// human can make, and how few clusters it takes to clear the queue.
import { describe, expect, it } from "vitest";
import {
  classifyResolutionReviewState,
  clustersToCover,
  type ReviewCluster,
} from "./review.js";

const cluster = (count: number, over: Partial<ReviewCluster> = {}): ReviewCluster => ({
  matchedRule: "address_name",
  reasonKey: "same_address_name_mismatch",
  reasons: ["same_address_name_mismatch"],
  reviewState: "actionable",
  candidateProjectId: null,
  candidateName: null,
  candidateCounty: null,
  count,
  minScore: 0.5,
  maxScore: 0.55,
  sampleTitles: [],
  ...over,
});

describe("classifyResolutionReviewState (fail closed)", () => {
  const state = (matchedRule: string, reasons: string[]) =>
    classifyResolutionReviewState({ matchedRule, reasons });

  it("blocks the proximity bulk — a fuzzy name near a place is not a decision", () => {
    // 1,497 live rows, every one scoring an identical 0.600 because there is
    // nothing to score. The resolver names the problem itself.
    expect(state("proximity_org", ["fuzzy_without_parcel_or_org_support"])).toBe(
      "awaiting_evidence",
    );
    expect(state("proximity_org", ["generic_name", "proximity_only"])).toBe("awaiting_evidence");
  });

  it("keeps the reviews that rest on a concrete fact", () => {
    expect(state("address_name", ["same_address_name_mismatch"])).toBe("actionable");
    expect(state("address_name", ["generic_name", "same_address"])).toBe("actionable");
    expect(state("address_name", ["multiple_address_candidates"])).toBe("actionable");
    expect(state("parcel_overlap", ["conflicting_jurisdiction"])).toBe("actionable");
    expect(state("parcel_overlap", ["multiple_parcel_candidates"])).toBe("actionable");
  });

  it("FAILS CLOSED — an unrecognised rule or reason never reaches the operator", () => {
    // A new resolver rule should go quiet and visible, not quietly pad the queue
    // with rows nobody can act on.
    expect(state("brand_new_rule", ["something_nobody_has_seen"])).toBe("awaiting_evidence");
    expect(state("address_name", [])).toBe("awaiting_evidence");
  });

  it("a no-signal reason DOMINATES a decidable one", () => {
    // Belt and braces: if the resolver ever emits both, the pessimistic reading
    // wins rather than promoting the row on its more flattering reason.
    expect(state("proximity_org", ["same_address", "fuzzy_without_parcel_or_org_support"])).toBe(
      "awaiting_evidence",
    );
  });

  it("`generic_name` alone decides nothing — it qualifies another reason", () => {
    expect(state("address_name", ["generic_name"])).toBe("awaiting_evidence");
  });

  it("reproduces the measured live split of 760 actionable / 1,518 blocked", () => {
    const live: [string, string[], number][] = [
      ["proximity_org", ["fuzzy_without_parcel_or_org_support"], 1497],
      ["address_name", ["same_address_name_mismatch"], 680],
      ["parcel_overlap", ["conflicting_jurisdiction"], 42],
      ["address_name", ["generic_name", "same_address"], 30],
      ["proximity_org", ["generic_name", "proximity_only"], 21],
      ["address_name", ["multiple_address_candidates"], 7],
      ["parcel_overlap", ["multiple_parcel_candidates"], 1],
    ];
    let actionable = 0;
    let blocked = 0;
    for (const [matchedRule, reasons, n] of live) {
      if (classifyResolutionReviewState({ matchedRule, reasons }) === "actionable") actionable += n;
      else blocked += n;
    }
    expect(actionable).toBe(760);
    expect(blocked).toBe(1518);
    expect(actionable + blocked).toBe(2278);
  });
});

describe("clustersToCover", () => {
  it("counts the largest clusters needed to reach the fraction", () => {
    const clusters = [cluster(50), cluster(30), cluster(15), cluster(5)];
    expect(clustersToCover(clusters, 0.5)).toBe(1); // 50 of 100
    expect(clustersToCover(clusters, 0.8)).toBe(2); // 80 of 100
    expect(clustersToCover(clusters, 1)).toBe(4);
  });

  it("sorts by size itself, so callers cannot pass an unsorted list and get a lie", () => {
    const ascending = [cluster(5), cluster(15), cluster(30), cluster(50)];
    expect(clustersToCover(ascending, 0.5)).toBe(1);
  });

  it("is 0 for an empty queue rather than dividing by zero", () => {
    expect(clustersToCover([], 0.5)).toBe(0);
    expect(clustersToCover([cluster(0)], 0.5)).toBe(0);
  });

  it("shows where the leverage is — and where it runs out", () => {
    // 50 + 30 + 400 singletons = 480 rows. Half is 240: the two big clusters get
    // 80 of the way, and the remaining 160 come one row at a time. That is
    // exactly why singletons are COLLAPSED rather than deleted — they are a
    // quarter of the work and none of the leverage.
    const withTail = [cluster(50), cluster(30), ...Array.from({ length: 400 }, () => cluster(1))];
    expect(clustersToCover(withTail, 0.5)).toBe(162);
    // Without the tail the same two clusters clear half on their own.
    expect(clustersToCover([cluster(50), cluster(30)], 0.5)).toBe(1);
  });

  it("never exceeds the cluster count", () => {
    const clusters = [cluster(1), cluster(1), cluster(1)];
    expect(clustersToCover(clusters, 1)).toBe(3);
  });
});
