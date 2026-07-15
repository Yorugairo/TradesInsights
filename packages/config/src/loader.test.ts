import { describe, expect, it } from "vitest";
import { getSourceConfig, loadAccountProfiles, loadSourcesConfig } from "./loader.js";

describe("sources.yaml", () => {
  it("parses and validates", () => {
    const file = loadSourcesConfig();
    expect(file.sources.length).toBeGreaterThan(0);
  });

  it("only fake_source is enabled before activation checklists pass", () => {
    const file = loadSourcesConfig();
    const enabled = file.sources.filter((s) => s.enabled).map((s) => s.key);
    expect(enabled).toEqual(["fake_source"]);
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
