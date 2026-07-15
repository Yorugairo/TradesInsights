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
      "lacey_project_pages",
      "lewis_issued_permits",
      "lewis_current_planning",
      "lewis_source_canary",
      "king_public_notices",
      "king_permit_reports",
      "seattle_building_permits",
      "seattle_land_use_permits",
      "seattle_source_canary",
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
