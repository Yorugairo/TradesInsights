// Phase 2 — the confidence rewire. These cover the pure scoring surface only:
// what a component is allowed to claim, and what a tier is allowed to assert.
// The match-rule behaviour they feed lives in registry-observations.test.ts.
import { describe, expect, it } from "vitest";
import {
  classifyReviewTier,
  computeTrust,
  gradeLocality,
  laplaceAcceptRate,
  LOCALITY_DIFFERENT_COUNTY,
  LOCALITY_SAME_CITY,
  LOCALITY_SAME_COUNTY,
  LOCALITY_UNKNOWN,
  MIN_HUMAN_DECISIONS,
  ruleHistoryComponent,
  TRUST_WEIGHTS,
  type TrustComponents,
} from "./registry-observations.js";

describe("computeTrust with a NULL component (Task 2.1 — no scoring on a frozen prior)", () => {
  const full: TrustComponents = {
    name: 1,
    identifier: 0.5,
    locality: 0.3,
    role: 1,
    corroboration: 0.5,
    ruleHistory: 0.5,
  };

  it("renormalizes, so a null component neither adds nor subtracts", () => {
    // ruleHistory was a CONSTANT 0.5 on every row in the queue (19 decisions
    // ever recorded, all `auto:strict-bind`). Substituting the prior pinned 20%
    // of every score to one number; excluding it and renormalizing keeps the
    // score a weighted average of evidence that actually exists.
    const scored = computeTrust({ ...full, ruleHistory: null });
    const weightPresent = 1 - TRUST_WEIGHTS.ruleHistory;
    const manual =
      (TRUST_WEIGHTS.name * 1 +
        TRUST_WEIGHTS.identifier * 0.5 +
        TRUST_WEIGHTS.locality * 0.3 +
        TRUST_WEIGHTS.role * 1 +
        TRUST_WEIGHTS.corroboration * 0.5) /
      weightPresent;
    expect(scored).toBeCloseTo(Math.round(manual * 1000) / 1000, 3);
  });

  it("AMPLIFIES the gap between rows that differ only in real evidence", () => {
    // The whole point: a constant riding 20% of the score compressed rows that
    // genuinely differ toward each other.
    const weak = { ...full, locality: LOCALITY_UNKNOWN };
    const strong = { ...full, locality: LOCALITY_SAME_CITY };
    const withPrior = computeTrust(strong) - computeTrust(weak);
    const without =
      computeTrust({ ...strong, ruleHistory: null }) - computeTrust({ ...weak, ruleHistory: null });
    expect(without).toBeGreaterThan(withPrior);
  });

  it("still returns 1.0 when every component is present and 1.0", () => {
    expect(
      computeTrust({ ...full, identifier: 1, locality: 1, corroboration: 1, ruleHistory: 1 }),
    ).toBe(1);
  });

  it("returns 0 rather than NaN when nothing is scorable", () => {
    const allNull = {
      name: null,
      identifier: null,
      locality: null,
      role: null,
      corroboration: null,
      ruleHistory: null,
    } as unknown as TrustComponents;
    expect(computeTrust(allNull)).toBe(0);
  });
});

describe("ruleHistoryComponent (auto-decisions are not a track record)", () => {
  it("is null below the human-decision threshold", () => {
    expect(ruleHistoryComponent(undefined)).toBeNull();
    expect(ruleHistoryComponent({ accepts: 0, decisions: 0 })).toBeNull();
    expect(ruleHistoryComponent({ accepts: 9, decisions: MIN_HUMAN_DECISIONS - 1 })).toBeNull();
  });

  it("scores the moment a rule reaches the threshold", () => {
    expect(ruleHistoryComponent({ accepts: 8, decisions: MIN_HUMAN_DECISIONS })).toBe(
      laplaceAcceptRate(8, MIN_HUMAN_DECISIONS),
    );
  });

  it("a rule with only auto-decisions scores identically to one never decided", () => {
    // `ruleHistory()` filters `decided_by LIKE 'auto:%'` in SQL, so an auto-only
    // rule arrives here as an absent entry — indistinguishable from no history,
    // which is the point: the auto-binder must not grade its own work.
    expect(ruleHistoryComponent(undefined)).toBe(ruleHistoryComponent({ accepts: 0, decisions: 0 }));
  });
});

describe("gradeLocality (Task 2.2 — the geography both systems actually hold)", () => {
  const grade = (over: Partial<Parameters<typeof gradeLocality>[0]> = {}) =>
    gradeLocality({
      entityCity: "bellingham",
      entityCounty: "Whatcom",
      orgLocalities: [],
      orgCounties: [],
      ...over,
    });

  it("same city is the top band and stays EXACTLY 1 (evaluateStrictBind gates on it)", () => {
    expect(grade({ orgLocalities: ["bellingham"], orgCounties: ["whatcom"] })).toBe(1);
    expect(LOCALITY_SAME_CITY).toBe(1);
  });

  it("same county, different city lands between the floor and a city hit", () => {
    // 61 of the 254 pending rows are exactly this, and used to score the floor.
    const v = grade({ orgLocalities: ["ferndale"], orgCounties: ["whatcom"] });
    expect(v).toBe(LOCALITY_SAME_COUNTY);
    expect(v).toBeGreaterThan(LOCALITY_UNKNOWN);
    expect(v).toBeLessThan(LOCALITY_SAME_CITY);
  });

  it("folds case — registry counties are Title Case, Insights counties lower", () => {
    expect(grade({ entityCounty: "Whatcom", orgCounties: ["whatcom"] })).toBe(LOCALITY_SAME_COUNTY);
  });

  it("unknown geography holds the floor rather than taking a penalty", () => {
    expect(grade({ entityCounty: null, orgCounties: ["whatcom"] })).toBe(LOCALITY_UNKNOWN);
    expect(grade({ entityCounty: "Whatcom", orgCounties: [] })).toBe(LOCALITY_UNKNOWN);
    expect(grade({ entityCity: null, entityCounty: null })).toBe(LOCALITY_UNKNOWN);
  });

  it("a KNOWN different county scores below unknown — but only mildly", () => {
    // Knowing both and finding them different is weak evidence against; not
    // knowing is no evidence at all. Contractors legitimately work out of
    // county, so this is a nudge, never a veto.
    const different = grade({ orgLocalities: ["seattle"], orgCounties: ["king"] });
    expect(different).toBe(LOCALITY_DIFFERENT_COUNTY);
    expect(different).toBeLessThan(LOCALITY_UNKNOWN);
    expect(different).toBeGreaterThan(0);
  });

  it("a city hit wins even when the counties disagree", () => {
    // Municipal boundaries straddle counties; the finer signal is the better one.
    expect(grade({ orgLocalities: ["bellingham"], orgCounties: ["king"] })).toBe(LOCALITY_SAME_CITY);
  });

  it("produces four distinct bands where the old binary produced two", () => {
    const bands = new Set([
      grade({ orgLocalities: ["bellingham"], orgCounties: ["whatcom"] }),
      grade({ orgLocalities: ["ferndale"], orgCounties: ["whatcom"] }),
      grade({ entityCounty: null }),
      grade({ orgLocalities: ["seattle"], orgCounties: ["king"] }),
    ]);
    expect(bands.size).toBe(4);
  });
});

describe("classifyReviewTier — evidence-defined (Task 2.4)", () => {
  const bind = (over: Partial<Parameters<typeof classifyReviewTier>[0]>) =>
    classifyReviewTier({
      observationType: "binding_name_match",
      ruleKey: "binding_name_exact",
      trustScore: 0.7,
      trustComponents: { name: 1, locality: LOCALITY_UNKNOWN, identifier: 0.5 },
      payload: {},
      ...over,
    });

  it("a shared trade is worth ONE point, not two — it is plausibility, not identity", () => {
    // 61% of the pending queue shares a trade code with its candidate. "Both are
    // electricians" does not distinguish this entity from the other electrician
    // of the same name, so on its own it lifts a row to tier2 and no further.
    const r = bind({ payload: { trade_match: true } });
    expect(r.tier).toBe("tier2");
    expect(r.reason).toContain("shared trade");
  });

  it("tier1 — a shared trade PLUS the right county clears the two-point bar", () => {
    const r = bind({
      trustComponents: { name: 1, locality: LOCALITY_SAME_COUNTY, identifier: 0.5 },
      payload: { trade_match: true },
    });
    expect(r.tier).toBe("tier1");
    expect(r.reason).toContain("same county");
    expect(r.reason).toContain("shared trade");
  });

  it("tier1 — the registered city alone is worth two points on its own", () => {
    // This specific business is registered HERE; that narrows identity in a way
    // a trade code never does.
    expect(
      bind({ trustComponents: { name: 1, locality: LOCALITY_SAME_CITY, identifier: 0.5 } }).tier,
    ).toBe("tier1");
  });

  it("names EVERY corroborating fact, so the reviewer can check them", () => {
    const r = bind({
      trustComponents: { name: 1, locality: LOCALITY_SAME_CITY, identifier: 1 },
      payload: { trade_match: true, phone_agrees: true },
    });
    expect(r.tier).toBe("tier1");
    expect(r.reason).toContain("same city");
    expect(r.reason).toContain("shared trade");
    expect(r.reason).toContain("L&I phone");
  });

  it("same county alone is NOT enough for tier1 — a county holds thousands", () => {
    const r = bind({
      trustComponents: { name: 1, locality: LOCALITY_SAME_COUNTY, identifier: 0.5 },
    });
    expect(r.tier).toBe("tier2");
    expect(r.reason).toContain("same county");
  });

  it("separates 'different county' from 'no locality evidence' in the reason", () => {
    // Both are tier3 — neither corroborates — but a reviewer opening the row
    // deserves to know which of the two situations they are in.
    const different = bind({
      trustComponents: { name: 1, locality: LOCALITY_DIFFERENT_COUNTY, identifier: 0.5 },
    });
    const unknown = bind({
      trustComponents: { name: 1, locality: LOCALITY_UNKNOWN, identifier: 0.5 },
    });
    expect(different.tier).toBe("tier3");
    expect(unknown.tier).toBe("tier3");
    expect(different.reason).not.toBe(unknown.reason);
    expect(different.reason).toContain("different county");
  });

  it("a SHARED identifier is worth one point and is labelled shared", () => {
    // Its bucket-mates remain live alternatives, so it cannot carry a row alone.
    const r = bind({ trustComponents: { name: 1, locality: LOCALITY_UNKNOWN, identifier: 0.75 } });
    expect(r.tier).toBe("tier2");
    expect(r.reason).toContain("shared");
  });

  it("a UNIQUE identifier is worth two — it maps to exactly one entity", () => {
    const r = bind({ trustComponents: { name: 1, locality: LOCALITY_UNKNOWN, identifier: 1 } });
    expect(r.tier).toBe("tier1");
    expect(r.reason).toContain("unique");
  });

  it("a CONTRADICTED identifier is tier3 however much else agrees", () => {
    const r = bind({
      trustComponents: { name: 1, locality: LOCALITY_SAME_CITY, identifier: 0 },
      payload: { trade_match: true },
    });
    expect(r.tier).toBe("tier3");
    expect(r.reason).toContain("CONTRADICTS");
  });

  it("entity-footprint fallback bands never masquerade as agreement", () => {
    // 0.6 (well-pinned) and 0.35 (shared-only) both mean "the org gave us
    // nothing to compare"; only >= 0.75 is an actual agreeing identifier, so
    // none of these earns a point.
    for (const identifier of [0.6, 0.5, 0.35, 0.3]) {
      expect(
        bind({ trustComponents: { name: 1, locality: LOCALITY_UNKNOWN, identifier } }).tier,
      ).toBe("tier3");
    }
  });

  it("is non-degenerate across a representative spread", () => {
    const tiers = new Set([
      bind({ trustComponents: { name: 1, locality: LOCALITY_SAME_CITY, identifier: 1 } }).tier,
      bind({ trustComponents: { name: 1, locality: LOCALITY_SAME_COUNTY, identifier: 0.5 } }).tier,
      bind({
        ruleKey: "binding_google_phone_match",
        trustComponents: { name: 0.7, locality: LOCALITY_UNKNOWN, identifier: 0.75 },
        payload: { name_similarity: 0.7 },
      }).tier,
    ]);
    expect(tiers).toEqual(new Set(["tier1", "tier2", "tier3"]));
  });

  it("reproduces the measured live tier mix on the 254-row bulk", () => {
    // The eight (trade_match, locality) combinations actually present in the
    // queue, with their row counts, measured 2026-07-24. A regression here means
    // the tier mix an operator sees has silently moved.
    const live: [boolean, number, number][] = [
      [true, LOCALITY_DIFFERENT_COUNTY, 70],
      [true, LOCALITY_UNKNOWN, 48],
      [false, LOCALITY_DIFFERENT_COUNTY, 45],
      [true, LOCALITY_SAME_COUNTY, 35],
      [false, LOCALITY_SAME_COUNTY, 26],
      [false, LOCALITY_UNKNOWN, 20],
      [false, LOCALITY_SAME_CITY, 9],
      [true, LOCALITY_SAME_CITY, 1],
    ];
    const mix = { tier1: 0, tier2: 0, tier3: 0 };
    for (const [trade, locality, n] of live) {
      const t = bind({
        trustComponents: { name: 1, locality, identifier: 0.5 },
        payload: { trade_match: trade },
      }).tier;
      mix[t] += n;
    }
    expect(mix).toEqual({ tier1: 45, tier2: 144, tier3: 65 });
    expect(mix.tier1 + mix.tier2 + mix.tier3).toBe(254);
  });
});
