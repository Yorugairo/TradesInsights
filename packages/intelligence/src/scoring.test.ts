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

  it("a turf/athletic field is not Commercial priority (M3.8 wrong_trade regression)", () => {
    // The Lakeside School athletic field (7126700-CN ↔ LU ↔ SEPA) is a
    // high-valuation public-adjacent project with NO Division 08 scope. Under
    // the v1.0.0 scorer it scored 85 (priority, wrong_trade); the M4.2
    // field-work demotion must keep it out of the priority band. Guard so a
    // future glazing/field-work regex edit can't silently regress it.
    const f = features({
      county: "King",
      permittingJurisdiction: "City of Seattle",
      text: "lakeside school athletic field construct alterations to athletic field including fences netting and scoreboard replace existing natural grass with new synthetic turf",
      maxValuation: 32_000_000,
      stage: "permit_applied",
      orgs: [{ name: "Lakeside School", role: "applicant" }],
    });
    const c = classify(f);
    expect(c.isFieldWork).toBe(true);
    expect(c.hasGlazing).toBe(false);
    const commercial = routeProject(f, ACCOUNTS).find(
      (r) => r.accountKey === "lacey_glass_commercial",
    )!;
    expect(commercial.components["division_08_system_fit"]).toBe(0.2);
    expect(commercial.state).not.toBe("priority_review");
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

describe("commercial Division-08 negative filters (S6 demolition/entitlement)", () => {
  function d08(text: string): number {
    const f = features({
      county: "King",
      permittingJurisdiction: "Unincorporated King County",
      text,
      maxValuation: 5_000_000,
      stage: "permit_issued",
    });
    return routeProject(f, ACCOUNTS).find((r) => r.accountKey === "lacey_glass_commercial")!
      .components["division_08_system_fit"]!;
  }

  it("a demolition with only incidental glazing keywords is not priority (SpaceX CHAMBER DEMO)", () => {
    // Glazing words appear, but the scope is removal — nothing to install.
    expect(d08("commercial demo of cleanroom chambers removal of glass curtain wall")).toBe(0.2);
  });

  it("a demolish-AND-rebuild keeps full Division-08 fit (real new glazing)", () => {
    expect(d08("demolish existing building and construct new storefront curtain wall")).toBe(1);
  });

  it("a bare entitlement action (CUP) with no construction scope is radar, not priority", () => {
    // Capped even though a glazing keyword appears speculatively.
    expect(d08("conditional use permit for 2nd floor use window glazing")).toBe(0.4);
  });

  it("a genuine commercial glazing project is unaffected (control)", () => {
    expect(d08("new commercial office building storefront curtain wall glazing")).toBe(1);
  });
});

describe("per-record Division-08 classification (campus-cluster fix)", () => {
  function d08(records: string[]): number {
    const f = features({
      county: "King",
      permittingJurisdiction: "Unincorporated King County",
      text: records.join(" "), // blob, as a control
      records,
      maxValuation: 5_000_000,
      stage: "permit_issued",
    });
    return routeProject(f, ACCOUNTS).find((r) => r.accountKey === "lacey_glass_commercial")!
      .components["division_08_system_fit"]!;
  }

  it("a glazing keyword in a demolition record does not borrow a sibling record's build scope", () => {
    // Blob would see demo + "install" (from the fire record) + "glass" → 1.
    // Per-record: the demo record owns the glazing keyword and has no build
    // scope → 0.2; the fire record has no glazing → the project stays 0.2.
    expect(
      d08(["commercial demo of cleanroom chambers removal glass", "fire sprinkler install and monitor"]),
    ).toBe(0.2);
  });

  it("glazing that genuinely co-occurs with construction in one record stays full fit", () => {
    expect(
      d08(["demolish existing partitions", "construct new storefront curtain wall glazing"]),
    ).toBe(1);
  });

  it("a 'window' referenced in a record that disclaims exterior work is not glazing scope", () => {
    // The SpaceX HVAC record: a window as a duct-penetration point, "no change
    // to exterior" — not glazing work.
    expect(
      d08([
        "data center cooling install air handling unit mechanical ductwork penetration through existing window no change to exterior building addition tenant",
        "commercial demo of chambers",
      ]),
    ).toBeLessThan(1);
  });

  it("the blob path (no records) is unchanged — single record equals prior behavior", () => {
    const blob = features({
      county: "King",
      text: "new commercial office building storefront curtain wall glazing",
      maxValuation: 5_000_000,
      stage: "permit_issued",
    });
    expect(
      routeProject(blob, ACCOUNTS).find((r) => r.accountKey === "lacey_glass_commercial")!
        .components["division_08_system_fit"],
    ).toBe(1);
  });
});

describe("active-campus feature (#1 campus surfacing, scorer v1.4.0)", () => {
  const smallCommercial = {
    county: "King" as const,
    permittingJurisdiction: "Unincorporated King County",
    text: "commercial tenant improvement suite 210",
    maxValuation: 40_000, // below every scale threshold on its own
    stage: "permit_issued" as const,
  };

  it("campus membership floors commercial scale_value at 0.6 and adds the signal", () => {
    const inCampus = routeProject(
      features({ ...smallCommercial, campusBlock: "King:720232" }),
      ACCOUNTS,
    ).find((r) => r.accountKey === "lacey_glass_commercial")!;
    expect(inCampus.components["scale_value"]).toBe(0.6);
    expect(inCampus.signals).toContain("active_campus");
  });

  it("absent campusBlock (frozen eval examples) scores exactly as before", () => {
    const solo = routeProject(features(smallCommercial), ACCOUNTS).find(
      (r) => r.accountKey === "lacey_glass_commercial",
    )!;
    expect(solo.components["scale_value"]).toBe(0.15);
    expect(solo.signals).not.toContain("active_campus");
  });

  it("campus never affects At Home routing (campuses are commercial sites)", () => {
    // An industrial campus member must not become residentialFit for At Home.
    const f = features({
      county: "Lewis",
      text: "industrial fabrication building",
      campusBlock: "Lewis:003882",
      stage: "permit_issued",
    });
    const atHome = routeProject(f, ACCOUNTS).find((r) => r.accountKey === "lacey_glass_at_home");
    expect(atHome).toBeUndefined();
  });

  it("Solis gets the signal but no score change (provisional profile)", () => {
    const base = features({
      county: "Thurston",
      text: "commercial tenant improvement drywall",
      maxValuation: 100_000,
      stage: "permit_issued",
    });
    const solo = routeProject(base, ACCOUNTS).find((r) => r.accountKey === "solis_interiors")!;
    const inCampus = routeProject(
      { ...base, campusBlock: "Thurston:1180232" },
      ACCOUNTS,
    ).find((r) => r.accountKey === "solis_interiors")!;
    expect(inCampus.score).toBe(solo.score);
    expect(inCampus.signals).toContain("active_campus");
    expect(solo.signals).not.toContain("active_campus");
  });
});

describe("S6 Lacey cost control — shared services, no org-id branches", () => {
  it("Home and Commercial both route through the shared config-keyed pipeline", () => {
    // A project with NO organization still routes for the Lacey profiles — route
    // selection is driven by the account key + config weights, never by a
    // hard-coded Lacey organization id.
    const f = features({
      county: "King",
      permittingJurisdiction: "City of Seattle",
      text: "new commercial office building storefront curtain wall glazing",
      maxValuation: 5_000_000,
      stage: "permit_applied",
      orgs: [],
    });
    const routes = routeProject(f, ACCOUNTS);
    expect(routes.map((r) => r.accountKey)).toContain("lacey_glass_commercial");
  });

  it("organization identity does not change the route (no org-id-conditional behavior)", () => {
    const base = features({
      county: "Thurston",
      text: "plat of maple grove single family residence new construction",
      clusterSize: 6,
      hasVelocitySignal: true,
      stage: "permit_issued",
    });
    const withoutOrg = routeProject({ ...base, orgs: [] }, ACCOUNTS).find(
      (r) => r.accountKey === "lacey_glass_at_home",
    );
    const withOrg = routeProject(
      { ...base, orgs: [{ name: "MAPLE GROVE HOMES LLC", role: "applicant" }] },
      ACCOUNTS,
    ).find((r) => r.accountKey === "lacey_glass_at_home");
    // Same route either way; the builder org only affects the evidence/identity
    // component, never which shared router runs.
    expect(withoutOrg?.route).toBe(withOrg?.route);
    expect(withoutOrg?.route).toBe("residential_glass");
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
