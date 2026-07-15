import { describe, expect, it } from "vitest";
import { NormalizedSourceRecordSchema } from "./normalized-record.js";

const valid = {
  sourceKey: "fake_source",
  externalId: "FAKE-2026-001",
  recordType: "building_permit",
  title: "New commercial building",
  description: null,
  permittingJurisdiction: "City of Lacey",
  county: "Thurston",
  city: "Lacey",
  addressRaw: "123 Main St SE",
  parcelIds: ["12345678900"],
  geometry: { type: "Point", coordinates: [-122.8, 47.0] },
  applicationType: null,
  permitType: "commercial",
  documentType: null,
  statusRaw: "Issued",
  normalizedStage: "permit_issued",
  applicationDate: "2026-05-01",
  issueDate: "2026-06-15",
  sourceUpdatedAt: null,
  valuationUsd: 1500000,
  units: null,
  lots: null,
  squareFeet: 12000,
  organizations: [
    { name: "Acme Builders LLC", role: "applicant", evidenceText: "Applicant: Acme Builders LLC" },
  ],
  sourceUrl: "https://example.gov/permits/FAKE-2026-001",
  evidence: [
    { factPath: "valuationUsd", text: "Valuation: $1,500,000", pageOrSection: "row 3" },
  ],
};

describe("NormalizedSourceRecordSchema", () => {
  it("accepts a fully-populated valid record", () => {
    expect(NormalizedSourceRecordSchema.parse(valid)).toBeTruthy();
  });

  it("rejects a county outside the launch counties", () => {
    expect(() =>
      NormalizedSourceRecordSchema.parse({ ...valid, county: "Snohomish" }),
    ).toThrow();
  });

  it("rejects zero valuation — unknown must be null, never zero", () => {
    expect(() =>
      NormalizedSourceRecordSchema.parse({ ...valid, valuationUsd: 0 }),
    ).toThrow();
  });

  it("rejects unknown extra fields (strict shape)", () => {
    expect(() =>
      NormalizedSourceRecordSchema.parse({ ...valid, guessedField: "x" }),
    ).toThrow();
  });

  it("rejects an invalid stage", () => {
    expect(() =>
      NormalizedSourceRecordSchema.parse({ ...valid, normalizedStage: "bidding" }),
    ).toThrow();
  });
});
