import { describe, expect, it } from "vitest";
import { NormalizedSolicitationRecordSchema } from "./normalized-solicitation.js";

/** A minimal valid record; each test overrides only the field under test. */
function base(over: Record<string, unknown> = {}) {
  return {
    sourceKey: "webs_bid_calendar",
    externalId: "WSP-RFQQ-GasChro3",
    solicitationNumber: "WSP-RFQQ-GasChro3",
    title: "Maintenance and Service of Gas Chromatography Laboratory Equipment",
    description: null,
    procuringAgency: "Washington State Patrol",
    primeContractor: null,
    documentType: "solicitation",
    bidDueAt: "2026-08-14T14:00:00-07:00",
    issuedAt: null,
    status: "open",
    county: null,
    city: null,
    scopeRaw: null,
    tradeTags: [],
    organizations: [],
    sourceUrl: "https://pr-webs-vendor.des.wa.gov/BidCalendar.aspx",
    evidence: [],
    ...over,
  };
}

describe("NormalizedSolicitationRecord", () => {
  it("accepts a statewide record with no county — null is correct, not missing", () => {
    // The whole reason this record class exists. The permit record requires a
    // county from a fixed enum; this real WEBS row has none, and forcing one
    // would mean either fabricating it or dropping the record.
    const v = NormalizedSolicitationRecordSchema.safeParse(base({ county: null }));
    expect(v.success, JSON.stringify(v.success ? null : v.error.issues)).toBe(true);
  });

  it("accepts a county outside the permit CountySchema enum", () => {
    // Statewide procurement reaches counties the permit coverage never will.
    // Constraining this field to the enum would reintroduce the blocker.
    const v = NormalizedSolicitationRecordSchema.safeParse(base({ county: "Asotin" }));
    expect(v.success).toBe(true);
  });

  it("rejects a record that OMITS bidDueAt", () => {
    // Nullable but NOT optional: an adapter has to make an explicit decision
    // about the deadline rather than silently forgetting the field.
    const { bidDueAt: _omitted, ...withoutDueDate } = base();
    const v = NormalizedSolicitationRecordSchema.safeParse(withoutDueDate);
    expect(v.success).toBe(false);
  });

  it("accepts an explicit null bidDueAt", () => {
    // OMWBE listings are third-party submissions with genuinely missing dates.
    // Emitting the record with a null date beats skipping it or inventing one.
    const v = NormalizedSolicitationRecordSchema.safeParse(base({ bidDueAt: null }));
    expect(v.success).toBe(true);
  });

  it("keeps the TIME on a deadline rather than truncating to midnight", () => {
    const v = NormalizedSolicitationRecordSchema.parse(
      base({ bidDueAt: "2026-08-14T14:00:00-07:00" }),
    );
    expect(new Date(v.bidDueAt!).getUTCHours()).toBe(21);
  });

  it("rejects a non-date bidDueAt", () => {
    const v = NormalizedSolicitationRecordSchema.safeParse(base({ bidDueAt: "RFP" }));
    expect(v.success).toBe(false);
  });

  it("classifies a prime's sub-bid call distinctly from an agency solicitation", () => {
    const v = NormalizedSolicitationRecordSchema.safeParse(
      base({
        documentType: "sub_bid_request",
        primeContractor: "Lease Crutcher Lewis",
        organizations: [
          {
            name: "Lease Crutcher Lewis",
            role: "prime",
            evidenceText: "SUB-BIDS REQUESTED for GC/CM Project",
          },
        ],
      }),
    );
    expect(v.success, JSON.stringify(v.success ? null : v.error.issues)).toBe(true);
  });

  it("rejects an unknown documentType", () => {
    const v = NormalizedSolicitationRecordSchema.safeParse(base({ documentType: "permit" }));
    expect(v.success).toBe(false);
  });

  it("rejects an unknown status", () => {
    const v = NormalizedSolicitationRecordSchema.safeParse(base({ status: "bidding_confirmed" }));
    expect(v.success).toBe(false);
  });

  it("is strict — a stray permit field is a rejection, not a silent passthrough", () => {
    // The guard against the permit shape leaking back in one field at a time.
    const v = NormalizedSolicitationRecordSchema.safeParse(base({ valuationUsd: 1_000_000 }));
    expect(v.success).toBe(false);
  });
});
