import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NormalizedSourceRecordSchema } from "@otn/domain";
import type { RawArtifact } from "@otn/source-sdk";
import { PiercePermitsArcgisAdapter } from "./pierce-permits-arcgis.js";
import { FIXTURES_DIR, testContext } from "./test-utils.js";

function rawArtifact(body: Buffer | string): RawArtifact {
  return {
    discovered: {
      idempotencyKey: "test:pierce",
      canonicalUrl: "https://services2.arcgis.com/x/query",
      parentUrl: null,
      expectedContentType: "application/json",
      sourcePublishedAt: null,
    },
    body: Buffer.isBuffer(body) ? body : Buffer.from(body),
    contentType: "application/json",
    httpStatus: 200,
    headers: {},
    retrievedAt: new Date("2026-07-17T00:00:00Z"),
  };
}

describe("pierce_permits_arcgis (golden fixture — live window page of 2026-07-17)", () => {
  it("parses all features with valid normalized records", async () => {
    const adapter = new PiercePermitsArcgisAdapter();
    const ctx = testContext(adapter.key);
    const body = await readFile(join(FIXTURES_DIR, "pierce_permits_arcgis/window-page-1.json"));
    const parsed = await adapter.parse(rawArtifact(body), ctx);

    expect(parsed.length).toBe(451); // manual count comparison, fixture metadata
    for (const p of parsed) {
      const v = NormalizedSourceRecordSchema.safeParse(p.record);
      expect(v.success, JSON.stringify(v.success ? null : v.error.issues)).toBe(true);
      expect(p.record.county).toBe("Pierce");
      expect(p.record.permittingJurisdiction).toBe("Pierce County");
      expect(p.record.sourceUrl).toContain("pals.piercecountywa.gov");
    }
    // Every fixture feature carries a WGS84 point (verified at capture).
    expect(parsed.every((p) => p.record.geometry?.type === "Point")).toBe(true);
    const lons = parsed.map((p) => (p.record.geometry!.coordinates as [number, number])[0]);
    expect(Math.min(...lons)).toBeGreaterThan(-123.2); // Pierce County bounds
    expect(Math.max(...lons)).toBeLessThan(-121.4);
  });

  it("maps official PALS statuses to §9 stages; pre-issuance stays pre-issuance", async () => {
    const adapter = new PiercePermitsArcgisAdapter();
    const body = await readFile(join(FIXTURES_DIR, "pierce_permits_arcgis/window-page-1.json"));
    const parsed = await adapter.parse(rawArtifact(body), testContext(adapter.key));

    const byStatus = new Map<string, string>();
    for (const p of parsed) byStatus.set(p.record.statusRaw ?? "", p.record.normalizedStage);
    expect(byStatus.get("Issued")).toBe("permit_issued");
    expect(byStatus.get("Final")).toBe("complete");
    expect(byStatus.get("Cancelled")).toBe("withdrawn");

    // An Accepted BUILDING application is permit_applied with NO issue date —
    // a permit is not a bid and an application is not an issued permit.
    const accepted = parsed.filter(
      (p) => p.record.statusRaw === "Accepted" && p.record.recordType === "building_permit",
    );
    expect(accepted.length).toBeGreaterThan(50);
    for (const p of accepted) {
      expect(p.record.normalizedStage).toBe("permit_applied");
      expect(p.record.issueDate).toBeNull();
    }

    // Planning/land-use types are planning_application records at entitlement
    // when accepted — the advance-notice class this source exists for.
    const planning = parsed.filter((p) => p.record.recordType === "planning_application");
    expect(planning.length).toBeGreaterThan(0);
    for (const p of planning) {
      expect(p.record.applicationType).toMatch(
        /land use|land div|pre-application|sepa|shoreline|forest|variance|deviation|appeal/i,
      );
    }
  });

  it("preserves stated values and nulls — never guessed", async () => {
    const adapter = new PiercePermitsArcgisAdapter();
    const body = await readFile(join(FIXTURES_DIR, "pierce_permits_arcgis/window-page-1.json"));
    const parsed = await adapter.parse(rawArtifact(body), testContext(adapter.key));

    const withValuation = parsed.filter((p) => p.record.valuationUsd !== null);
    expect(withValuation.length).toBeGreaterThan(0);
    for (const p of withValuation) {
      expect(p.record.evidence.some((e) => e.factPath === "valuationUsd")).toBe(true);
    }
    // Unknown values stay null (not zero).
    const noValuation = parsed.find((p) => p.record.valuationUsd === null);
    expect(noValuation).toBeTruthy();
  });

  it("emits runner-rejectable records for malformed features", async () => {
    const adapter = new PiercePermitsArcgisAdapter();
    const parsed = await adapter.parse(
      rawArtifact(JSON.stringify({ features: [{ attributes: { bad: true } }] })),
      testContext("pierce_permits_arcgis"),
    );
    expect(parsed.length).toBe(1);
    expect(NormalizedSourceRecordSchema.safeParse(parsed[0]!.record).success).toBe(false);
  });

  it("pre-application screenings pin to preapplication — the screening's own lifecycle never advances the project", async () => {
    const adapter = new PiercePermitsArcgisAdapter();
    const base = {
      applicationNumber: 888801,
      applicationType: "Pre-Application Screening",
      parcelNumber: "0123456789",
      workType: null, buildingValuation: null, projectValue: null,
      dwellingUnits: null, applicationDate: 1780000000000, submittalDate: null,
      issuedDate: null, finalDate: null, workDescription: "Proposed retail center pre-app", siteAddress: null,
      projectName: "Retail Center", urlOnlinePermits: null, applicationDept: null,
      lotsSubmitted: null, sqFtTotal: null,
    };
    const features = ["Accepted", "Approved", "Final"].map((applicationStatus, i) => ({
      attributes: { ...base, applicationNumber: base.applicationNumber + i, applicationStatus },
      geometry: { x: -122.4, y: 47.1 },
    }));
    features.push({
      attributes: { ...base, applicationNumber: 888899, applicationStatus: "Cancelled" },
      geometry: { x: -122.4, y: 47.1 },
    });
    const parsed = await adapter.parse(
      rawArtifact(JSON.stringify({ features })),
      testContext(adapter.key),
    );
    expect(parsed.map((p) => p.record.normalizedStage)).toEqual([
      "preapplication",
      "preapplication", // "Approved" screening ≠ approved project
      "preapplication", // "Final" screening ≠ complete project
      "withdrawn", // dead is still dead
    ]);
  });

  it("an unmapped future status degrades to unknown, never a guess", async () => {
    const adapter = new PiercePermitsArcgisAdapter();
    const feature = {
      attributes: {
        applicationNumber: 999999,
        applicationType: "Construction Commercial",
        applicationStatus: "Some Brand New Status",
        parcelNumber: "0123456789",
        workType: null, buildingValuation: null, projectValue: null,
        dwellingUnits: null, applicationDate: 1780000000000, submittalDate: null,
        issuedDate: null, finalDate: null, workDescription: null, siteAddress: null,
        projectName: null, urlOnlinePermits: null, applicationDept: null,
        lotsSubmitted: null, sqFtTotal: null,
      },
      geometry: { x: -122.4, y: 47.1 },
    };
    const parsed = await adapter.parse(
      rawArtifact(JSON.stringify({ features: [feature] })),
      testContext(adapter.key),
    );
    expect(parsed[0]!.record.normalizedStage).toBe("unknown");
    expect(parsed[0]!.record.statusRaw).toBe("Some Brand New Status");
  });
});

describe("pierce_permits_arcgis WS4 — PALS project cluster key", () => {
  it("promotes projectId as a namespaced project cluster key, not a party id", async () => {
    const adapter = new PiercePermitsArcgisAdapter();
    const body = await readFile(join(FIXTURES_DIR, "pierce_permits_arcgis/window-page-1.json"));
    const parsed = await adapter.parse(rawArtifact(body), testContext(adapter.key));

    // No party data on this layer → no fabricated org carries the id.
    expect(parsed.every((p) => p.record.organizations.length === 0)).toBe(true);

    const withCluster = parsed.filter(
      (p) => (p.rawFields as { projectClusterId: string | null }).projectClusterId,
    );
    expect(withCluster.length).toBeGreaterThan(0);
    for (const p of withCluster) {
      const id = (p.rawFields as { projectClusterId: string }).projectClusterId;
      expect(id).toMatch(/^pierce_pals_project:\S+$/);
      expect(
        p.record.evidence.some((e) => e.factPath === "externalRef" && e.text.includes(id)),
      ).toBe(true);
    }

    // Permits on one development SHARE the cluster id (project-level, not party).
    const counts = new Map<string, number>();
    for (const p of withCluster) {
      const id = (p.rawFields as { projectClusterId: string }).projectClusterId;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    expect([...counts.values()].some((n) => n > 1)).toBe(true);
  });
});
