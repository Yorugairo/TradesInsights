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

describe("v1.8.0 — Solis routes residential new construction (home counties)", () => {
  const solisOf = (f: ProjectFeatures) =>
    routeProject(f, ACCOUNTS).find((r) => r.accountKey === "solis_interiors");

  it("a plain new SFR in Pierce routes: every new home needs drywall + paint", () => {
    const r = solisOf(
      features({
        county: "Pierce",
        stage: "permit_issued",
        text: "new single family residence 2400 sf",
        maxValuation: 450_000,
      }),
    )!;
    expect(r).toBeTruthy();
    expect(r.route).toBe("interior_trades");
    expect(r.components.trade_fit).toBe(0.7);
    expect(r.signals).toContain("new_home_construction");
  });

  it("clustered/subdivision new-builds are ONE relationship play, not per-house leads", () => {
    const r = solisOf(
      features({
        county: "Thurston",
        stage: "permit_issued",
        text: "new single family residence — lot 14 of cedar plat",
        clusterSize: 8,
        maxValuation: 400_000,
      }),
    )!;
    expect(r.route).toBe("gc_relationship_radar");
    expect(r.components.trade_fit).toBe(0.45); // digest-band, relationship framing
    expect(r.signals).toContain("production_builder_pipeline");
  });

  it("King new-builds stay out until calibration (distant secondary market)", () => {
    const r = solisOf(
      features({ county: "King", stage: "permit_issued", text: "new single family residence" }),
    );
    expect(r).toBeUndefined();
  });

  it("SFR demolition/field-work records never ride in on the SFR flag", () => {
    expect(
      solisOf(features({ county: "Pierce", text: "demolition of single family residence" })),
    ).toBeUndefined();
    // But an SFR remodel with interior scope still routes via the interior path.
    expect(
      solisOf(features({ county: "Pierce", text: "interior remodel of single family residence" })),
    ).toBeTruthy();
  });
});

describe("WS-B — registry identity as a Solis inference signal (score-neutral under §12.3)", () => {
  const solisTi = (orgs: ProjectFeatures["orgs"]): ProjectFeatures =>
    features({
      text: "tenant improvement interior remodel drywall and paint suite 200",
      maxValuation: 250_000,
      stage: "permit_issued",
      orgs,
    });
  const solis = (f: ProjectFeatures) =>
    routeProject(f, ACCOUNTS).find((r) => r.accountKey === "solis_interiors")!;

  it("a registry-bound GC lifts gc_identified to 1 and fires the verified_gc_on_project signal", () => {
    const r = solis(
      solisTi([
        {
          name: "pat rivera", // bare person name — no legal suffix
          role: "primary_contractor",
          registryRef: "8a12a7cb-0000",
          registryVerified: true,
        },
      ]),
    );
    expect(r.components["gc_identified"]).toBe(1);
    expect(r.signals).toContain("verified_gc_on_project");
  });

  it("the same GC unbound (bare person name) scores gc_identified 0.5 and fires no signal", () => {
    const r = solis(solisTi([{ name: "pat rivera", role: "primary_contractor" }]));
    expect(r.components["gc_identified"]).toBe(0.5);
    expect(r.signals).not.toContain("verified_gc_on_project");
  });

  it("registry identity is SCORE-NEUTRAL while Solis is provisional (§12.3): no weight ⇒ score unchanged", () => {
    const bound = solis(
      solisTi([{ name: "pat rivera", role: "primary_contractor", registryVerified: true }]),
    ).score;
    const unbound = solis(solisTi([{ name: "pat rivera", role: "primary_contractor" }])).score;
    expect(bound).toBe(unbound);
  });

  it("a binding lifts even a bare person name to full ID for a WEIGHTED account (Glass), no legal-name regression", () => {
    const commercial = (verified: boolean) =>
      routeProject(
        features({
          county: "King",
          permittingJurisdiction: "City of Seattle",
          text: "new commercial office building storefront curtain wall glazing",
          maxValuation: 4_000_000,
          stage: "permit_applied",
          orgs: [{ name: "pat rivera", role: "primary_contractor", registryVerified: verified }],
        }),
        ACCOUNTS,
      ).find((r) => r.accountKey === "lacey_glass_commercial")!;
    expect(commercial(true).components["gc_developer_architect_known"]).toBe(1); // bound ⇒ full
    expect(commercial(false).components["gc_developer_architect_known"]).toBe(0.5); // unchanged baseline
  });
});

describe("WS-W — warm-network signal (fires as a signal; v1.9.0 bounded +3 nudge)", () => {
  const WARM = "warm-entity-42";
  // The Solis account, optionally carrying a warm set of bound-GC registry refs.
  const solisWith = (warmGcRefs?: ReadonlySet<string>): AccountScoringInput => ({
    ...ACCOUNTS[2]!, // solis_interiors
    ...(warmGcRefs ? { warmGcRefs } : {}),
  });
  const solisTi = (orgs: ProjectFeatures["orgs"]): ProjectFeatures =>
    features({
      text: "tenant improvement interior remodel drywall and paint suite 200",
      maxValuation: 250_000,
      stage: "permit_issued",
      orgs,
    });
  const route = (f: ProjectFeatures, acct: AccountScoringInput) =>
    routeProject(f, [acct]).find((r) => r.accountKey === "solis_interiors")!;

  it("fires warm_gc_active when a project GC is in the account's warm set", () => {
    const f = solisTi([{ name: "acme builders llc", role: "primary_contractor", registryRef: WARM }]);
    expect(route(f, solisWith(new Set([WARM]))).signals).toContain("warm_gc_active");
  });

  it("does not fire when the GC's ref is not in the warm set, or no warm set exists", () => {
    const f = solisTi([{ name: "acme builders llc", role: "primary_contractor", registryRef: "other" }]);
    expect(route(f, solisWith(new Set([WARM]))).signals).not.toContain("warm_gc_active");
    // No warm set at all (accounts that don't compute it) ⇒ no signal, no crash.
    const g = solisTi([{ name: "acme builders llc", role: "primary_contractor", registryRef: WARM }]);
    expect(route(g, solisWith()).signals).not.toContain("warm_gc_active");
  });

  it("v1.9.0: the warm signal now adds a bounded +3 nudge (supersedes the prior score-neutral stance)", () => {
    // Owner 2026-07-20 (§12.3): warm_gc_active is a SMALL additive, clamped at 100.
    const f = solisTi([{ name: "acme builders llc", role: "primary_contractor", registryRef: WARM }]);
    const withWarm = route(f, solisWith(new Set([WARM]))).score;
    const without = route(f, solisWith()).score;
    expect(withWarm).toBeGreaterThan(without);
    expect(withWarm).toBe(Math.min(100, Math.round((without + 3) * 10) / 10));
  });
});

describe("v1.9.0 — owner-directed provisional Solis tweaks (2026-07-20, §12.3)", () => {
  const solisOf = (f: ProjectFeatures, acct: AccountScoringInput = ACCOUNTS[2]!) =>
    routeProject(f, [acct]).find((r) => r.accountKey === "solis_interiors")!;
  // A residential-track interior TI (no commercial/SFR keywords → residential
  // bid track), the shared fixture for all four v1.9.0 tweaks.
  const ti = (over: Partial<ProjectFeatures>): ProjectFeatures =>
    features({
      text: "tenant improvement interior remodel drywall and paint suite 200",
      maxValuation: 250_000,
      stage: "permit_issued",
      ...over,
    });

  // CHANGE 1 — geography tiers (home metro > home counties > other > distant King).
  it("up-weights the home metro: Thurston scores higher than an identical King project", () => {
    const thurston = solisOf(ti({ county: "Thurston" }));
    const king = solisOf(ti({ county: "King" }));
    expect(thurston.components["geography"]).toBe(1);
    expect(king.components["geography"]).toBe(0.6);
    expect(thurston.score).toBeGreaterThan(king.score);
  });

  it("Pierce (home county, 0.9) sits above distant King (0.6)", () => {
    const pierce = solisOf(ti({ county: "Pierce" }));
    const king = solisOf(ti({ county: "King" }));
    expect(pierce.components["geography"]).toBe(0.9);
    expect(king.components["geography"]).toBe(0.6);
    expect(pierce.score).toBeGreaterThan(king.score);
  });

  // CHANGE 2 — application stage weighted ABOVE issued on the residential track.
  it("an identical residential-interior project scores strictly higher at permit_applied than permit_issued", () => {
    const applied = solisOf(ti({ stage: "permit_applied" }));
    const issued = solisOf(ti({ stage: "permit_issued" }));
    expect(applied.components["timing"]).toBeGreaterThan(issued.components["timing"]!);
    expect(applied.score).toBeGreaterThan(issued.score);
  });

  // CHANGE 3 — a small (+3), clamped, additive warm-GC nudge.
  const WARM = "warm-entity-9";
  const solisWarm = (refs?: ReadonlySet<string>): AccountScoringInput => ({
    ...ACCOUNTS[2]!,
    ...(refs ? { warmGcRefs: refs } : {}),
  });
  const warmOrg = { name: "acme builders llc", role: "primary_contractor", registryRef: WARM };

  it("warm_gc_active adds exactly +3 when below the ceiling", () => {
    const f = ti({ county: "Pierce", orgs: [warmOrg] }); // base 96.5 (Pierce geo 0.9)
    const withWarm = solisOf(f, solisWarm(new Set([WARM])));
    const without = solisOf(f, solisWarm());
    expect(without.signals).not.toContain("warm_gc_active");
    expect(withWarm.signals).toContain("warm_gc_active");
    expect(without.score).toBe(96.5);
    expect(withWarm.score).toBe(99.5); // exactly +3
  });

  it("the warm nudge is clamped at 100", () => {
    const f = ti({ county: "Thurston", stage: "permit_applied", orgs: [warmOrg] }); // base 100
    expect(solisOf(f, solisWarm()).score).toBe(100);
    expect(solisOf(f, solisWarm(new Set([WARM]))).score).toBe(100); // +3 would be 103 → clamped
  });

  it("verified_gc_on_project alone does NOT change the score (only warm nudges)", () => {
    const verifiedOrg = {
      name: "pat rivera",
      role: "primary_contractor",
      registryRef: "bound-1",
      registryVerified: true,
    };
    const withVerified = solisOf(ti({ orgs: [verifiedOrg] }), solisWarm());
    const noOrg = solisOf(ti({ orgs: [] }), solisWarm());
    expect(withVerified.signals).toContain("verified_gc_on_project");
    expect(withVerified.signals).not.toContain("warm_gc_active");
    expect(withVerified.score).toBe(noOrg.score); // registry identity stays score-neutral
  });
});

describe("WS-B — gc_quality + trade_match are score-NEUTRAL signals (§12.3)", () => {
  const WANTED_TRADES = ["drywall", "painting"] as const;
  // The Solis account carrying its configured trades (from `capabilities`).
  const solisTrades = (): AccountScoringInput => ({ ...ACCOUNTS[2]!, trades: [...WANTED_TRADES] });
  const solisTi = (orgs: ProjectFeatures["orgs"]): ProjectFeatures =>
    features({
      text: "tenant improvement interior remodel drywall and paint suite 200",
      maxValuation: 250_000,
      stage: "permit_issued",
      orgs,
    });
  const route = (f: ProjectFeatures, acct: AccountScoringInput) =>
    routeProject(f, [acct]).find((r) => r.accountKey === "solis_interiors")!;

  // A GC whose Google Business profile clears the bar and whose L&I trade codes
  // intersect the account's configured trades.
  const QUALITY_GC = {
    name: "acme builders llc",
    role: "primary_contractor",
    registryRef: "bound-1",
    registryVerified: true,
    googleRating: 4.8,
    googleReviewCount: 50,
    tradeCodes: ["drywall"],
  };
  // The SAME GC minus the enriched contract fields — the neutrality baseline
  // (identical components; only the two new signals differ).
  const BARE_GC = {
    name: "acme builders llc",
    role: "primary_contractor",
    registryRef: "bound-1",
    registryVerified: true,
  };

  it("fires gc_quality + trade_match when the GC clears the bars", () => {
    const r = route(solisTi([QUALITY_GC]), solisTrades());
    expect(r.signals).toContain("gc_quality");
    expect(r.signals).toContain("trade_match");
  });

  it("does NOT move the score — signals only, no weight (the §12.3 invariant)", () => {
    const withSignals = route(solisTi([QUALITY_GC]), solisTrades());
    const baseline = route(solisTi([BARE_GC]), solisTrades());
    expect(withSignals.signals).toContain("gc_quality");
    expect(withSignals.signals).toContain("trade_match");
    expect(baseline.signals).not.toContain("gc_quality");
    expect(baseline.signals).not.toContain("trade_match");
    expect(withSignals.score).toBe(baseline.score);
  });

  it("gc_quality respects the rating + review-count floors", () => {
    const lowRating = { ...QUALITY_GC, googleRating: 3.9 };
    const fewReviews = { ...QUALITY_GC, googleReviewCount: 4 };
    expect(route(solisTi([lowRating]), solisTrades()).signals).not.toContain("gc_quality");
    expect(route(solisTi([fewReviews]), solisTrades()).signals).not.toContain("gc_quality");
  });

  it("trade_match needs a real intersection AND configured account trades", () => {
    const otherTrade = { ...QUALITY_GC, tradeCodes: ["roofing"] };
    expect(route(solisTi([otherTrade]), solisTrades()).signals).not.toContain("trade_match");
    // No configured trades on the account ⇒ never fires (frozen-eval safety).
    expect(route(solisTi([QUALITY_GC]), ACCOUNTS[2]!).signals).not.toContain("trade_match");
  });

  it("neither signal triggers on a non-GC role (e.g. architect)", () => {
    const architect = { ...QUALITY_GC, role: "architect" };
    const r = route(solisTi([architect]), solisTrades());
    expect(r.signals).not.toContain("gc_quality");
    expect(r.signals).not.toContain("trade_match");
  });
});
