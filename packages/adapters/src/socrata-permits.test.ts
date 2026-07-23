import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NormalizedSourceRecordSchema } from "@otn/domain";
import type { RawArtifact } from "@otn/source-sdk";
import {
  SocrataPermitsAdapter,
  AUBURN_CONFIG,
  EVERETT_CONFIG,
  auburnStage,
  everettStage,
  type SocrataPermitsConfig,
} from "./socrata-permits.js";
import { FIXTURES_DIR, testContext } from "./test-utils.js";

function rawArtifact(body: Buffer | string): RawArtifact {
  return {
    discovered: {
      idempotencyKey: "test:socrata",
      canonicalUrl: "https://data.example.gov/resource/abcd-efgh.json",
      parentUrl: null,
      expectedContentType: "application/json",
      sourcePublishedAt: null,
    },
    body: Buffer.isBuffer(body) ? body : Buffer.from(body),
    contentType: "application/json",
    httpStatus: 200,
    headers: {},
    retrievedAt: new Date("2026-07-23T00:00:00Z"),
  };
}

/** A synthetic config exercising the generic engine — NOT a shipped dataset
 * (real cities are onboarded below with live-verified fields + real fixtures). */
const TEST_CONFIG: SocrataPermitsConfig = {
  key: "socrata_permits_test",
  domain: "data.example.gov",
  datasetId: "abcd-efgh",
  county: "King",
  jurisdiction: "City of Testville",
  city: "Testville",
  fields: {
    externalId: "permitno",
    permitType: "permittype",
    permitSubtype: "permitsubtype",
    status: "status",
    description: "permitdesc",
    address: ["siteaddress", "sitecity"],
    valuation: ["jobvalue", "estcost"],
    units: "housingunits",
    applied: "applieddate",
    approved: "approveddate",
    issued: "issueddate",
    parcel: "siteapn",
    contractor: "contractorname",
    geocodedColumn: "geocoded_column",
  },
  stageFor: ({ status, hasIssued, hasApproved }) => {
    const s = (status ?? "").toLowerCase();
    if (/void|withdrawn/.test(s)) return "withdrawn";
    if (hasIssued) return "permit_issued";
    if (hasApproved) return "approved";
    return "permit_applied";
  },
};

function goldenRows() {
  return [
    {
      permitno: "B2607-001",
      permittype: "BUILDING",
      permitsubtype: "COMM ALT",
      status: "OPEN",
      permitdesc: "Tenant improvement — suite 400",
      siteaddress: "123 Main St",
      sitecity: "Testville",
      jobvalue: "250000",
      estcost: "0",
      housingunits: "0",
      applieddate: "2026-06-01T00:00:00.000",
      approveddate: "2026-06-05T00:00:00.000",
      issueddate: "2026-06-15T00:00:00.000",
      siteapn: "1234567890",
      contractorname: "ACME INTERIORS LLC",
      geocoded_column: { type: "Point", coordinates: [-122.2, 47.6] },
    },
    {
      permitno: "B2607-002",
      permittype: "BUILDING",
      permitsubtype: "RES NEW",
      status: "OPEN",
      permitdesc: "New 12-unit apartment",
      siteaddress: "500 2nd Ave",
      sitecity: "Testville",
      // jobvalue 0 ⇒ fall through to estcost
      jobvalue: "0",
      estcost: "4200000",
      housingunits: "12",
      applieddate: "2026-06-02T00:00:00.000",
      siteapn: "9876543210",
      // a placeholder party — must be dropped, never emitted as an org
      contractorname: "CONTRACTOR UNKNOWN",
      // legacy Socrata geo shape
      geocoded_column: { latitude: "47.61", longitude: "-122.33" },
    },
  ];
}

describe("socrata-permits generic adapter", () => {
  it("parses rows into valid normalized records with config-driven fields", async () => {
    const adapter = new SocrataPermitsAdapter(TEST_CONFIG);
    const parsed = await adapter.parse(rawArtifact(JSON.stringify(goldenRows())), testContext(adapter.key));

    expect(parsed.length).toBe(2);
    for (const p of parsed) {
      const v = NormalizedSourceRecordSchema.safeParse(p.record);
      expect(v.success, JSON.stringify(v.success ? null : v.error.issues)).toBe(true);
      expect(p.record.county).toBe("King");
      expect(p.record.permittingJurisdiction).toBe("City of Testville");
    }

    const first = parsed[0]!.record;
    expect(first.externalId).toBe("B2607-001");
    expect(first.normalizedStage).toBe("permit_issued");
    expect(first.valuationUsd).toBe(250000);
    expect(first.applicationDate?.slice(0, 10)).toBe("2026-06-01");
    expect(first.issueDate?.slice(0, 10)).toBe("2026-06-15");
    expect(first.addressRaw).toBe("123 Main St, Testville");
    expect(first.parcelIds).toEqual(["1234567890"]);
    expect(first.geometry).toEqual({ type: "Point", coordinates: [-122.2, 47.6] });
    expect(first.organizations[0]).toMatchObject({
      name: "ACME INTERIORS LLC",
      role: "primary_contractor",
    });
  });

  it("drops placeholder party strings instead of emitting them as businesses", async () => {
    const adapter = new SocrataPermitsAdapter(TEST_CONFIG);
    const parsed = await adapter.parse(rawArtifact(JSON.stringify(goldenRows())), testContext(adapter.key));
    // "CONTRACTOR UNKNOWN" is not a contractor — no org, and no org evidence row.
    expect(parsed[1]!.record.organizations).toEqual([]);
    expect(parsed[1]!.record.evidence.some((e) => e.factPath === "organizations")).toBe(false);
  });

  it("takes the first positive valuation across fallback columns; 0 ⇒ null, never $0", async () => {
    const adapter = new SocrataPermitsAdapter(TEST_CONFIG);
    const parsed = await adapter.parse(rawArtifact(JSON.stringify(goldenRows())), testContext(adapter.key));
    expect(parsed[1]!.record.valuationUsd).toBe(4200000);
    expect(parsed[1]!.record.units).toBe(12);
    expect(parsed[1]!.record.issueDate).toBeNull();
    expect(parsed[1]!.record.normalizedStage).toBe("permit_applied");
  });

  it("reads a legacy {latitude,longitude} geocoded column as a GeoJSON point", async () => {
    const adapter = new SocrataPermitsAdapter(TEST_CONFIG);
    const parsed = await adapter.parse(rawArtifact(JSON.stringify(goldenRows())), testContext(adapter.key));
    expect(parsed[1]!.record.geometry).toEqual({ type: "Point", coordinates: [-122.33, 47.61] });
  });

  it("emits a runner-rejectable record for a row missing the externalId column", async () => {
    const adapter = new SocrataPermitsAdapter(TEST_CONFIG);
    const parsed = await adapter.parse(
      rawArtifact(JSON.stringify([{ permitdesc: "no permit number" }])),
      testContext(adapter.key),
    );
    expect(parsed.length).toBe(1);
    expect(NormalizedSourceRecordSchema.safeParse(parsed[0]!.record).success).toBe(false);
  });

  it("advances the applied-date high-water checkpoint", async () => {
    const adapter = new SocrataPermitsAdapter(TEST_CONFIG);
    const ctx = testContext(adapter.key);
    await adapter.parse(rawArtifact(JSON.stringify(goldenRows())), ctx);
    expect(ctx.savedCheckpoint).toEqual({ appliedDateHighWater: "2026-06-02" });
  });

  it("is idempotent — same bytes twice produce identical records", async () => {
    const adapter = new SocrataPermitsAdapter(TEST_CONFIG);
    const body = JSON.stringify(goldenRows());
    const a = await adapter.parse(rawArtifact(body), testContext(adapter.key));
    const b = await adapter.parse(rawArtifact(body), testContext(adapter.key));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("checkInvariants is clean on golden rows and flags a bad valuation and a bad date", async () => {
    const adapter = new SocrataPermitsAdapter(TEST_CONFIG);
    const golden = await adapter.parse(rawArtifact(JSON.stringify(goldenRows())), testContext(adapter.key));
    expect(adapter.checkInvariants(rawArtifact("[]"), golden)).toEqual([]);

    const bad = await adapter.parse(
      rawArtifact(
        JSON.stringify([
          { permitno: "X-1", applieddate: "2026-06-01T00:00:00.000", jobvalue: "9000000000" },
          // the real Everett source typo shape: a year-2914 issue date
          { permitno: "X-2", applieddate: "2026-06-01T00:00:00.000", issueddate: "2914-05-27T00:00:00.000" },
        ]),
      ),
      testContext(adapter.key),
    );
    const checks = adapter.checkInvariants(rawArtifact("[]"), bad).map((v) => v.check);
    expect(checks).toContain("socrata_permits_test_valuation_range");
    expect(checks).toContain("socrata_permits_test_issue_date_window");
  });
});

describe("everett_permits_socrata (golden fixture — live window of 2026-07-23)", () => {
  async function parseEverett() {
    const adapter = new SocrataPermitsAdapter(EVERETT_CONFIG);
    const body = await readFile(join(FIXTURES_DIR, "everett_permits_socrata/window-page-1.json"));
    return { adapter, parsed: await adapter.parse(rawArtifact(body), testContext(adapter.key)) };
  }

  it("parses every real Everett row into a valid Snohomish-county record", async () => {
    const { parsed } = await parseEverett();
    expect(parsed.length).toBe(279); // manual count comparison, fixture metadata
    for (const p of parsed) {
      const v = NormalizedSourceRecordSchema.safeParse(p.record);
      expect(v.success, JSON.stringify(v.success ? null : v.error.issues)).toBe(true);
      expect(p.record.county).toBe("Snohomish");
      expect(p.record.permittingJurisdiction).toBe("City of Everett");
      expect(p.record.city).toBe("Everett");
    }
  });

  it("emits the contractor of record as an org and drops placeholder parties", async () => {
    const { parsed } = await parseEverett();
    const withOrg = parsed.filter((p) => p.record.organizations.length > 0);
    // 262 rows carry a contractorname, but 32 are placeholders (N/A, NA, OWNER,
    // TBD) — those are dropped, never emitted as businesses.
    expect(withOrg.length).toBe(230);
    for (const p of withOrg) {
      expect(p.record.organizations[0]!.role).toBe("primary_contractor");
    }
    const names = new Set(parsed.flatMap((p) => p.record.organizations.map((o) => o.name.toUpperCase())));
    for (const placeholder of ["OWNER", "N/A", "NA", "TBD"]) {
      expect(names.has(placeholder)).toBe(false);
    }
  });

  it("derives stage from date presence (no status column) and carries geometry", async () => {
    const { parsed } = await parseEverett();
    const stages = parsed.reduce<Record<string, number>>((acc, p) => {
      acc[p.record.normalizedStage] = (acc[p.record.normalizedStage] ?? 0) + 1;
      return acc;
    }, {});
    expect(stages).toEqual({ permit_issued: 108, approved: 12, permit_applied: 159 });
    // every issued row carries its issue date; pre-issuance rows carry none
    for (const p of parsed.filter((x) => x.record.normalizedStage === "permit_issued")) {
      expect(p.record.issueDate).not.toBeNull();
    }
    for (const p of parsed.filter((x) => x.record.normalizedStage === "permit_applied")) {
      expect(p.record.issueDate).toBeNull();
    }
    // Everett has no status column — statusRaw is honestly null, never invented.
    expect(parsed.every((p) => p.record.statusRaw === null)).toBe(true);

    const withGeom = parsed.filter((p) => p.record.geometry?.type === "Point");
    expect(withGeom.length).toBe(272);
    const lons = withGeom.map((p) => (p.record.geometry!.coordinates as [number, number])[0]);
    expect(Math.min(...lons)).toBeGreaterThan(-122.4); // Everett bounds
    expect(Math.max(...lons)).toBeLessThan(-122.0);
  });

  it("checkInvariants reconciles clean on the golden Everett fixture", async () => {
    const { adapter, parsed } = await parseEverett();
    expect(adapter.checkInvariants(rawArtifact("[]"), parsed)).toEqual([]);
  });

  it("everettStage maps date presence to §9 stages", () => {
    expect(everettStage({ hasIssued: true, hasApproved: true })).toBe("permit_issued");
    expect(everettStage({ hasIssued: false, hasApproved: true })).toBe("approved");
    expect(everettStage({ hasIssued: false, hasApproved: false })).toBe("permit_applied");
  });
});

describe("auburn_permits_socrata (golden fixture — verify-first scaffold, source disabled)", () => {
  async function parseAuburn() {
    const adapter = new SocrataPermitsAdapter(AUBURN_CONFIG);
    const body = await readFile(join(FIXTURES_DIR, "auburn_permits_socrata/window-page-1.json"));
    return { adapter, parsed: await adapter.parse(rawArtifact(body), testContext(adapter.key)) };
  }

  it("parses every real Auburn row into a valid King-county record", async () => {
    const { parsed } = await parseAuburn();
    expect(parsed.length).toBe(275); // manual count comparison, fixture metadata
    for (const p of parsed) {
      const v = NormalizedSourceRecordSchema.safeParse(p.record);
      expect(v.success, JSON.stringify(v.success ? null : v.error.issues)).toBe(true);
      expect(p.record.county).toBe("King");
      expect(p.record.permittingJurisdiction).toBe("City of Auburn");
    }
    expect(parsed.filter((p) => p.record.organizations.length > 0).length).toBe(223);
  });

  it("uses the status string, NOT the unreliable finaled column, to set stage", async () => {
    const { parsed } = await parseAuburn();
    const stages = parsed.reduce<Record<string, number>>((acc, p) => {
      acc[p.record.normalizedStage] = (acc[p.record.normalizedStage] ?? 0) + 1;
      return acc;
    }, {});
    // Auburn stamps `finaled` on EVERY row (all 213 ISSUED rows have one), so it
    // is a last-status-change date, not a completion signal. If it were mapped to
    // `completed`, every issued permit would wrongly read as "complete".
    expect(stages).toEqual({ permit_issued: 214, complete: 58, withdrawn: 3 });
    expect(parsed.filter((p) => p.record.statusRaw === "ISSUED").every((p) => p.record.normalizedStage === "permit_issued")).toBe(true);
  });

  it("auburnStage covers the live vocabulary; unknown degrades, never guessed", () => {
    const base = { hasIssued: false, hasCompleted: false };
    expect(auburnStage({ ...base, status: "ISSUED" })).toBe("permit_issued");
    expect(auburnStage({ ...base, status: "FINALED" })).toBe("complete");
    expect(auburnStage({ ...base, status: "VOID" })).toBe("withdrawn");
    expect(auburnStage({ ...base, status: "WITHDRAWN" })).toBe("withdrawn");
    // AVAILABLE carries an issue date in the live data → at least issued.
    expect(auburnStage({ ...base, status: "AVAILABLE", hasIssued: true })).toBe("permit_issued");
    expect(auburnStage({ ...base, status: "Some Brand New Status" })).toBe("unknown");
    expect(auburnStage({ ...base, status: null })).toBe("unknown");
  });

  it("checkInvariants reconciles clean on the golden Auburn fixture", async () => {
    const { adapter, parsed } = await parseAuburn();
    expect(adapter.checkInvariants(rawArtifact("[]"), parsed)).toEqual([]);
  });
});
