import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NormalizedSourceRecordSchema } from "@otn/domain";
import { extractPdfTextItems } from "@otn/documents";
import type { RawArtifact } from "@otn/source-sdk";
import {
  LaceyPermitReportsAdapter,
  censusMonthFromUrl,
  parseLaceyCensus,
  printedPermitCount,
} from "./lacey-permit-reports.js";
import { FIXTURES_DIR, testContext } from "./test-utils.js";

const JUNE = "lacey_permit_reports/June-2026-Census-Report-New-Construction.pdf";
const MAY = "lacey_permit_reports/May-2026-Census-Report-New-Construction.pdf";

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
    retrievedAt: new Date("2026-07-16T00:00:00Z"),
  };
}

describe("lacey_permit_reports census parser (two live layout variants)", () => {
  it("June 2026 (separate valuations page): 14 permits, units + valuations paired by order", async () => {
    const pages = await extractPdfTextItems(await readFile(join(FIXTURES_DIR, JUNE)));
    const { rows, valuationMismatch } = parseLaceyCensus(pages);
    expect(valuationMismatch).toBe(false);
    expect(rows.length).toBe(14); // printed "Total Number of Permits Issued: 14"

    expect(rows[0]).toEqual({
      permitNumber: "BLDG25-0787",
      permitType: "NEW CONSTRUCTION",
      permitSubtype: "MULTI FAMILY RESIDENTIAL",
      siteAddress: "6531 CARPENTER RD SE, LACEY, WA 98503",
      issuedDate: "2026-06-02",
      units: 24,
      valuation: 3589562.24,
    });
    // Type/subtype carry forward down group rows (only printed once).
    expect(rows[3]!.permitSubtype).toBe("MULTI FAMILY RESIDENTIAL");
    expect(rows[3]!.units).toBe(89);
    // The last row must not absorb the footer totals.
    expect(rows[13]!.permitNumber).toBe("BLDG26-1676");
    expect(rows[13]!.permitType).toBe("NEW CONSTRUCTION");

    // Manual audit against the printed report totals: 177 dwelling units.
    const units = rows.reduce((a, r) => a + (r.units ?? 0), 0);
    expect(units).toBe(177);
    // Sum of paired valuations equals the printed grand total 30,114,355.51.
    const val = rows.reduce((a, r) => a + (r.valuation ?? 0), 0);
    expect(Math.round(val * 100) / 100).toBe(30114355.51);
  });

  it("May 2026 (inline valuation column, wrapped headers): 9 permits incl. 3-line subtype wrap", async () => {
    const pages = await extractPdfTextItems(await readFile(join(FIXTURES_DIR, MAY)));
    const { rows, valuationMismatch } = parseLaceyCensus(pages);
    expect(valuationMismatch).toBe(false);
    expect(rows.length).toBe(9); // printed "Total Number of Permits Issued: 9"

    expect(rows[0]!.permitSubtype).toBe("ACCESSORY DWELLING UNIT"); // wraps 3 lines
    expect(rows[1]!.permitSubtype).toBe("SINGLE FAMILY RESIDENTIAL"); // wraps 3 lines
    expect(rows[2]!.permitSubtype).toBe("SINGLE FAMILY RESIDENTIAL"); // carried forward
    expect(rows.every((r) => r.units === 1)).toBe(true);

    // Manual audit: printed Total Valuation 3,169,415.56.
    const val = rows.reduce((a, r) => a + (r.valuation ?? 0), 0);
    expect(Math.round(val * 100) / 100).toBe(3169415.56);
  });

  it("emits valid normalized permit_issued records with evidence", async () => {
    const adapter = new LaceyPermitReportsAdapter();
    const ctx = testContext(adapter.key);
    const parsed = await adapter.parse(
      rawArtifact(
        await readFile(join(FIXTURES_DIR, JUNE)),
        "https://cityoflacey.org/wp-content/uploads/sites/3/2026/07/June-2026-Census-Report-New-Construction.pdf",
        { reportMonth: "2026-06" },
      ),
      ctx,
    );
    expect(parsed.length).toBe(14);
    for (const p of parsed) {
      const v = NormalizedSourceRecordSchema.safeParse(p.record);
      expect(v.success, JSON.stringify(v.success ? null : v.error.issues)).toBe(true);
      expect(p.record.county).toBe("Thurston");
      expect(p.record.permittingJurisdiction).toBe("City of Lacey");
      expect(p.record.normalizedStage).toBe("permit_issued");
      expect(p.record.evidence.some((e) => e.factPath === "externalId")).toBe(true);
    }
    const mf = parsed.find((p) => p.record.externalId === "BLDG25-3827")!;
    expect(mf.record.units).toBe(89);
    expect(mf.record.valuationUsd).toBe(15519768.51);
    expect(mf.record.evidence.some((e) => e.factPath === "units")).toBe(true);
  });

  it("throws on a PDF with no census table (layout change)", async () => {
    const adapter = new LaceyPermitReportsAdapter();
    await expect(
      adapter.parse(rawArtifact(EMPTY_PDF, "https://cityoflacey.org/x.pdf"), testContext(adapter.key)),
    ).rejects.toThrow(/no census rows|layout/i);
  });

  it("censusMonthFromUrl: filename year, path-year fallback, non-census rejection", () => {
    expect(
      censusMonthFromUrl("https://cityoflacey.org/wp-content/uploads/sites/3/2026/07/June-2026-Census-Report-New-Construction.pdf"),
    ).toBe("2026-06");
    // April 2026's real filename omits the year — falls back to the path year.
    expect(
      censusMonthFromUrl("https://cityoflacey.org/wp-content/uploads/sites/3/2026/05/April-Monthly-Census-Report-New-Construction.pdf"),
    ).toBe("2026-04");
    expect(
      censusMonthFromUrl("https://cityoflacey.org/wp-content/uploads/sites/3/2026/07/June-2026-Construction-Activity.pdf"),
    ).toBeNull(); // activity summaries carry counts, not records
  });
});

describe("D1 census parser self-reconciliation invariants", () => {
  it("reads the PDF's own printed permit count (independent of the column parser)", async () => {
    const june = await extractPdfTextItems(await readFile(join(FIXTURES_DIR, JUNE)));
    const may = await extractPdfTextItems(await readFile(join(FIXTURES_DIR, MAY)));
    expect(printedPermitCount(june)).toBe(14);
    expect(printedPermitCount(may)).toBe(9);
  });

  it("a clean parse of both live layouts yields zero violations (no false positives)", async () => {
    const adapter = new LaceyPermitReportsAdapter();
    for (const [file, month] of [[JUNE, "2026-06"], [MAY, "2026-05"]] as const) {
      const raw = rawArtifact(await readFile(join(FIXTURES_DIR, file)), `x/${month}`, {
        reportMonth: month,
      });
      const parsed = await adapter.parse(raw, testContext(adapter.key));
      const violations = await adapter.checkInvariants(raw, parsed);
      expect(violations, JSON.stringify(violations)).toEqual([]);
    }
  });

  it("catches a dropped row (printed count no longer matches parsed rows)", async () => {
    const adapter = new LaceyPermitReportsAdapter();
    const raw = rawArtifact(await readFile(join(FIXTURES_DIR, JUNE)), "x/2026-06", {
      reportMonth: "2026-06",
    });
    const parsed = await adapter.parse(raw, testContext(adapter.key));
    const violations = await adapter.checkInvariants(raw, parsed.slice(0, 12)); // 2 rows dropped
    expect(violations.map((v) => v.check)).toContain("lacey_printed_permit_count");
    const v = violations.find((x) => x.check === "lacey_printed_permit_count")!;
    expect(v.expected).toBe(14);
    expect(v.observed).toBe(12);
  });

  it("catches a units↔valuation column swap (money value in the units column)", async () => {
    const adapter = new LaceyPermitReportsAdapter();
    const raw = rawArtifact(await readFile(join(FIXTURES_DIR, JUNE)), "x/2026-06", {
      reportMonth: "2026-06",
    });
    const parsed = await adapter.parse(raw, testContext(adapter.key));
    (parsed[0]!.record as { units: number | null }).units = 15_519_768; // a valuation
    const violations = await adapter.checkInvariants(raw, parsed);
    expect(violations.map((v) => v.check)).toContain("lacey_units_shape");
  });
});
