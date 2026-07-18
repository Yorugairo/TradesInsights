import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NormalizedSourceRecordSchema } from "@otn/domain";
import { extractPdfTextItems } from "@otn/documents";
import type { RawArtifact } from "@otn/source-sdk";
import {
  CentraliaPermitReportsAdapter,
  leadingPermitNumber,
  parseCentraliaPdf,
  permitFromCell,
  reportMonthFromTitle,
} from "./centralia-permit-reports.js";
import { FIXTURES_DIR, testContext } from "./test-utils.js";

const GOLDEN = "centralia_permit_reports/february-2026.pdf";

/** Smallest valid one-page PDF with no text — the layout-change failure case. */
const EMPTY_PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n" +
    "xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \n0000000101 00000 n \n" +
    "trailer<</Size 4/Root 1 0 R>>\nstartxref\n164\n%%EOF",
);

function rawArtifact(body: Buffer, url: string, meta?: Record<string, unknown>): RawArtifact {
  return {
    discovered: {
      idempotencyKey: `test:${url}`,
      canonicalUrl: url,
      parentUrl: null,
      expectedContentType: "application/pdf",
      sourcePublishedAt: null,
      ...(meta ? { meta } : {}),
    },
    body,
    contentType: "application/pdf",
    httpStatus: 200,
    headers: {},
    retrievedAt: new Date("2026-07-18T00:00:00Z"),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("centralia_permit_reports golden PDF (February 2026)", () => {
  it("parses all 55 permits and reconciles to the printed monthly total", async () => {
    const pdf = await readFile(join(FIXTURES_DIR, GOLDEN));
    const { rows, printedTotal } = parseCentraliaPdf(await extractPdfTextItems(pdf));

    expect(rows.length).toBe(55);
    expect(printedTotal).toBe(2_584_093.08);
    const sum = rows.reduce((s, r) => s + (r.valuation ?? 0), 0);
    expect(Math.abs(sum - printedTotal!)).toBeLessThan(0.01);

    // Every row in this report carries a date, owner, and value.
    expect(rows.filter((r) => r.issueDate).length).toBe(55);
    expect(rows.filter((r) => r.owner).length).toBe(55);
    expect(rows.filter((r) => r.valuation !== null).length).toBe(55);
  });

  it("joins bottom-aligned wrapped cells across up to three lines", async () => {
    const pdf = await readFile(join(FIXTURES_DIR, GOLDEN));
    const { rows } = parseCentraliaPdf(await extractPdfTextItems(pdf));

    // Two-line wraps in address/contractor/comments.
    const first = rows[0]!;
    expect(first).toEqual({
      permitNumber: "20260056",
      permitType: "SFR - Remodel",
      issueDate: "2026-02-03",
      owner: "Norski Realty LLC",
      address: "2222 Cooks Hill Road",
      parcels: ["021182011002"],
      contractor: "Promise Land Construction",
      comments: "Add toilet & sink to laundry room",
      valuation: 4500,
    });

    // Three-line address wrap ("1027 N" / "Washington" / "Avenue") belongs to
    // ITS row — and must not bleed into the previous row (20260077).
    const prev = rows.find((r) => r.permitNumber === "20260077")!;
    expect(prev.address).toBe("2020 Sandra Avenue");
    const wrapped3 = rows.find((r) => r.permitNumber === "20260095")!;
    expect(wrapped3.address).toBe("1027 N Washington Avenue");
  });

  it("recovers the row whose permit number and type merge into one glyph run", async () => {
    const pdf = await readFile(join(FIXTURES_DIR, GOLDEN));
    const { rows } = parseCentraliaPdf(await extractPdfTextItems(pdf));

    // The source typo'd a 9-digit permit that renders as "202500798 Mechanical".
    const merged = rows.find((r) => r.permitNumber === "202500798")!;
    expect(merged.permitType).toBe("Mechanical");
    expect(merged.owner).toBe("Roberta Dunston");
    expect(merged.contractor).toBe("Fast Water Heater Co.");
    expect(merged.valuation).toBe(2198);
    // And the row ABOVE it keeps its own cells (they previously merged).
    const above = rows.find((r) => r.permitNumber === "20260129")!;
    expect(above.owner).toBe("Robert & Barbara Francis");
    expect(above.contractor).toBe("Capital Heating & Cooling");
    expect(above.valuation).toBe(10_002);
  });

  it("captures the production-builder SFR-New rows (Century Communities)", async () => {
    const pdf = await readFile(join(FIXTURES_DIR, GOLDEN));
    const { rows } = parseCentraliaPdf(await extractPdfTextItems(pdf));

    const century = rows.filter((r) => /century communities/i.test(r.contractor ?? ""));
    expect(century.length).toBe(3);
    for (const r of century) {
      expect(r.permitType).toBe("SFR - New");
      expect(r.valuation).toBeGreaterThanOrEqual(379_000);
      expect(r.valuation).toBeLessThanOrEqual(438_000);
      expect(r.address).toMatch(/Salzer Creek Loop$/);
    }
  });

  it("emits valid permit_issued records with contractor/owner org roles", async () => {
    const adapter = new CentraliaPermitReportsAdapter();
    const ctx = testContext(adapter.key);
    const pdf = await readFile(join(FIXTURES_DIR, GOLDEN));
    const parsed = await adapter.parse(
      rawArtifact(pdf, "https://www.cityofcentralia.com/DocumentCenter/View/5408/February-2026-Monthly-Permit-Report", {
        month: "2026-02",
        title: "February 2026 Monthly Permit Report",
      }),
      ctx,
    );
    expect(parsed.length).toBe(55);
    for (const p of parsed) {
      const v = NormalizedSourceRecordSchema.safeParse(p.record);
      expect(v.success, JSON.stringify(v.success ? null : v.error.issues)).toBe(true);
      expect(p.record.county).toBe("Lewis");
      expect(p.record.city).toBe("Centralia");
      expect(p.record.permittingJurisdiction).toBe("City of Centralia");
      expect(p.record.normalizedStage).toBe("permit_issued");
    }

    const century = parsed.find((p) => p.record.externalId === "20250786")!;
    expect(century.record.organizations).toEqual([
      {
        name: "Century Communities, LLC",
        role: "primary_contractor",
        evidenceText: "Contractor: Century Communities, LLC",
      },
      { name: "Century Communities, LLC", role: "owner", evidenceText: "Owner: Century Communities, LLC" },
    ]);
    expect(century.record.valuationUsd).toBe(398_000);
    expect(century.record.issueDate).toBe("2026-02-13");

    // "Owner" in the contractor column = owner-performed work, not an org.
    const ownerPerformed = parsed.find((p) => p.record.externalId === "20260098")!;
    expect(ownerPerformed.record.organizations.map((o) => o.role)).toEqual(["owner"]);
  });

  it("passes the printed-total reconciliation invariant on the golden PDF", async () => {
    const adapter = new CentraliaPermitReportsAdapter();
    const ctx = testContext(adapter.key);
    const pdf = await readFile(join(FIXTURES_DIR, GOLDEN));
    const raw = rawArtifact(pdf, "https://www.cityofcentralia.com/DocumentCenter/View/5408/x", { month: "2026-02" });
    const parsed = await adapter.parse(raw, ctx);
    const violations = await adapter.checkInvariants!(raw, parsed, ctx);
    expect(violations).toEqual([]);
  });

  it("fails the reconciliation invariant when a value is dropped", async () => {
    const adapter = new CentraliaPermitReportsAdapter();
    const ctx = testContext(adapter.key);
    const pdf = await readFile(join(FIXTURES_DIR, GOLDEN));
    const raw = rawArtifact(pdf, "https://www.cityofcentralia.com/DocumentCenter/View/5408/x", { month: "2026-02" });
    const parsed = await adapter.parse(raw, ctx);
    parsed[0]!.record.valuationUsd = null;
    const violations = await adapter.checkInvariants!(raw, parsed, ctx);
    expect(violations.length).toBe(1);
    expect(violations[0]!.check).toBe("centralia_printed_valuation_total");
  });

  it("leadingPermitNumber tolerates merged and space-split glyph runs", () => {
    expect(leadingPermitNumber("20260056")).toEqual({ permit: "20260056", rest: "" });
    expect(leadingPermitNumber("202500798 Mechanical")).toEqual({ permit: "202500798", rest: "Mechanical" });
    expect(leadingPermitNumber("2026 0328 Demo")).toEqual({ permit: "20260328", rest: "Demo" });
    expect(leadingPermitNumber("SFR - Reroof")).toBeNull();
    expect(leadingPermitNumber("2026")).toBeNull(); // too short alone
    expect(leadingPermitNumber("021182011002")).toBeNull(); // parcel, too long
  });

  it("permitFromCell recovers a number preceded by drifted type words", () => {
    expect(permitFromCell("SFR 20250219 Remodel")).toEqual({ permit: "20250219", rest: "SFR Remodel" });
    expect(permitFromCell("20260056")).toEqual({ permit: "20260056", rest: "" });
    expect(permitFromCell("SFR - Reroof")).toBeNull();
  });

  it("throws on a PDF with no permit table (layout change)", async () => {
    const adapter = new CentraliaPermitReportsAdapter();
    const ctx = testContext(adapter.key);
    await expect(
      adapter.parse(rawArtifact(EMPTY_PDF, "https://www.cityofcentralia.com/DocumentCenter/View/9999/x"), ctx),
    ).rejects.toThrow(/no permit rows|layout/i);
  });
});

describe("centralia_permit_reports golden PDF (May 2026 — glyph quirks)", () => {
  it("parses 61 permits and reconciles despite a space-split permit number", async () => {
    const pdf = await readFile(join(FIXTURES_DIR, "centralia_permit_reports/may-2026.pdf"));
    const { rows, printedTotal } = parseCentraliaPdf(await extractPdfTextItems(pdf));

    expect(rows.length).toBe(61);
    expect(printedTotal).toBe(2_845_425.88);
    const sum = rows.reduce((s, r) => s + (r.valuation ?? 0), 0);
    expect(Math.abs(sum - printedTotal!)).toBeLessThan(0.01);

    // "2026 0328 Demo" — permit number split across a space inside one glyph
    // run; must become its own row, not merge into the row below.
    const split = rows.find((r) => r.permitNumber === "20260328")!;
    expect(split.permitType).toBe("Demo");
    expect(split.owner).toBe("P4 Potter Properties LLC");
    expect(split.valuation).toBe(100);
    const below = rows.find((r) => r.permitNumber === "20260323")!;
    expect(below.contractor).toBe("The Roof Doctor");
    expect(below.valuation).toBe(9900);

    // A blank value prints as an accounting dash — null, never zero, and the
    // dash must not leak into the comments cell.
    const blank = rows.find((r) => r.permitNumber === "20260324")!;
    expect(blank.valuation).toBeNull();
    expect(blank.comments).toBe("Paint, display cases and Change of Occupancy to retail store.");
  });
});

describe("centralia_permit_reports golden PDF (July 2025 — page spill)", () => {
  it("parses the lone row spilled onto page 3 using document-level columns", async () => {
    const pdf = await readFile(join(FIXTURES_DIR, "centralia_permit_reports/july-2025.pdf"));
    const { rows, printedTotal } = parseCentraliaPdf(await extractPdfTextItems(pdf));

    expect(rows.length).toBe(48);
    expect(printedTotal).toBe(3_013_403.63);
    const sum = rows.reduce((s, r) => s + (r.valuation ?? 0), 0);
    expect(Math.abs(sum - printedTotal!)).toBeLessThan(0.01);

    // The last row sits alone on page 3 (too sparse to seed columns on its
    // own) and merges permit+type AND date+owner glyph runs.
    const spilled = rows.find((r) => r.permitNumber === "20250489")!;
    expect(spilled.permitType).toBe("Mechanical");
    expect(spilled.issueDate).toBe("2025-07-31");
    expect(spilled.owner).toBe("Kathy Griffin");
    expect(spilled.address).toBe("2606 Seward Avenue");
    expect(spilled.contractor).toBe("Capital Heating & Cooling");
    expect(spilled.comments).toBe("Replace gas boiler");
    expect(spilled.valuation).toBe(12_372);
  });
});

describe("centralia_permit_reports discovery", () => {
  it("reportMonthFromTitle handles every naming style in the live series", () => {
    expect(reportMonthFromTitle("June 2026 Monthly Permit Report")).toBe("2026-06");
    expect(reportMonthFromTitle("September 2025 Monthly Building Permit Report")).toBe("2025-09");
    expect(reportMonthFromTitle("March 2025 Building Permits")).toBe("2025-03");
    expect(reportMonthFromTitle("December 2024 - Issued Permits")).toBe("2024-12");
    expect(reportMonthFromTitle("Fee Schedule 2026")).toBeNull();
  });

  it("discovers reports in a backfill month range without moving the checkpoint", async () => {
    const adapter = new CentraliaPermitReportsAdapter();
    const ctx = testContext(adapter.key, {
      backfill: { from: "2026-01-01", to: "2026-04-30" },
    });
    const index = await readFile(join(FIXTURES_DIR, "centralia_permit_reports/index.html"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(index, { status: 200, headers: { "content-type": "text/html" } })),
    );
    const items = await adapter.discover(ctx);
    const months = items.map((i) => (i.meta as { month: string }).month).sort();
    expect(months).toEqual(["2026-01", "2026-02", "2026-03", "2026-04"]);
    for (const i of items) {
      expect(i.canonicalUrl).toMatch(/^https:\/\/www\.cityofcentralia\.com\/DocumentCenter\/View\/\d+\//);
    }
    expect(ctx.savedCheckpoint).toBeNull();
  });

  it("uses the month checkpoint with one-month overlap and advances it", async () => {
    const adapter = new CentraliaPermitReportsAdapter();
    const ctx = testContext(adapter.key, {
      checkpoint: { monthHighWater: "2026-05" },
    });
    const index = await readFile(join(FIXTURES_DIR, "centralia_permit_reports/index.html"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(index, { status: 200, headers: { "content-type": "text/html" } })),
    );
    const items = await adapter.discover(ctx);
    const months = items.map((i) => (i.meta as { month: string }).month).sort();
    // Floor = 2026-04 (one-month overlap below the 2026-05 high water).
    expect(months).toEqual(["2026-04", "2026-05", "2026-06"]);
    expect(ctx.savedCheckpoint).toEqual({ monthHighWater: "2026-06" });
  });

  it("throws when the index yields no dated report links", async () => {
    const adapter = new CentraliaPermitReportsAdapter();
    const ctx = testContext(adapter.key);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html><body>no docs</body></html>", { status: 200, headers: { "content-type": "text/html" } })),
    );
    await expect(adapter.discover(ctx)).rejects.toThrow(/zero report links/i);
  });
});
