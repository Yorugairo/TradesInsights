import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NormalizedSourceRecordSchema } from "@otn/domain";
import { extractPdfTextItems } from "@otn/documents";
import type { RawArtifact } from "@otn/source-sdk";
import {
  LewisIssuedPermitsAdapter,
  parseLewisPermitPage,
  reportDateFromFilename,
} from "./lewis-issued-permits.js";
import { FIXTURES_DIR, testContext } from "./test-utils.js";

const GOLDEN = "lewis_issued_permits/06.28.2026_Issued_Permits_with_Valuation.pdf";

/** Smallest valid one-page PDF with no text — the zero-rows failure case. */
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
    retrievedAt: new Date("2026-07-15T00:00:00Z"),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("lewis_issued_permits golden PDF (2026-06-28, spec-named fixture)", () => {
  it("parses all 15 permits with wrapped rows and applicant/contractor separation", async () => {
    const pdf = await readFile(join(FIXTURES_DIR, GOLDEN));
    const pages = await extractPdfTextItems(pdf);
    const rows = pages.flatMap((p) => parseLewisPermitPage(p.items));
    expect(rows.length).toBe(15);

    const first = rows[0]!;
    expect(first).toEqual({
      applicationNumber: "B26-00354",
      issuedDate: "2026-06-29",
      applicationType: "NEW CONSTRUCTION COMMERCIAL",
      siteAddress: "748 WILLIAMS ST, MOSSYROCK",
      parcel: "008701036004",
      applicant: "Gullickson, Scott",
      primaryContractor: "ANDERSON ENVIRONMNTL CNTRG LLC",
      valuation: null, // blank cell in the source PDF — never coerced to zero
    });

    // Wrapped rows: type wraps two lines, contractor wraps two lines.
    const wrapped = rows.find((r) => r.applicationNumber === "B26-00584")!;
    expect(wrapped.applicationType).toBe("UTILITY STRUCTURE (GARAGE/BARN/SHOP/CARPORT)");
    expect(wrapped.primaryContractor).toBe("COLE REMODELING & CONST LLC");
    expect(wrapped.applicant).toBe("Neely, Dean");
    expect(wrapped.valuation).toBe(29019.2);

    // The report's grand total ($88,135.10) must not bleed into the last row.
    const last = rows[rows.length - 1]!;
    expect(last.applicationNumber).toBe("MH26-00087");
    expect(last.valuation).toBeNull();

    // Applicant vs contractor are distinct columns, never merged.
    for (const r of rows) {
      if (r.applicant && r.primaryContractor) {
        expect(r.applicant).not.toBe(r.primaryContractor);
      }
    }
  });

  it("emits valid normalized permit_issued records with role-separated organizations", async () => {
    const adapter = new LewisIssuedPermitsAdapter();
    const ctx = testContext(adapter.key);
    const pdf = await readFile(join(FIXTURES_DIR, GOLDEN));
    const parsed = await adapter.parse(
      rawArtifact(pdf, "https://lewiscountywa.gov/documents/19644/06.28.2026_Issued_Permits_with_Valuation.pdf", {
        reportDate: "2026-06-28",
      }),
      ctx,
    );
    expect(parsed.length).toBe(15);
    for (const p of parsed) {
      const v = NormalizedSourceRecordSchema.safeParse(p.record);
      expect(v.success, JSON.stringify(v.success ? null : v.error.issues)).toBe(true);
      expect(p.record.county).toBe("Lewis");
      expect(p.record.normalizedStage).toBe("permit_issued");
      expect(p.record.statusRaw).toBe("issued");
    }
    const wrapped = parsed.find((p) => p.record.externalId === "B26-00584")!;
    expect(wrapped.record.organizations).toEqual([
      { name: "Neely, Dean", role: "applicant", evidenceText: "Applicant: Neely, Dean" },
      {
        name: "COLE REMODELING & CONST LLC",
        role: "primary_contractor",
        evidenceText: "Primary Contractor: COLE REMODELING & CONST LLC",
      },
    ]);
    // "TBD - Prior to Construction" is not an organization.
    const tbd = parsed.find((p) => p.record.externalId === "B26-00581")!;
    expect(tbd.record.organizations.map((o) => o.role)).toEqual(["applicant"]);
  });

  it("throws on a PDF with no permit table (layout change)", async () => {
    const adapter = new LewisIssuedPermitsAdapter();
    const ctx = testContext(adapter.key);
    await expect(
      adapter.parse(rawArtifact(EMPTY_PDF, "https://lewiscountywa.gov/documents/x.pdf"), ctx),
    ).rejects.toThrow(/no permit rows|table layout/i);
  });
});

describe("lewis_issued_permits discovery", () => {
  it("reportDateFromFilename handles the dated series and rejects the rest", () => {
    expect(
      reportDateFromFilename("https://x/documents/19644/06.28.2026_Issued_Permits_with_Valuation.pdf"),
    ).toBe("2026-06-28");
    expect(reportDateFromFilename("https://x/documents/17860/12.21.2025_-_Issued_Permits_with_Valuation.pdf")).toBe("2025-12-21");
    // The county index really contains this glitched name for the 06/14 report.
    expect(
      reportDateFromFilename("https://x/documents/19554/06_C0394UQ.14.2026_Issued_Permits_with_Valuation.pdf"),
    ).toBe("2026-06-14");
    expect(reportDateFromFilename("https://x/documents/17493/BldgPermits_October_2025.pdf")).toBeNull();
    expect(reportDateFromFilename("https://x/media/documents/Exhibit_A_-_2026_Fee_Schedule_Final_Version.pdf")).toBeNull();
  });

  it("discovers only dated reports in the window and sets the checkpoint", async () => {
    const adapter = new LewisIssuedPermitsAdapter();
    const ctx = testContext(adapter.key, {
      backfill: { from: "2026-04-16", to: "2026-07-15" },
    });
    const landing = await readFile(join(FIXTURES_DIR, "lewis_issued_permits/landing.html"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(landing, { status: 200, headers: { "content-type": "text/html" } })),
    );
    const items = await adapter.discover(ctx);
    expect(items.length).toBeGreaterThanOrEqual(12); // ~13 weekly reports in 90 days
    for (const i of items) {
      const d = (i.meta as { reportDate: string }).reportDate;
      expect(d >= "2026-04-16" && d <= "2026-07-15").toBe(true);
      expect(i.canonicalUrl).toMatch(/\.pdf$/i);
    }
    // Backfill runs do not move the checkpoint.
    expect(ctx.savedCheckpoint).toBeNull();
  });

  it("uses the checkpoint high-water with overlap on normal runs", async () => {
    const adapter = new LewisIssuedPermitsAdapter();
    const ctx = testContext(adapter.key, {
      checkpoint: { reportDateHighWater: "2026-06-28" },
    });
    const landing = await readFile(join(FIXTURES_DIR, "lewis_issued_permits/landing.html"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(landing, { status: 200, headers: { "content-type": "text/html" } })),
    );
    const items = await adapter.discover(ctx);
    // Floor = 2026-06-14 (14-day overlap): 06.14, 06.21, 06.28, 07.05 reports.
    const dates = items.map((i) => (i.meta as { reportDate: string }).reportDate).sort();
    expect(dates[0]! >= "2026-06-14").toBe(true);
    expect(dates).toContain("2026-07-05");
    expect(ctx.savedCheckpoint).toEqual({ reportDateHighWater: "2026-07-05" });
  });
});
