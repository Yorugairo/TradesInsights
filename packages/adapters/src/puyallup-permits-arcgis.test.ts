import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NormalizedSourceRecordSchema } from "@otn/domain";
import type { RawArtifact } from "@otn/source-sdk";
import { PuyallupPermitsArcgisAdapter, puyallupStage } from "./puyallup-permits-arcgis.js";
import { FIXTURES_DIR, testContext } from "./test-utils.js";

function rawArtifact(body: Buffer | string): RawArtifact {
  return {
    discovered: {
      idempotencyKey: "test:puyallup",
      canonicalUrl: "https://services8.arcgis.com/x/query",
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

describe("puyallup_permits_arcgis (golden fixture — live window page of 2026-07-17)", () => {
  it("parses all features with valid normalized records; SFR class present", async () => {
    const adapter = new PuyallupPermitsArcgisAdapter();
    const body = await readFile(join(FIXTURES_DIR, "puyallup_permits_arcgis/window-page-1.json"));
    const parsed = await adapter.parse(rawArtifact(body), testContext(adapter.key));

    expect(parsed.length).toBe(2000); // manual count comparison, fixture metadata
    for (const p of parsed) {
      const r = NormalizedSourceRecordSchema.safeParse(p.record);
      expect(r.success, JSON.stringify(p.record.externalId)).toBe(true);
      expect(p.record.county).toBe("Pierce");
      expect(p.record.permittingJurisdiction).toBe("City of Puyallup");
    }
    // The class this source exists for (Solis home-market SFR).
    const sfr = parsed.filter((p) => /single family/i.test(p.record.applicationType ?? ""));
    expect(sfr.length).toBeGreaterThan(0);
    // Verbatim spot check from fixture metadata.
    const spot = parsed.find((p) => p.record.externalId === "PRRNSF20241562")!;
    expect(spot.record.statusRaw).toBe("Closed");
    expect(spot.record.normalizedStage).toBe("complete");
    // Mixed-type IssueDate: string "MM/DD/YYYY" rows normalize to ISO dates.
    const stringIssue = parsed.filter((p) => p.record.issueDate !== null);
    expect(stringIssue.length).toBeGreaterThan(0);
    for (const p of stringIssue.slice(0, 50)) {
      expect(p.record.issueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("maps the enumerated status vocabulary to §9 stages; pre-apps pin to preapplication", () => {
    expect(puyallupStage("Permit(s) Issued", "permit")).toBe("permit_issued");
    expect(puyallupStage("Finaled", "permit")).toBe("complete");
    expect(puyallupStage("Closed", "permit")).toBe("complete");
    expect(puyallupStage("Approved w/Conditions", "permit")).toBe("approved");
    expect(puyallupStage("Ready for Issuance", "permit")).toBe("approved");
    expect(puyallupStage("In Plan Check", "permit")).toBe("permit_applied");
    expect(puyallupStage("Waiting for Submittals", "permit")).toBe("permit_applied");
    expect(puyallupStage("Under Review", "planning")).toBe("entitlement");
    // Pre-application cases never walk the permit lifecycle.
    expect(puyallupStage("Permit(s) Issued", "preapp")).toBe("preapplication");
    expect(puyallupStage("Closed", "preapp")).toBe("preapplication");
    expect(puyallupStage("Withdrawn", "preapp")).toBe("withdrawn");
    // Never guessed.
    expect(puyallupStage("Some Future Status", "permit")).toBe("unknown");
  });

  it("FeeAmount never becomes a valuation; unknowns stay null", async () => {
    const adapter = new PuyallupPermitsArcgisAdapter();
    const body = await readFile(join(FIXTURES_DIR, "puyallup_permits_arcgis/window-page-1.json"));
    const parsed = await adapter.parse(rawArtifact(body), testContext(adapter.key));
    for (const p of parsed) {
      expect(p.record.valuationUsd).toBeNull();
      expect(p.record.units).toBeNull();
    }
  });

  it("emits runner-rejectable records for malformed features", async () => {
    const adapter = new PuyallupPermitsArcgisAdapter();
    const parsed = await adapter.parse(
      rawArtifact(JSON.stringify({ features: [{ attributes: { bogus: true } }] })),
      testContext(adapter.key),
    );
    expect(parsed.length).toBe(1);
    expect(NormalizedSourceRecordSchema.safeParse(parsed[0]!.record).success).toBe(false);
  });
});
