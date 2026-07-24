import { describe, expect, it } from "vitest";
import { corroborateEntities, lniVerifyUrl, middleInitial } from "./entity-corroboration.js";
import type { RegistryIdentityRow } from "./registry-link.js";

const row = (over: Partial<RegistryIdentityRow>): RegistryIdentityRow => ({
  entityId: "e",
  ubi: null,
  contractorNumbers: null,
  canonicalName: "Co",
  canonicalNameNormalized: "CO",
  phone: null,
  cityToken: null,
  stateCode: "WA",
  registeredAddress: null,
  registeredPostalCode: null,
  ...over,
});

describe("middleInitial", () => {
  it("reads the initial out of a registry key", () => {
    expect(middleInitial("MOORE, MICHAEL L")).toBe("L");
    expect(middleInitial("ERDAHL, DARRIN P")).toBe("P");
  });
  it("is null when the key carries no middle name or is not person-shaped", () => {
    expect(middleInitial("MOORE, MICHAEL")).toBeNull();
    expect(middleInitial("CT CORPORATION SYSTEM")).toBeNull();
    expect(middleInitial(null)).toBeNull();
  });
});

describe("corroborateEntities", () => {
  // The live case the reviewer asked about: Moore Furniture Inc (Ephrata WA,
  // 509 number) vs Gill Group Inc (Crofton MD, 410 number).
  const mooreFurniture = row({
    entityId: "mf", canonicalName: "Moore Furniture Inc", ubi: "132001856",
    phone: "5097543231", googlePhone: "(509) 754-3231", registeredAddress: "PO BOX 428",
    registeredPostalCode: "98823", cityToken: "ephrata", tradeCodes: ["flooring"],
  });
  const gillGroup = row({
    entityId: "gg", canonicalName: "Gill Group Inc", ubi: "602898317",
    phone: "4104514600", registeredAddress: "2128 ESPEY CT 7",
    registeredPostalCode: "21114", cityToken: "crofton",
  });

  it("returns ZERO evidence points and a contradiction for the Moore case", () => {
    const c = corroborateEntities(mooreFurniture, gillGroup, "MOORE, MICHAEL F", "MOORE, MICHAEL L");
    expect(c.points).toBe(0);
    expect(c.verdict).toBe("contradicted");
    expect(c.signals.filter((s) => !s.agrees).map((s) => s.key)).toEqual(["middle_initial"]);
    expect(c.explanation).toContain("DIFFERENT middle initials — F vs L");
  });

  it("reports name-only when nothing agrees and nothing contradicts", () => {
    const c = corroborateEntities(
      row({ entityId: "a", cityToken: "tacoma" }),
      row({ entityId: "b", cityToken: "spokane" }),
    );
    expect(c.points).toBe(0);
    expect(c.verdict).toBe("name_only");
    expect(c.explanation).toContain("Nothing links these two companies");
  });

  it("counts each independent agreeing field once", () => {
    const a = row({ entityId: "a", phone: "2535550100", registeredPostalCode: "98402",
                    cityToken: "tacoma", tradeCodes: ["hvac", "electrical"] });
    const b = row({ entityId: "b", phone: "(253) 555-0100", registeredPostalCode: "98402",
                    cityToken: "tacoma", tradeCodes: ["hvac"] });
    const c = corroborateEntities(a, b, "SMITH, JOHN A", "SMITH, JOHN A");
    // middle initial + phone + postal + city + trade
    expect(c.points).toBe(5);
    expect(c.verdict).toBe("strong");
    expect(c.signals.map((s) => s.key)).toEqual([
      "middle_initial", "phone", "postal_code", "city", "trade",
    ]);
  });

  it("compares phones on digits alone, so L&I and Google formats agree", () => {
    const c = corroborateEntities(
      row({ entityId: "a", phone: "5097543231" }),
      row({ entityId: "b", phone: "(509) 754-3231" }),
    );
    expect(c.signals.find((s) => s.key === "phone")?.agrees).toBe(true);
  });

  it("does not double-count a Google phone that merely restates the L&I phone", () => {
    const same = { phone: "2535550100", googlePhone: "(253) 555-0100" };
    const c = corroborateEntities(row({ entityId: "a", ...same }), row({ entityId: "b", ...same }));
    expect(c.signals.map((s) => s.key)).toEqual(["phone"]);
    expect(c.points).toBe(1);
  });

  it("credits a Google phone that is genuinely a second number", () => {
    const c = corroborateEntities(
      row({ entityId: "a", phone: "2535550100", googlePhone: "2535559999" }),
      row({ entityId: "b", phone: "2535550100", googlePhone: "2535559999" }),
    );
    expect(c.signals.map((s) => s.key)).toEqual(["phone", "google_phone"]);
  });

  it("treats state as conflict-only — agreement on WA proves nothing", () => {
    const agree = corroborateEntities(row({ entityId: "a" }), row({ entityId: "b" }));
    expect(agree.signals.some((s) => s.key === "state")).toBe(false);
    const differ = corroborateEntities(
      row({ entityId: "a", stateCode: "WA" }),
      row({ entityId: "b", stateCode: "MD" }),
    );
    expect(differ.signals.find((s) => s.key === "state")?.agrees).toBe(false);
  });

  it("ignores fields that are null on either side rather than counting a match", () => {
    const c = corroborateEntities(
      row({ entityId: "a", phone: null, cityToken: null }),
      row({ entityId: "b", phone: null, cityToken: null }),
    );
    expect(c.points).toBe(0);
  });
});

describe("lniVerifyUrl", () => {
  // Byte-identical to the link the owner pasted from L&I on 2026-07-23 —
  // `*` is a sub-delimiter, so URLSearchParams correctly leaves it unencoded.
  it("builds the public L&I verification link from UBI and licence", () => {
    expect(lniVerifyUrl({ ubi: "601837949", contractorNumbers: ["RESCUR*007Q7"] })).toBe(
      "https://secure.lni.wa.gov/verify/Detail.aspx?UBI=601837949&LIC=RESCUR*007Q7&SAW=false",
    );
  });
  it("omits the licence when the entity has none", () => {
    expect(lniVerifyUrl({ ubi: "601837949" })).toBe(
      "https://secure.lni.wa.gov/verify/Detail.aspx?UBI=601837949&SAW=false",
    );
  });
  it("returns null rather than a guessed link when there is no UBI", () => {
    expect(lniVerifyUrl({ ubi: null, contractorNumbers: ["ABC123"] })).toBeNull();
  });
});
