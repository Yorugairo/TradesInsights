import { describe, expect, it } from "vitest";
import { getSourceConfig, loadAccountProfiles, loadSourcesConfig } from "./loader.js";

describe("sources.yaml", () => {
  it("parses and validates", () => {
    const file = loadSourcesConfig();
    expect(file.sources.length).toBeGreaterThan(0);
  });

  it("every enabled source has passed the activation checklist (review dates set)", () => {
    const file = loadSourcesConfig();
    for (const s of file.sources.filter((x) => x.enabled)) {
      expect(s.terms_reviewed_at, `${s.key} missing terms_reviewed_at`).toBeTruthy();
      expect(s.robots_reviewed_at, `${s.key} missing robots_reviewed_at`).toBeTruthy();
    }
  });

  it("enabled sources are exactly the activated set", () => {
    const file = loadSourcesConfig();
    const enabled = file.sources.filter((s) => s.enabled).map((s) => s.key);
    // Grows only when an M1 activation checklist completes (docs/source-policy.md ledger).
    expect(enabled).toEqual([
      "fake_source",
      "lacey_projects_rest",
      "customer_bid_inbox_solis", // customer authorization received 2026-07-17
      "lacey_permit_reports",
      "lacey_project_pages",
      "thurston_active_notices",
      "tumwater_development_arcgis",
      "bellevue_permits_arcgis", // activated 2026-07-22 (Wave3 Puget Sound densification; King #2 job market, generic ArcgisPermitsAdapter)
      "everett_permits_socrata", // activated 2026-07-23 (Wave3; first genuine Snohomish source, generic SocrataPermitsAdapter, contractor on ~94%)
      // spokane_permits_arcgis — activated 2026-07-23, DEACTIVATED 2026-07-27.
      // services.spokanegis.org blocks our user agent with a self-redirect
      // loop (200 with a browser UA, 302-to-itself with ours; no robots.txt).
      // Three runs, three failures, zero records ever. Not worked around by
      // spoofing the UA — that is evading a deliberate block.
      "pierce_permits_arcgis", // activated 2026-07-17 (Batch2 #1, ledger entry)
      "pierce_pals_contractor", // activated 2026-07-24 — capture-fed hydration, owner-approved scale (queue-cockpit Phase A0)
      "olympia_smartgov_reports", // activated 2026-07-20 (capture-ready Exago PDF; Thurston-metro P1 permit-stage gap; on_demand capture-fed)
      "puyallup_permits_arcgis", // activated 2026-07-17 (suburb-city SFR track, ledger entry)
      "tacoma_permits_arcgis", // activated 2026-07-17 (Batch3 #3, ledger entry)
      "tacoma_solicitations", // activated 2026-07-17 (P5, ledger entry)
      "tumwater_development_review", // activated 2026-07-20 (operator-local capture-fed; on_demand, never cloud-scheduled)
      "tumwater_sepa", // activated 2026-07-20 (operator-local capture-fed; on_demand, never cloud-scheduled)
      "lewis_issued_permits",
      "centralia_permit_reports", // activated 2026-07-18 (suburb-city SFR track, ledger entry)
      "lewis_inspections",
      "lewis_current_planning",
      "lewis_source_canary",
      "king_public_notices",
      "king_permit_reports",
      "seattle_building_permits",
      "seattle_land_use_permits",
      "seattle_source_canary",
      "wa_sepa",
    ]);
  });

  it("getSourceConfig throws on unknown key", () => {
    expect(() => getSourceConfig("nope_source")).toThrow(/unknown source key/);
  });
});

describe("account-profiles.yaml", () => {
  it("parses, validates, and weights total 100", () => {
    const file = loadAccountProfiles();
    expect(file.accounts.map((a) => a.key).sort()).toEqual([
      "lacey_glass_at_home",
      "lacey_glass_commercial",
      "solis_interiors",
    ]);
  });

  it("Solis excludes the closed UBI and King is excluded for At Home", () => {
    const file = loadAccountProfiles();
    const solis = file.accounts.find((a) => a.key === "solis_interiors")!;
    expect(solis.organization.excluded_ubis).toContain("604701295");
    const atHome = file.accounts.find((a) => a.key === "lacey_glass_at_home")!;
    expect(atHome.territory.counties_excluded).toContain("King");
  });
});
