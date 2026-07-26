import { describe, expect, it } from "vitest";
import {
  distanceMeters,
  extractFeatures,
  isGenericName,
  laterStage,
  CONTAINMENT_MIN_DISTINCTIVE,
  isGovernmentOrgName,
  nameContainment,
  nameSimilarity,
  normalizeAddress,
  normalizeOrgName,
  normalizeParcel,
  orgNameKey,
  splitOrgNameAddress,
  stageOrder,
} from "./normalize.js";
import type { NormalizedSourceRecord } from "@otn/domain";

describe("normalizeAddress", () => {
  it("canonicalizes suffixes and directionals", () => {
    expect(normalizeAddress("3212 Northwest 69th Street")).toEqual({
      line: "3212 NW 69TH ST",
      city: null,
      zip: null,
    });
    expect(normalizeAddress("748 WILLIAMS ST, MOSSYROCK")).toEqual({
      line: "748 WILLIAMS ST",
      city: "MOSSYROCK",
      zip: null,
    });
  });

  it("splits city and zip from full addresses", () => {
    expect(normalizeAddress("41315 268TH AVE SE, ENUMCLAW, WA 98022")).toEqual({
      line: "41315 268TH AVE SE",
      city: "ENUMCLAW",
      zip: "98022",
    });
    expect(normalizeAddress("7434 Puget Beach RD NE, Olympia, WA 98516")).toEqual({
      line: "7434 PUGET BEACH RD NE",
      city: "OLYMPIA",
      zip: "98516",
    });
  });

  it("same physical address from two sources normalizes identically", () => {
    const a = normalizeAddress("3212 NW 69th St");
    const b = normalizeAddress("3212 Northwest 69TH Street");
    expect(a.line).toBe(b.line);
  });

  it("does not mistake unit designators for a city", () => {
    expect(normalizeAddress("100 MAIN ST STE 4").city).toBeNull();
  });
});

describe("normalizeParcel", () => {
  it("keeps digit runs of plausible APN length", () => {
    expect(normalizeParcel("1220069074")).toBe("1220069074");
    expect(normalizeParcel("11935210200")).toBe("11935210200");
    expect(normalizeParcel("008701036004")).toBe("008701036004");
    expect(normalizeParcel("12-70-32-10900")).toBe("12703210900");
  });
  it("rejects non-parcel strings", () => {
    expect(normalizeParcel("N/A")).toBeNull();
    expect(normalizeParcel("1234")).toBeNull();
  });
});

describe("normalizeOrgName / nameSimilarity", () => {
  it("strips legal suffixes into a comparison base", () => {
    expect(normalizeOrgName("Cole Remodeling & Const, LLC")).toEqual({
      canonical: "COLE REMODELING & CONST LLC",
      base: "COLE REMODELING CONST",
      hasLegalSuffix: true,
    });
    expect(normalizeOrgName("Resource Management Solutions, LLC").base).toBe(
      "RESOURCE MANAGEMENT SOLUTIONS",
    );
  });

  it("similar names score high; unrelated score low", () => {
    expect(nameSimilarity("Roamers RV Park Project", "Roamers RV Park")).toBeGreaterThan(0.7);
    expect(nameSimilarity("Roamers RV Park", "Seminary Hill Water Reservoir")).toBeLessThan(0.2);
  });

  it("does not treat an initial as noise — a one-word name is not a perfect match", () => {
    // Measured against live data: dropping single characters made these token
    // sets IDENTICAL, so each scored a perfect 1.00 and was reported as a
    // near-match that better matching could close. They are different firms.
    expect(nameSimilarity("CHARLES", "K C Charles Inc")).toBeLessThan(0.5);
    expect(nameSimilarity("HOUSE", "A-Z House LLC")).toBeLessThan(0.5);
    expect(nameSimilarity("N/A (RESIDENTIAL)", "J&w Residential LLC")).toBeLessThan(0.5);
    expect(nameSimilarity("HOWARD", "J Howard LLC")).toBeLessThan(0.6);
  });

  it("nameContainment matches a business that publishes its trade in only one system", () => {
    // Every one of these is a real pair from the near_match_fixable bucket that
    // exact-key matching cannot reach and Jaccard scores 0.75.
    for (const [org, registry] of [
      ["NEXT LEVEL ROOFING & CONSTRUCTION LLC", "Next Level Roofing"],
      ["WEST COAST ROOFING & SIDING", "West Coast Roofing LLC"],
      ["EMERALD CITY CONSTRUCTION & RENOVATIONS", "Emerald City Construction Inc"],
      ["FULL CIRCLE CONSTRUCTION SERVICES", "Full Circle Construction, LLC"],
      ["FIVE STAR PLUMBING & ROOTER", "Five Star Plumbing"],
    ] as const) {
      const r = nameContainment(org, registry);
      expect(r.contained, `${org} vs ${registry}`).toBe(true);
      expect(r.distinctive).toBeGreaterThanOrEqual(CONTAINMENT_MIN_DISTINCTIVE);
    }
    // Containment runs the other way just as well — the org name being the
    // SHORTER one is the same evidence, read from the other side.
    expect(nameContainment("SUN'S EYE SOLAR", "Sun'S Eye Solar Power LLC").direction).toBe(
      "org_in_registry",
    );
  });

  it("nameContainment stays conservative when only ONE word distinguishes", () => {
    // `COMFORT SYSTEMS NW` ⊂ `Comfort Systems Usa (Nw) Inc` is a true subset and
    // plausibly the same firm — but SYSTEMS and NW are generic, so COMFORT is
    // the only word doing identifying work. One is below the bar on purpose:
    // for a new binding rule, under-matching is recoverable and over-matching
    // writes a false identity. The pair stays visible in near_match_fixable.
    expect(nameContainment("COMFORT SYSTEMS NW", "Comfort Systems Usa (Nw) Inc").contained).toBe(false);
  });

  it("nameContainment refuses the near-misses that share the SAME 0.75 score", () => {
    // Not a subset either way — the distinguishing word differs (G vs PRO,
    // DICKEYS vs S&S). This is exactly what similarity alone cannot separate.
    expect(nameContainment("G & G HEATING & AIR CONDITIONING LLC", "Pro Heating & Air Conditioning").contained).toBe(false);
    expect(nameContainment("DICKEY'S REMODEL AND REPAIR", "S & S Remodel & Repair LLC").contained).toBe(false);
  });

  it("nameContainment refuses a subset built only from trade words", () => {
    // The failure mode this guard exists for: a subset on nothing that
    // identifies anybody. Half the registry is a construction services LLC.
    expect(nameContainment("ROOFING", "Acme Roofing LLC").contained).toBe(false);
    expect(nameContainment("CONSTRUCTION SERVICES", "Emerald Construction Services Inc").contained).toBe(false);
    expect(nameContainment("NW PLUMBING", "Seattle NW Plumbing LLC").contained).toBe(false);
  });

  it("nameContainment does not claim an EXACT match as a containment", () => {
    // Identical token sets belong to the exact-key rule; reporting them here
    // would double-count one piece of evidence under two rules.
    expect(nameContainment("Kliemann Bros Heating", "KLIEMANN BROS HEATING LLC").contained).toBe(false);
  });

  it("keeps a genuine match perfect when the initials appear on BOTH sides", () => {
    // The fix must not punish names that legitimately carry initials — the
    // tokens survive symmetrically, so these stay exact.
    expect(nameSimilarity("R&R FOUNDATION SPECIALIST", "R&r Foundation Specialist LLC")).toBe(1);
    expect(nameSimilarity("KLIEMANN BROS HEATING", "Kliemann Bros Heating")).toBe(1);
    // Word order is irrelevant to a set measure, and should stay that way.
    expect(nameSimilarity("TRANSFORMATIONS LLC EVERGREEN", "Evergreen Transformations LLC")).toBe(1);
  });

  it("flags generic names for review (spec §10)", () => {
    expect(isGenericName("Tenant Improvement")).toBe(true);
    expect(isGenericName("REROOF")).toBe(true);
    expect(isGenericName("New Single Family Residence")).toBe(true);
    expect(isGenericName("Fredrickson Townhomes")).toBe(false);
  });
});

describe("splitOrgNameAddress / orgNameKey", () => {
  it("splits a fused mailing address off the name", () => {
    const p = splitOrgNameAddress("ANDRZEJ TATKOWSKI 500 UNION STREET SUITE 410 SEATTLE WA 98101");
    expect(p.name).toBe("ANDRZEJ TATKOWSKI");
    expect(p.addressTail).toBe("500 UNION STREET SUITE 410 SEATTLE WA 98101");
  });

  it("splits at PO BOX", () => {
    const p = splitOrgNameAddress("COLE REMODELING LLC PO BOX 1234 OLYMPIA WA 98501");
    expect(p.name).toBe("COLE REMODELING LLC");
    expect(p.addressTail).toBe("PO BOX 1234 OLYMPIA WA 98501");
  });

  it("leaves orgs named after an address untouched (no leading name token)", () => {
    const p = splitOrgNameAddress("500 UNION STREET LLC");
    expect(p.addressTail).toBeNull();
    expect(p.name).toBe("500 UNION STREET LLC");
  });

  it("leaves numbers without street keywords untouched", () => {
    expect(splitOrgNameAddress("STUDIO 19 ARCHITECTS").addressTail).toBeNull();
    expect(splitOrgNameAddress("7 HILLS CONSTRUCTION INC").addressTail).toBeNull();
  });

  it("keys legal-suffix variants together, address-fused or not", () => {
    expect(orgNameKey("ABC Construction")).toBe(orgNameKey("ABC CONSTRUCTION, LLC"));
    expect(orgNameKey("ABC CONSTRUCTION LLC 100 MAIN ST TACOMA WA")).toBe(
      orgNameKey("abc construction"),
    );
    expect(orgNameKey("ABC Construction")).not.toBe(orgNameKey("XYZ Construction"));
  });

  it("falls back to the canonical form when stripping empties the name", () => {
    expect(orgNameKey("LLC")).toBe("LLC");
  });
});

describe("stage helpers", () => {
  it("orders the lifecycle and never advances via unknown/withdrawn", () => {
    expect(stageOrder("permit_issued")).toBeGreaterThan(stageOrder("entitlement"));
    expect(laterStage("entitlement", "permit_issued")).toBe("permit_issued");
    expect(laterStage("permit_issued", "unknown")).toBe("permit_issued");
    expect(laterStage("unknown", "entitlement")).toBe("entitlement");
    expect(laterStage("unknown", "withdrawn")).toBe("unknown");
  });
});

describe("distanceMeters", () => {
  it("computes plausible distances", () => {
    // Olympia to Lacey ≈ 6-8 km.
    const d = distanceMeters([-122.9007, 47.0379], [-122.8232, 47.0343]);
    expect(d).toBeGreaterThan(5000);
    expect(d).toBeLessThan(9000);
    expect(distanceMeters([-122.9, 47.0], [-122.9, 47.0])).toBe(0);
  });
});

describe("extractFeatures", () => {
  const record: NormalizedSourceRecord = {
    sourceKey: "lewis_current_planning",
    externalId: "SUP25-0002",
    recordType: "planning_application",
    title: "SUP25-0002 – Roamers RV Park Project",
    description: null,
    permittingJurisdiction: "Lewis County",
    county: "Lewis",
    city: null,
    addressRaw: "123 Example Rd, Chehalis, WA 98532",
    parcelIds: ["017820001002", "N/A"],
    geometry: { type: "Point", coordinates: [-122.9, 46.6] },
    applicationType: "Special Use",
    permitType: null,
    documentType: null,
    statusRaw: "under review",
    normalizedStage: "entitlement",
    applicationDate: null,
    issueDate: null,
    sourceUpdatedAt: null,
    valuationUsd: null,
    units: null,
    lots: null,
    squareFeet: null,
    organizations: [
      { name: "Roamers RV LLC", role: "applicant", evidenceText: "x" },
      { name: "Lewis County", role: "lead_agency", evidenceText: "x" },
    ],
    sourceUrl: "https://example.gov/x",
    evidence: [],
  };

  it("collects reference ids, parcels, address, orgs, and point", () => {
    const f = extractFeatures(record, { fileNumbers: ["SUP25-0002", "SEP25-0011"] });
    expect(f.externalId).toBe("SUP25-0002");
    expect(f.referenceIds).toEqual(["SEP25-0011"]); // own id excluded
    expect(f.parcels).toEqual(["017820001002"]); // N/A dropped
    expect(f.address?.line).toBe("123 EXAMPLE RD");
    expect(f.orgBases).toEqual(["ROAMERS RV"]); // lead agencies excluded
    expect(f.point).toEqual([-122.9, 46.6]);
    expect(f.generic).toBe(false);
  });

  it("flags generic titles after stripping the id prefix", () => {
    const f = extractFeatures(
      { ...record, title: "B26-00607 – REROOF" },
      {},
    );
    expect(f.generic).toBe(true);
  });
});

describe("isGovernmentOrgName (public bodies are not contractors)", () => {
  it("catches the live false positives the containment rule produced", () => {
    // Each of these matched a business carrying the same PLACE name.
    expect(isGovernmentOrgName("CITY OF LAKEWOOD")).toBe(true);
    expect(isGovernmentOrgName("LAKEWOOD CITY OF")).toBe(true);
    expect(isGovernmentOrgName("THURSTON COUNTY")).toBe(true);
  });

  it("catches the other public shapes permit data uses", () => {
    for (const n of [
      "BELLEVUE SCHOOL DISTRICT",
      "PORT OF SEATTLE",
      "KING COUNTY HOUSING AUTHORITY",
      "CITY OF TUMWATER PUBLIC WORKS",
      "DEPARTMENT OF TRANSPORTATION",
      "PIERCE COUNTY FIRE DISTRICT",
    ]) {
      expect(isGovernmentOrgName(n), n).toBe(true);
    }
  });

  it("does NOT catch a business that merely carries a place name", () => {
    // The whole point of testing the ORG side only: these are real contractors
    // and must keep matching normally.
    for (const n of [
      "Thurston County Cement Fnshrs",
      "Lakewood City Glass Inc",
      "Port Townsend Plumbing LLC",
      "University Mechanical Contractors",
    ]) {
      expect(isGovernmentOrgName(n), n).toBe(false);
    }
  });
});
