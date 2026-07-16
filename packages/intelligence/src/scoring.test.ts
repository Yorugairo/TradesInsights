import { describe, expect, it } from "vitest";
import {
  classify,
  routeProject,
  type AccountScoringInput,
  type ProjectFeatures,
} from "./scoring.js";

const ACCOUNTS: AccountScoringInput[] = [
  {
    key: "lacey_glass_at_home",
    territory: {
      counties_included: ["Thurston", "Lewis", "Mason", "Pierce", "Grays Harbor"],
      counties_excluded: ["King"],
    },
    weights: {
      product_fit: 25,
      repeatable_units_or_builder_value: 25,
      timing: 20,
      territory: 10,
      builder_developer_identified: 10,
      evidence_quality: 10,
    },
    delivery: { priority_review_min: 80, weekly_digest_min: 65 },
  },
  {
    key: "lacey_glass_commercial",
    territory: { counties_included: ["Thurston", "Pierce", "Lewis", "King"], counties_excluded: [] },
    weights: {
      division_08_system_fit: 25,
      scale_value: 20,
      timing: 20,
      geography: 10,
      gc_developer_architect_known: 15,
      evidence_quality: 10,
    },
    delivery: { priority_review_min: 80, weekly_digest_min: 65 },
  },
  {
    key: "solis_interiors",
    territory: { counties_included: ["Thurston", "Pierce", "Lewis", "King"], counties_excluded: [] },
    weights: {
      trade_fit: 30,
      package_size_fit: 25,
      timing: 20,
      geography: 15,
      evidence_quality: 10,
    },
    delivery: { priority_review_min: 80, weekly_digest_min: 65 },
  },
];

function features(overrides: Partial<ProjectFeatures>): ProjectFeatures {
  return {
    projectId: "p1",
    county: "Thurston",
    permittingJurisdiction: "Thurston County",
    city: null,
    stage: "permit_applied",
    text: "",
    maxUnits: null,
    maxValuation: null,
    clusterSize: 1,
    hasVelocitySignal: false,
    orgs: [],
    aGradeEvidence: 1,
    lastMaterialChangeAt: new Date(),
    ...overrides,
  };
}

describe("M3.2 routing — the three accounts route differently (exit-gate requirement)", () => {
  it("a clustered Thurston SFR subdivision routes to At Home, not Commercial", () => {
    const f = features({
      text: "plat of copper falls single family residence new construction",
      clusterSize: 8,
      hasVelocitySignal: true,
      stage: "permit_issued",
      orgs: [{ name: "COPPER FALLS HOMES LLC", role: "applicant" }],
    });
    const routes = routeProject(f, ACCOUNTS);
    const keys = routes.map((r) => r.accountKey);
    expect(keys).toContain("lacey_glass_at_home");
    expect(keys).not.toContain("lacey_glass_commercial");
    const atHome = routes.find((r) => r.accountKey === "lacey_glass_at_home")!;
    expect(atHome.route).toBe("residential_glass");
    expect(atHome.state).toBe("priority_review"); // strong cluster + timing + builder
    expect(atHome.signals).toContain("clustered_sfr_townhome_permits");
  });

  it("King County commercial curtain wall routes to Commercial only (At Home excluded)", () => {
    const f = features({
      county: "King",
      permittingJurisdiction: "City of Seattle",
      text: "new commercial office building storefront curtain wall glazing",
      maxValuation: 4_000_000,
      stage: "permit_applied",
      orgs: [{ name: "SELLEN CONSTRUCTION INC", role: "primary_contractor" }],
    });
    const routes = routeProject(f, ACCOUNTS);
    const keys = routes.map((r) => r.accountKey);
    expect(keys).not.toContain("lacey_glass_at_home"); // King excluded until confirmed
    expect(keys).toContain("lacey_glass_commercial");
    const commercial = routes.find((r) => r.accountKey === "lacey_glass_commercial")!;
    expect(commercial.route).toBe("division_08");
    expect(commercial.state).toBe("priority_review");
    expect(commercial.signals).toContain("king_routes_commercial");
  });

  it("a tenant improvement routes to Solis with interior trade fit", () => {
    const f = features({
      text: "tenant improvement interior remodel drywall and paint suite 200",
      maxValuation: 250_000,
      stage: "permit_issued",
    });
    const routes = routeProject(f, ACCOUNTS);
    const solis = routes.find((r) => r.accountKey === "solis_interiors");
    expect(solis).toBeTruthy();
    expect(solis!.route).toBe("interior_trades");
    expect(solis!.components["trade_fit"]).toBe(1);
    expect(solis!.state).toBe("priority_review");
    // At Home has no residential signal here.
    expect(routes.map((r) => r.accountKey)).not.toContain("lacey_glass_at_home");
  });

  it("low-rise multifamily in Thurston is a joint_review candidate for At Home", () => {
    const f = features({
      text: "new apartment building 24 units",
      maxUnits: 24,
      stage: "entitlement",
    });
    const routes = routeProject(f, ACCOUNTS);
    const atHome = routes.find((r) => r.accountKey === "lacey_glass_at_home")!;
    const commercial = routes.find((r) => r.accountKey === "lacey_glass_commercial")!;
    expect(atHome.route).toBe("joint_review");
    expect(commercial.route).toBe("joint_review");
  });

  it("oversized multifamily flips Solis to GC relationship radar", () => {
    const f = features({
      text: "new apartment complex 198 units mixed-use development",
      maxUnits: 198,
      maxValuation: 40_000_000,
      stage: "permit_applied",
    });
    const routes = routeProject(f, ACCOUNTS);
    const solis = routes.find((r) => r.accountKey === "solis_interiors")!;
    expect(solis.route).toBe("gc_relationship_radar");
    expect(solis.signals).toContain("gc_relationship_radar");
  });

  it("a reroof in Grays Harbor stays inside At Home territory rules but scores low", () => {
    const f = features({
      county: "Grays Harbor",
      text: "reroof single family residence",
      stage: "permit_issued",
      aGradeEvidence: 1,
    });
    const routes = routeProject(f, ACCOUNTS);
    const atHome = routes.find((r) => r.accountKey === "lacey_glass_at_home");
    expect(atHome).toBeTruthy();
    expect(atHome!.state).not.toBe("priority_review"); // single reroof is not priority
    // Commercial/Solis don't operate in Grays Harbor per seed territories.
    expect(routes.length).toBe(1);
  });

  it("scores are deterministic weighted sums of components", () => {
    const f = features({ text: "single family residence", stage: "permit_applied" });
    const [r] = routeProject(f, [ACCOUNTS[0]!]);
    const manual =
      r!.components["product_fit"]! * 25 +
      r!.components["repeatable_units_or_builder_value"]! * 25 +
      r!.components["timing"]! * 20 +
      r!.components["territory"]! * 10 +
      r!.components["builder_developer_identified"]! * 10 +
      r!.components["evidence_quality"]! * 10;
    expect(r!.score).toBeCloseTo(Math.round(manual * 10) / 10, 5);
  });
});

describe("classify", () => {
  it("detects categories from stored text only", () => {
    const c = classify(
      features({ text: "tenant improvement storefront glazing apartment 12 units" }),
    );
    expect(c.isTi).toBe(true);
    expect(c.hasGlazing).toBe(true);
    expect(c.isMultifamily).toBe(true);
  });
});
