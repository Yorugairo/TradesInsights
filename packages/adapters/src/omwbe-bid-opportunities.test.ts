import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NormalizedSolicitationRecordSchema } from "@otn/domain";
import type { RawArtifact } from "@otn/source-sdk";
import {
  OmwbeBidOpportunitiesAdapter,
  parseBoardEntries,
  parseLongDate,
  solicitationNumberFrom,
} from "./omwbe-bid-opportunities.js";
import { FIXTURES_DIR, testContext } from "./test-utils.js";

const DIR = join(FIXTURES_DIR, "omwbe_bid_opportunities");

function detailArtifact(
  body: Buffer,
  meta: { slug: string; listingTitle: string; closingIso: string | null },
): RawArtifact {
  return {
    discovered: {
      idempotencyKey: `test:omwbe:${meta.slug}`,
      canonicalUrl: `https://omwbe.wa.gov/bid-opportunities/${meta.slug}`,
      parentUrl: null,
      expectedContentType: "text/html",
      sourcePublishedAt: null,
      meta,
    },
    body,
    contentType: "text/html",
    httpStatus: 200,
    headers: {},
    retrievedAt: new Date("2026-07-27T00:00:00Z"),
  };
}

describe("omwbe_bid_opportunities — board listing (live page of 2026-07-27)", () => {
  it("parses every posting row with a machine-readable closing date", async () => {
    const html = await readFile(join(DIR, "bids-contracting-opportunities.html"));
    const entries = parseBoardEntries(html);

    // 160 postings on the live page. A floor rather than an equality so the
    // test does not fail simply because the board moved on.
    expect(entries.length).toBeGreaterThan(100);
    for (const e of entries) {
      expect(e.slug).not.toContain("/");
      expect(e.url).toMatch(/^https:\/\/omwbe\.wa\.gov\/bid-opportunities\//);
      expect(e.title.length).toBeGreaterThan(0);
    }
    // The RDFa `content` attribute is the whole reason discovery needs no
    // date parsing — if it disappears, this is the test that says so.
    const dated = entries.filter((e) => e.closingIso !== null);
    expect(dated.length / entries.length).toBeGreaterThan(0.9);
    expect(dated[0]!.closingIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("finds the prime sub-bid postings that are this source's whole point", async () => {
    const html = await readFile(join(DIR, "bids-contracting-opportunities.html"));
    const entries = parseBoardEntries(html);
    const subBids = entries.filter((e) => /sub-?bids?\s+requested/i.test(e.title));
    expect(subBids.length).toBeGreaterThan(0);
  });

  it("a redesigned page yields zero entries rather than fabricated ones", () => {
    expect(parseBoardEntries("<html><body><p>redesigned</p></body></html>")).toEqual([]);
  });
});

describe("omwbe_bid_opportunities — detail pages", () => {
  it("classifies a GC/CM sub-bid call and attributes the prime", async () => {
    const adapter = new OmwbeBidOpportunitiesAdapter();
    const body = await readFile(join(DIR, "detail-sub-bids-requested-gccm-project--2--0--2.html"));
    const [p] = await adapter.parse(
      detailArtifact(body, {
        slug: "sub-bids-requested-gccm-project-community-transitions",
        listingTitle: "SUB-BIDS REQUESTED for GC/CM Project: COMMUNITY TRANSITIONS",
        closingIso: "2026-08-06T00:00:00-07:00",
      }),
      testContext(adapter.key),
    );
    expect(p).toBeDefined();
    expect(p!.kind).toBe("solicitation");

    const v = NormalizedSolicitationRecordSchema.safeParse(p!.record);
    expect(v.success, JSON.stringify(v.success ? null : v.error.issues)).toBe(true);
    const rec = v.data!;

    expect(rec.documentType).toBe("sub_bid_request");
    expect(rec.primeContractor).toBe("RAM Construction General Contractors, LLC");
    // The prime must also land in organizations[] with real evidence text —
    // that is what makes it usable for entity resolution downstream.
    expect(rec.organizations[0]!.role).toBe("prime");
    expect(rec.organizations[0]!.evidenceText).toContain("RAM Construction");
    expect(rec.bidDueAt).toBe("2026-08-06T00:00:00-07:00");
    // Statewide board: no county, and that is correct rather than missing.
    expect(rec.county).toBeNull();
    expect(rec.scopeRaw).toContain("SUB-BIDS REQUESTED");
  });

  it("treats an agency ITB as a solicitation with no prime", async () => {
    const adapter = new OmwbeBidOpportunitiesAdapter();
    const body = await readFile(join(DIR, "detail-itb-26-011-lpw-angleside-pressure-zone-p.html"));
    const [p] = await adapter.parse(
      detailArtifact(body, {
        slug: "itb-26-011-lpw-angleside-pressure-zone-phase-1-improvements",
        listingTitle: "ITB 26-011-LPW | Angleside Pressure Zone Phase 1 Improvements",
        closingIso: "2026-07-28T00:00:00-07:00",
      }),
      testContext(adapter.key),
    );
    const rec = NormalizedSolicitationRecordSchema.parse(p!.record);
    expect(rec.documentType).toBe("solicitation");
    expect(rec.primeContractor).toBeNull();
    expect(rec.procuringAgency).toBe("City of Shelton");
    expect(rec.organizations[0]!.role).toBe("procuring_agency");
    expect(rec.solicitationNumber).toBe("26-011-LPW");
  });

  it("emits a record with a null deadline rather than skipping an undated posting", async () => {
    // OMWBE postings are third-party submissions; some genuinely have no date.
    const adapter = new OmwbeBidOpportunitiesAdapter();
    const body = await readFile(join(DIR, "detail-itb-26-011-lpw-angleside-pressure-zone-p.html"));
    const html = body.toString().replace(/field-name-field-closing-date/g, "field-name-removed");
    const [p] = await adapter.parse(
      detailArtifact(Buffer.from(html), {
        slug: "undated-posting",
        listingTitle: "Some posting with no date",
        closingIso: null,
      }),
      testContext(adapter.key),
    );
    const rec = NormalizedSolicitationRecordSchema.parse(p!.record);
    expect(rec.bidDueAt).toBeNull();
  });
});

describe("omwbe_bid_opportunities — drift invariants", () => {
  it("a clean parse trips nothing", async () => {
    const adapter = new OmwbeBidOpportunitiesAdapter();
    const body = await readFile(join(DIR, "detail-itb-26-011-lpw-angleside-pressure-zone-p.html"));
    const raw = detailArtifact(body, {
      slug: "itb-26-011-lpw",
      listingTitle: "ITB 26-011-LPW",
      closingIso: "2026-07-28T00:00:00-07:00",
    });
    const parsed = await adapter.parse(raw, testContext(adapter.key));
    expect(adapter.checkInvariants(raw, parsed)).toEqual([]);
  });

  it("flags a detail page whose fields all vanished — a theme change, not an empty post", async () => {
    const adapter = new OmwbeBidOpportunitiesAdapter();
    const raw = detailArtifact(Buffer.from("<html><body><h1>Redesigned</h1></body></html>"), {
      slug: "theme-change",
      listingTitle: "Anything",
      closingIso: null,
    });
    const parsed = await adapter.parse(raw, testContext(adapter.key));
    const v = adapter.checkInvariants(raw, parsed);
    expect(v.some((x) => x.check === "omwbe_detail_fields_empty")).toBe(true);
  });

  it("flags a closing date that stopped being a date", () => {
    const adapter = new OmwbeBidOpportunitiesAdapter();
    const drift = [
      { kind: "solicitation" as const, rawFields: { slug: "x", closingIso: "TBD", organization: "A", bodyChars: 10 }, record: {} },
    ] as unknown as Parameters<typeof adapter.checkInvariants>[1];
    const v = adapter.checkInvariants(
      null as unknown as Parameters<typeof adapter.checkInvariants>[0],
      drift,
    );
    expect(v.some((x) => x.check === "omwbe_closing_date_not_a_date")).toBe(true);
  });
});

describe("omwbe helpers", () => {
  it("parses the detail page's long-form date", () => {
    expect(parseLongDate("Closing Date: Thursday, August 6, 2026")).toContain("2026-08-06");
  });

  it("returns null for anything that is not that exact shape", () => {
    expect(parseLongDate("see attached")).toBeNull();
    expect(parseLongDate(null)).toBeNull();
  });

  it("extracts a solicitation number only from unambiguous forms", () => {
    expect(solicitationNumberFrom("RFQQ #2634-886 Drug and Alcohol Testing")).toBe("2634-886");
    expect(solicitationNumberFrom("ITB 26-011-LPW | Angleside")).toBe("26-011-LPW");
    expect(solicitationNumberFrom("RFP No. 26-03 IRS E-File")).toBe("26-03");
    expect(solicitationNumberFrom("Sam Chastain Trail Project")).toBeNull();
  });
});
