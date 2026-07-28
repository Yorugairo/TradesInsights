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

/**
 * A Db that answers each section differently, keyed on a fragment of its SQL.
 * The trivial stub above returns one row-set for every query, which cannot
 * exercise two sections that read different tables.
 */
const routedDb = (routes: { match: string; rows: Record<string, unknown>[] }[]): Db =>
  ({
    execute: async (q: unknown) => {
      const text = JSON.stringify(q);
      const hit = routes.find((r) => text.includes(r.match));
      return { rows: hit ? hit.rows : [] };
    },
  }) as unknown as Db;

describe("queueSummary — calibration provenance", () => {
  it("reports owner-assumed and pending counts per active account", async () => {
    const summary = await queueSummary(
      routedDb([
        {
          match: "account_profiles",
          rows: [
            { key: "solis_interiors", name: "Solis Interiors", stamped: true, owner_assumed: 7, calibration_pending: 8 },
            { key: "lacey_glass_commercial", name: "Lacey Glass Commercial", stamped: true, owner_assumed: 0, calibration_pending: 0 },
          ],
        },
      ]),
      null,
    );
    expect(summary.calibration).toEqual([
      { key: "solis_interiors", name: "Solis Interiors", stamped: true, ownerAssumed: 7, calibrationPending: 8 },
      { key: "lacey_glass_commercial", name: "Lacey Glass Commercial", stamped: true, ownerAssumed: 0, calibrationPending: 0 },
    ]);
  });

  it("distinguishes UNSTAMPED provenance from nothing outstanding", async () => {
    // The whole point of the third state: a NULL calibration_json means the
    // seed has not run for that account. Rendering it as 0/0 would invent a
    // clean bill of health for an account nobody has assessed.
    const summary = await queueSummary(
      routedDb([
        {
          match: "account_profiles",
          rows: [{ key: "new_account", name: "New Account", stamped: false, owner_assumed: 0, calibration_pending: 0 }],
        },
      ]),
      null,
    );
    expect(summary.calibration[0]?.stamped).toBe(false);
    expect(summary.calibration[0]?.ownerAssumed).toBe(0);
  });
});

describe("queueSummary — alerts", () => {
  it("splits open alerts by severity and lists the types", async () => {
    const summary = await queueSummary(
      routedDb([
        {
          match: "FROM alerts",
          rows: [
            { alert_type: "source_red", severity: "critical", open_n: 2, recent_n: 3 },
            { alert_type: "source_stale", severity: "warning", open_n: 4, recent_n: 4 },
            { alert_type: "spend_budget", severity: "warning", open_n: 1, recent_n: 2 },
          ],
        },
      ]),
      null,
    );
    expect(summary.alerts.openCritical).toBe(2);
    expect(summary.alerts.openWarning).toBe(5);
    expect(summary.alerts.firedLast24h).toBe(9);
    // Largest first — what is actually wrong, not alphabetical order.
    expect(summary.alerts.openByType[0]).toEqual({ alertType: "source_stale", count: 4 });
  });

  it("counts recent fires even when everything is resolved", async () => {
    // A night that fired and self-resolved is not the same as a quiet night,
    // and an operator reading only "0 open" would not know the difference.
    const summary = await queueSummary(
      routedDb([
        {
          match: "FROM alerts",
          rows: [{ alert_type: "source_red", severity: "critical", open_n: 0, recent_n: 6 }],
        },
      ]),
      null,
    );
    expect(summary.alerts.openCritical).toBe(0);
    expect(summary.alerts.openByType).toEqual([]);
    expect(summary.alerts.firedLast24h).toBe(6);
  });

  it("returns honest zeros on an empty alerts table", async () => {
    const summary = await queueSummary(routedDb([]), null);
    expect(summary.alerts).toEqual({
      openCritical: 0,
      openWarning: 0,
      firedLast24h: 0,
      openByType: [],
    });
    expect(summary.calibration).toEqual([]);
  });
});
