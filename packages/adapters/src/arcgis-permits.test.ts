import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NormalizedSourceRecordSchema } from "@otn/domain";
import type { RawArtifact } from "@otn/source-sdk";
import {
  ArcgisPermitsAdapter,
  BELLEVUE_CONFIG,
  SPOKANE_CONFIG,
  bellevueStage,
  spokaneStage,
  type ArcgisPermitsConfig,
} from "./arcgis-permits.js";
import { FIXTURES_DIR, testContext } from "./test-utils.js";

function rawArtifact(body: Buffer | string): RawArtifact {
  return {
    discovered: {
      idempotencyKey: "test:arcgis",
      canonicalUrl: "https://services1.arcgis.com/x/query",
      parentUrl: null,
      expectedContentType: "application/json",
      sourcePublishedAt: null,
    },
    body: Buffer.isBuffer(body) ? body : Buffer.from(body),
    contentType: "application/json",
    httpStatus: 200,
    headers: {},
    retrievedAt: new Date("2026-07-22T00:00:00Z"),
  };
}

/** A synthetic King-county config exercising the generic engine — NOT a shipped
 * city (real cities are onboarded in Task 2 with live-verified fields + real
 * fixtures). Epoch dates, a valuation with a fallback column, applicant org. */
function stageFor(status: string | null): ReturnType<ArcgisPermitsConfig["stageFor"]> {
  const s = (status ?? "").trim().toLowerCase();
  if (!s) return "unknown";
  if (/(cancel|void|denied|expired|withdrawn)/.test(s)) return "withdrawn";
  if (/(finaled|closed|complete|c of o)/.test(s)) return "complete";
  if (/issued/.test(s)) return "permit_issued";
  if (/approved/.test(s)) return "approved";
  if (/(applied|review|pending|intake|submitted)/.test(s)) return "permit_applied";
  return "unknown";
}

const TEST_CONFIG: ArcgisPermitsConfig = {
  key: "arcgis_permits_test",
  layerUrl:
    "https://services1.arcgis.com/EYzEZbDhXZjURPbP/arcgis/rest/services/Test_Permits/FeatureServer/0",
  landingUrl: "https://example.gov/opendata",
  pageSize: 2000,
  county: "King",
  jurisdiction: "City of Testville",
  city: "Testville",
  fields: {
    externalId: "PermitNum",
    permitType: "PermitType",
    status: "Status",
    description: "Description",
    address: ["Address", "City"],
    valuation: ["Valuation", "JobValue"],
    units: "Units",
    applied: "AppliedDate",
    issued: "IssuedDate",
    parcel: "ParcelNo",
    applicant: "ContractorName",
    sourceUrl: "PermitURL",
    externalRef: "GlobalID",
  },
  dateKind: "epoch",
  windowField: "AppliedDate",
  windowFieldSecondary: "IssuedDate",
  externalRefLabel: "GlobalID",
  stageFor,
};

const APPLIED_MS = Date.UTC(2026, 5, 1); // 2026-06-01
const ISSUED_MS = Date.UTC(2026, 5, 15); // 2026-06-15

function goldenFeatures() {
  return {
    features: [
      {
        attributes: {
          PermitNum: "BLD-2026-0001",
          PermitType: "Commercial TI",
          Status: "Issued",
          Description: "Tenant improvement — office suite 400",
          Address: "123 Main St",
          City: "Testville",
          Valuation: 250000,
          JobValue: 0,
          Units: 0,
          AppliedDate: APPLIED_MS,
          IssuedDate: ISSUED_MS,
          ParcelNo: "1234567890",
          ContractorName: "Acme Interiors LLC",
          PermitURL: "https://example.gov/permit/BLD-2026-0001?a=1&amp;b=2",
          GlobalID: "{ABC-123}",
        },
        geometry: { x: -122.2, y: 47.6 },
      },
      {
        attributes: {
          PermitNum: "BLD-2026-0002",
          PermitType: "New Multifamily",
          Status: "Applied",
          Description: "New 12-unit apartment",
          Address: "500 2nd Ave",
          City: "Testville",
          // no Valuation column value; JobValue fallback carries it
          Valuation: 0,
          JobValue: 4200000,
          Units: 12,
          AppliedDate: APPLIED_MS,
          IssuedDate: null,
          ParcelNo: null,
          ContractorName: null,
          PermitURL: null,
          GlobalID: "{DEF-456}",
        },
        // no geometry object → lat/lng fallback unused (none configured here) → null
      },
    ],
  };
}

describe("arcgis-permits generic adapter", () => {
  it("parses features into valid normalized records with config-driven fields", async () => {
    const adapter = new ArcgisPermitsAdapter(TEST_CONFIG);
    const parsed = await adapter.parse(
      rawArtifact(JSON.stringify(goldenFeatures())),
      testContext(adapter.key),
    );
    expect(parsed.length).toBe(2);
    for (const p of parsed) {
      const v = NormalizedSourceRecordSchema.safeParse(p.record);
      expect(v.success, JSON.stringify(v.success ? null : v.error.issues)).toBe(true);
      expect(p.record.county).toBe("King");
      expect(p.record.permittingJurisdiction).toBe("City of Testville");
    }

    const first = parsed[0]!.record;
    expect(first.externalId).toBe("BLD-2026-0001");
    expect(first.normalizedStage).toBe("permit_issued");
    expect(first.valuationUsd).toBe(250000);
    expect(first.applicationDate).toBe("2026-06-01");
    expect(first.issueDate).toBe("2026-06-15");
    expect(first.addressRaw).toBe("123 Main St, Testville");
    expect(first.geometry).toEqual({ type: "Point", coordinates: [-122.2, 47.6] });
    expect(first.organizations[0]).toMatchObject({ name: "Acme Interiors LLC", role: "applicant" });
    // &amp; in the link is decoded
    expect(first.sourceUrl).toBe("https://example.gov/permit/BLD-2026-0001?a=1&b=2");
    // externalRef rides in evidence + rawFields, never on an org
    expect(first.evidence.some((e) => e.factPath === "externalRef" && e.text.includes("{ABC-123}"))).toBe(true);
  });

  it("takes the first positive valuation across fallback columns; 0 ⇒ null, never $0", async () => {
    const adapter = new ArcgisPermitsAdapter(TEST_CONFIG);
    const parsed = await adapter.parse(
      rawArtifact(JSON.stringify(goldenFeatures())),
      testContext(adapter.key),
    );
    // second row: Valuation=0 → fall through to JobValue=4200000
    expect(parsed[1]!.record.valuationUsd).toBe(4200000);
    expect(parsed[1]!.record.units).toBe(12);
    expect(parsed[1]!.record.issueDate).toBeNull();
    expect(parsed[1]!.record.normalizedStage).toBe("permit_applied");
  });

  it("emits a runner-rejectable record for a feature missing the externalId field", async () => {
    const adapter = new ArcgisPermitsAdapter(TEST_CONFIG);
    const parsed = await adapter.parse(
      rawArtifact(JSON.stringify({ features: [{ attributes: { Description: "no permit number" } }] })),
      testContext(adapter.key),
    );
    expect(parsed.length).toBe(1);
    expect(NormalizedSourceRecordSchema.safeParse(parsed[0]!.record).success).toBe(false);
  });

  it("falls back to lat/lng columns for geometry when no geometry object is present", async () => {
    const cfg: ArcgisPermitsConfig = {
      ...TEST_CONFIG,
      fields: { ...TEST_CONFIG.fields, lat: "Lat", lng: "Lng" },
    };
    const adapter = new ArcgisPermitsAdapter(cfg);
    const parsed = await adapter.parse(
      rawArtifact(
        JSON.stringify({
          features: [
            {
              attributes: {
                PermitNum: "BLD-2026-0003",
                Status: "Approved",
                AppliedDate: APPLIED_MS,
                Lat: 47.61,
                Lng: -122.33,
              },
            },
          ],
        }),
      ),
      testContext(adapter.key),
    );
    expect(parsed[0]!.record.geometry).toEqual({ type: "Point", coordinates: [-122.33, 47.61] });
    expect(parsed[0]!.record.normalizedStage).toBe("approved");
  });

  it("decodes ISO and string date kinds", async () => {
    for (const kind of ["iso", "string"] as const) {
      const cfg: ArcgisPermitsConfig = { ...TEST_CONFIG, dateKind: kind };
      const adapter = new ArcgisPermitsAdapter(cfg);
      const parsed = await adapter.parse(
        rawArtifact(
          JSON.stringify({
            features: [
              {
                attributes: {
                  PermitNum: "BLD-2026-0004",
                  Status: "Issued",
                  AppliedDate: kind === "iso" ? "2026-06-01T00:00:00Z" : "06/01/2026",
                  IssuedDate: kind === "iso" ? "2026-06-15T00:00:00Z" : "06/15/2026",
                },
                geometry: { x: -122.2, y: 47.6 },
              },
            ],
          }),
        ),
        testContext(adapter.key),
      );
      expect(parsed[0]!.record.applicationDate).toBe("2026-06-01");
      expect(parsed[0]!.record.issueDate).toBe("2026-06-15");
    }
  });

  it("degrades an unmapped status to unknown, never a guess", async () => {
    const adapter = new ArcgisPermitsAdapter(TEST_CONFIG);
    const parsed = await adapter.parse(
      rawArtifact(
        JSON.stringify({
          features: [
            {
              attributes: {
                PermitNum: "BLD-2026-0005",
                Status: "Some Brand New Status",
                AppliedDate: APPLIED_MS,
              },
              geometry: { x: -122.2, y: 47.6 },
            },
          ],
        }),
      ),
      testContext(adapter.key),
    );
    expect(parsed[0]!.record.normalizedStage).toBe("unknown");
    expect(parsed[0]!.record.statusRaw).toBe("Some Brand New Status");
  });

  it("is idempotent — same bytes twice produce identical records", async () => {
    const adapter = new ArcgisPermitsAdapter(TEST_CONFIG);
    const body = JSON.stringify(goldenFeatures());
    const a = await adapter.parse(rawArtifact(body), testContext(adapter.key));
    const b = await adapter.parse(rawArtifact(body), testContext(adapter.key));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("checkInvariants is empty on the golden fixture and flags an out-of-range valuation", async () => {
    const adapter = new ArcgisPermitsAdapter(TEST_CONFIG);
    const golden = await adapter.parse(rawArtifact(JSON.stringify(goldenFeatures())), testContext(adapter.key));
    expect(adapter.checkInvariants(rawArtifact("{}"), golden)).toEqual([]);

    // a valuation above the ceiling ⇒ a violation (a swapped column)
    const bad = await adapter.parse(
      rawArtifact(
        JSON.stringify({
          features: [
            {
              attributes: {
                PermitNum: "BLD-2026-9999",
                Status: "Issued",
                Valuation: 9_000_000_000,
                AppliedDate: APPLIED_MS,
              },
              geometry: { x: -122.2, y: 47.6 },
            },
          ],
        }),
      ),
      testContext(adapter.key),
    );
    const violations = adapter.checkInvariants(rawArtifact("{}"), bad);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]!.check).toBe("arcgis_permits_test_valuation_range");
  });
});

describe("bellevue_permits_arcgis (golden fixture — live window of 2026-07-22)", () => {
  it("parses every real Bellevue feature into a valid King-county record", async () => {
    const adapter = new ArcgisPermitsAdapter(BELLEVUE_CONFIG);
    const body = await readFile(join(FIXTURES_DIR, "bellevue_permits_arcgis/window-page-1.json"));
    const parsed = await adapter.parse(rawArtifact(body), testContext(adapter.key));

    expect(parsed.length).toBe(285); // manual count comparison, fixture metadata
    for (const p of parsed) {
      const v = NormalizedSourceRecordSchema.safeParse(p.record);
      expect(v.success, JSON.stringify(v.success ? null : v.error.issues)).toBe(true);
      expect(p.record.county).toBe("King");
      expect(p.record.permittingJurisdiction).toBe("City of Bellevue");
      expect(p.record.city).toBe("Bellevue");
    }

    // CONTRACTOR is populated on every row — the primary trades signal.
    const withContractor = parsed.filter((p) => p.record.organizations.length > 0);
    expect(withContractor.length).toBe(285);
    for (const p of withContractor) {
      expect(p.record.organizations[0]!.role).toBe("primary_contractor");
      expect(p.record.evidence.some((e) => e.factPath === "organizations")).toBe(true);
    }

    // Most rows carry a WGS84 point; a few honestly lack geometry (null, not faked).
    const withGeom = parsed.filter((p) => p.record.geometry?.type === "Point");
    expect(withGeom.length).toBe(280);
    const lons = withGeom.map((p) => (p.record.geometry!.coordinates as [number, number])[0]);
    expect(Math.min(...lons)).toBeGreaterThan(-122.3); // Bellevue bounds
    expect(Math.max(...lons)).toBeLessThan(-122.0);
  });

  it("maps Bellevue statuses to §9 stages; Issued gets an issue date, pre-issuance does not", async () => {
    const adapter = new ArcgisPermitsAdapter(BELLEVUE_CONFIG);
    const body = await readFile(join(FIXTURES_DIR, "bellevue_permits_arcgis/window-page-1.json"));
    const parsed = await adapter.parse(rawArtifact(body), testContext(adapter.key));

    const issued = parsed.filter((p) => p.record.statusRaw === "Issued");
    expect(issued.length).toBeGreaterThan(0);
    for (const p of issued) {
      expect(p.record.normalizedStage).toBe("permit_issued");
      expect(p.record.issueDate).not.toBeNull();
    }
    const pending = parsed.filter((p) =>
      ["Open", "Completeness Check", "Screening", "Pending"].includes(p.record.statusRaw ?? ""),
    );
    expect(pending.length).toBeGreaterThan(0);
    for (const p of pending) {
      expect(p.record.normalizedStage).toBe("permit_applied");
      expect(p.record.issueDate).toBeNull();
    }
  });

  it("stageFor covers the full live vocabulary; unknown degrades, never guessed", () => {
    expect(bellevueStage("Issued")).toBe("permit_issued");
    // "Completeness Check" is an intake step — must NOT be misread as "complete".
    expect(bellevueStage("Completeness Check")).toBe("permit_applied");
    expect(bellevueStage("Finaled")).toBe("complete");
    expect(bellevueStage("Canceled")).toBe("withdrawn");
    expect(bellevueStage("Expired")).toBe("withdrawn");
    expect(bellevueStage("Accepted")).toBe("permit_applied");
    expect(bellevueStage("Appealed")).toBe("permit_applied");
    expect(bellevueStage("Some Brand New Status")).toBe("unknown");
    expect(bellevueStage(null)).toBe("unknown");
  });

  it("checkInvariants reconciles clean on the golden Bellevue fixture", async () => {
    const adapter = new ArcgisPermitsAdapter(BELLEVUE_CONFIG);
    const body = await readFile(join(FIXTURES_DIR, "bellevue_permits_arcgis/window-page-1.json"));
    const parsed = await adapter.parse(rawArtifact(body), testContext(adapter.key));
    expect(adapter.checkInvariants(rawArtifact("{}"), parsed)).toEqual([]);
  });
});

describe("spokane_permits_arcgis (golden fixture — live window of 2026-07-23)", () => {
  async function parseSpokane() {
    const adapter = new ArcgisPermitsAdapter(SPOKANE_CONFIG);
    const body = await readFile(join(FIXTURES_DIR, "spokane_permits_arcgis/window-page-1.json"));
    return { adapter, parsed: await adapter.parse(rawArtifact(body), testContext(adapter.key)) };
  }

  it("parses every real Spokane feature into a valid Spokane-county record", async () => {
    const { parsed } = await parseSpokane();
    expect(parsed.length).toBe(324); // manual count comparison, fixture metadata
    for (const p of parsed) {
      const v = NormalizedSourceRecordSchema.safeParse(p.record);
      expect(v.success, JSON.stringify(v.success ? null : v.error.issues)).toBe(true);
      expect(p.record.county).toBe("Spokane");
      expect(p.record.permittingJurisdiction).toBe("City of Spokane");
    }
    // 100% geometry coverage, inside eastern-WA bounds (not Puget Sound).
    const withGeom = parsed.filter((p) => p.record.geometry?.type === "Point");
    expect(withGeom.length).toBe(324);
    const lons = withGeom.map((p) => (p.record.geometry!.coordinates as [number, number])[0]);
    expect(Math.min(...lons)).toBeGreaterThan(-117.6);
    expect(Math.max(...lons)).toBeLessThan(-117.2);
  });

  it("maps the live Spokane status vocabulary to §9 stages", async () => {
    const { parsed } = await parseSpokane();
    const stages = parsed.reduce<Record<string, number>>((acc, p) => {
      acc[p.record.normalizedStage] = (acc[p.record.normalizedStage] ?? 0) + 1;
      return acc;
    }, {});
    expect(stages).toEqual({ permit_issued: 265, complete: 15, permit_applied: 39, approved: 5 });
  });

  it("carries no party and no issue date — Spokane publishes neither, so both stay empty", async () => {
    const { parsed } = await parseSpokane();
    // No contractor/applicant column exists: an org is never invented.
    expect(parsed.every((p) => p.record.organizations.length === 0)).toBe(true);
    // Spokane publishes no issued-date column, so issueDate is honestly null even
    // for status "Issued" — the stage carries that fact, a fabricated date does not.
    expect(parsed.every((p) => p.record.issueDate === null)).toBe(true);
    // Valuation/units are absent from the layer ⇒ null, never 0.
    expect(parsed.every((p) => p.record.valuationUsd === null && p.record.units === null)).toBe(true);
    // The Accela cross-system id rides in evidence only, never as a party key.
    expect(parsed.every((p) => p.record.evidence.some((e) => e.factPath === "externalRef"))).toBe(true);
  });

  it("stageFor covers the full live vocabulary; unknown degrades, never guessed", () => {
    expect(spokaneStage("Issued")).toBe("permit_issued");
    expect(spokaneStage("Finaled")).toBe("complete");
    expect(spokaneStage("Closed")).toBe("complete");
    // "…Approved" is a favorable pre-issuance decision, not a bare review step.
    expect(spokaneStage("Plan Review Approved")).toBe("approved");
    expect(spokaneStage("Application Approved")).toBe("approved");
    expect(spokaneStage("Plan Review")).toBe("permit_applied");
    expect(spokaneStage("In Progress")).toBe("permit_applied");
    expect(spokaneStage("Revisions Required")).toBe("permit_applied");
    expect(spokaneStage("Some Brand New Status")).toBe("unknown");
    expect(spokaneStage(null)).toBe("unknown");
  });

  it("checkInvariants reconciles clean on the golden Spokane fixture", async () => {
    const { adapter, parsed } = await parseSpokane();
    expect(adapter.checkInvariants(rawArtifact("{}"), parsed)).toEqual([]);
  });
});
