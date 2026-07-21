import { describe, expect, it } from "vitest";
import {
  DECISION_STAGES,
  MAX_DECISIONS,
  decisionBidWindowNote,
  decisionForCandidate,
  easyWinBandIndex,
  isEasyWin,
  type CandidateRow,
  type EasyWinConfig,
} from "./digest.js";

/**
 * Owner 2026-07-20 (P2.1) — layered easy-win proximity bands. Pure unit tests
 * of the two banding behaviors: (a) the OUTER band is the qualification cutoff
 * (a 45-mi project now qualifies where the old flat 60 km = ~37 mi rejected it),
 * and (b) easy wins order nearest-band-first, so a closer job leads even when a
 * farther one scored higher.
 */

const MILE_M = 1609.34;

/** Lacey home point; bands mirror config/account-profiles.yaml (Solis). */
const HOME = { home_lon: -122.823, home_lat: 47.046 };

function easyWinCfg(over: Partial<EasyWinConfig> = {}): EasyWinConfig {
  return {
    ...HOME,
    radius_km: 80.5, // = 50 mi outer, the flat fallback
    radius_bands_mi: [20, 35, 50],
    max_age_days: 60,
    min_valuation_usd: null,
    max_valuation_usd: 2_000_000,
    ...over,
  };
}

function candidate(over: Partial<CandidateRow> = {}): CandidateRow {
  return {
    id: "opp-1",
    project_id: "proj-1",
    canonical_name: "Test Interior TI",
    county: "Thurston",
    permitting_jurisdiction: "Thurston County",
    current_stage: "permit_issued",
    current_score: 80,
    route: "interior_trades",
    state: "priority_review",
    rationale_json: null,
    text: "tenant improvement drywall paint",
    max_valuation: 250_000,
    latest_issue_date: "2026-07-01",
    campus_block: null,
    last_material_change_at: new Date().toISOString(),
    has_org: true,
    dist_m: null,
    ...over,
  };
}

describe("layered easy-win proximity bands (owner 2026-07-20)", () => {
  it("a 45-mi project qualifies under the 50-mi outer band but not the old flat 60 km", () => {
    const at45mi = candidate({ dist_m: 45 * MILE_M });
    // 45 mi = ~72.4 km: inside the 50-mi (80.5 km) outer band, outside 60 km.
    expect(isEasyWin(at45mi, easyWinCfg())).toBe(true);
    expect(isEasyWin(at45mi, easyWinCfg({ radius_km: 60, radius_bands_mi: null }))).toBe(false);
  });

  it("still rejects a project beyond the outer band", () => {
    const at55mi = candidate({ dist_m: 55 * MILE_M });
    expect(isEasyWin(at55mi, easyWinCfg())).toBe(false);
  });

  it("assigns the first band whose miles cover the distance; null distance sorts last", () => {
    const bands = [20, 35, 50];
    expect(easyWinBandIndex(10 * MILE_M, bands)).toBe(0); // <= 20
    expect(easyWinBandIndex(30 * MILE_M, bands)).toBe(1); // <= 35
    expect(easyWinBandIndex(45 * MILE_M, bands)).toBe(2); // <= 50
    expect(easyWinBandIndex(55 * MILE_M, bands)).toBe(bands.length); // beyond outer
    expect(easyWinBandIndex(null, bands)).toBe(Number.MAX_SAFE_INTEGER);
    // No bands configured ⇒ every candidate shares band 0 (pure score order).
    expect(easyWinBandIndex(45 * MILE_M, null)).toBe(0);
  });

  it("orders nearer candidates before farther higher-score ones", () => {
    const bands = [20, 35, 50];
    const near = { distM: 10 * MILE_M, score: 70 }; // band 0, lower score
    const far = { distM: 45 * MILE_M, score: 95 }; // band 2, higher score
    // The buildDigest comparator: (band asc, score desc).
    const ordered = [far, near].sort(
      (a, b) =>
        easyWinBandIndex(a.distM, bands) - easyWinBandIndex(b.distM, bands) ||
        b.score - a.score,
    );
    expect(ordered[0]).toBe(near); // nearer band wins despite the lower score
    expect(ordered[1]).toBe(far);
  });
});

/**
 * WS-G — the first-class "🧭 Decisions" pre-permit section. A pre-permit
 * (preapplication/entitlement) opportunity enters Decisions with the correct
 * bid-window note; a permit_issued one never does. The note is derived from
 * bid-window.ts (classify → bidTrackFor → tradeBidWindows), never the model.
 */
describe("WS-G Decisions section (pre-permit)", () => {
  it("only pre-permit stages qualify; permit_issued/approved do not", () => {
    expect(DECISION_STAGES.has("preapplication")).toBe(true);
    expect(DECISION_STAGES.has("entitlement")).toBe(true);
    expect(DECISION_STAGES.has("concept")).toBe(true);
    expect(DECISION_STAGES.has("permit_issued")).toBe(false);
    expect(DECISION_STAGES.has("approved")).toBe(false);
    expect(MAX_DECISIONS).toBeGreaterThan(0);
  });

  it("a preapplication opportunity becomes a Decisions entry", () => {
    const d = decisionForCandidate(
      candidate({
        current_stage: "preapplication",
        canonical_name: "Cedar Grove Apartments",
        text: "new multifamily apartment building — 60 units",
      }),
    );
    expect(d).not.toBeNull();
    expect(d!.projectName).toBe("Cedar Grove Apartments");
    expect(d!.stage).toBe("preapplication");
    expect(d!.county).toBe("Thurston");
    expect(d!.bidWindowNote.length).toBeGreaterThan(0);
  });

  it("an entitlement commercial opportunity carries the commercial-buyout note (biddable now)", () => {
    const note = decisionBidWindowNote({
      projectId: "p1",
      county: "Thurston",
      permittingJurisdiction: "City of Olympia",
      stage: "entitlement",
      text: "new commercial office building with retail storefront",
      maxValuation: 4_000_000,
    });
    // Commercial finish subs are bought out during plan review, pre-permit.
    expect(note).toMatch(/biddable now/i);
    expect(note).toMatch(/buyout/i);
  });

  it("a residential preapplication opportunity says bids open after the permit issues", () => {
    const note = decisionBidWindowNote({
      projectId: "p2",
      county: "Thurston",
      permittingJurisdiction: "Thurston County",
      stage: "preapplication",
      text: "single family dwelling — new detached home",
      maxValuation: 350_000,
    });
    expect(note).toMatch(/after the permit issues/i);
    expect(note).not.toMatch(/biddable now/i);
  });

  it("a permit_issued opportunity is NOT a Decisions entry (returns null)", () => {
    expect(decisionForCandidate(candidate({ current_stage: "permit_issued" }))).toBeNull();
    expect(decisionForCandidate(candidate({ current_stage: "approved" }))).toBeNull();
    expect(decisionForCandidate(candidate({ current_stage: "construction" }))).toBeNull();
  });
});
