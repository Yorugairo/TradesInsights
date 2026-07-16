import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NormalizedSourceRecordSchema } from "@otn/domain";
import { extractPdfTextItems } from "@otn/documents";
import type { RawArtifact } from "@otn/source-sdk";
import {
  LewisInspectionsAdapter,
  inspectionDateFromFilename,
  parseLewisInspectionPage,
} from "./lewis-inspections.js";
import { FIXTURES_DIR, testContext } from "./test-utils.js";

const GOLDEN = "lewis_inspections/07.15.2026_Scheduled_Inspections_-_Permitting.pdf";

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

describe("lewis_inspections daily PDF (2026-07-15 fixture)", () => {
  it("parses all 15 scheduled inspections with column separation intact", async () => {
    const pages = await extractPdfTextItems(await readFile(join(FIXTURES_DIR, GOLDEN)));
    const rows = pages.flatMap((p) => parseLewisInspectionPage(p.items));
    expect(rows.length).toBe(15); // printed inspector totals: 9 + 6

    // Inspection type vs reason are distinct columns even when adjacent.
    const foundation = rows.find((r) => r.permitNumber === "B26-00067")!;
    expect(foundation.inspectionType).toBe("FOUNDATION");
    expect(foundation.reason).toBe("REINSPECTION");

    const final = rows.find((r) => r.permitNumber === "B24-00423")!;
    expect(final.inspectionType).toBe("FINAL INSPECTION");
    expect(final.reason).toBe("REQUESTED");
    expect(final.projectDescription).toBe("Single Family Residence");

    // Wrapped multi-line description stays with its row.
    const wrapped = rows.find((r) => r.permitNumber === "B26-00507")!;
    expect(wrapped.projectDescription).toContain("existing shop structure for storage");

    // Inspector-total footers never leak into rows.
    for (const r of rows) {
      expect(JSON.stringify(r)).not.toMatch(/total inspection count/i);
    }
  });

  it("emits valid normalized inspection records: FINAL → near_final, others → construction", async () => {
    const adapter = new LewisInspectionsAdapter();
    const parsed = await adapter.parse(
      rawArtifact(
        await readFile(join(FIXTURES_DIR, GOLDEN)),
        "https://lewiscountywa.gov/media/documents/07.15.2026_Scheduled_Inspections_-_Permitting.pdf",
        { inspectionDate: "2026-07-15" },
      ),
      testContext(adapter.key),
    );
    expect(parsed.length).toBe(15);
    for (const p of parsed) {
      const v = NormalizedSourceRecordSchema.safeParse(p.record);
      expect(v.success, JSON.stringify(v.success ? null : v.error.issues)).toBe(true);
      expect(p.record.recordType).toBe("inspection");
      expect(p.record.county).toBe("Lewis");
      // The permit number rides in rawFields so resolution's explicit-reference
      // pass can merge the inspection into the existing permit project.
      expect((p.rawFields as { permitNumbers?: string[] }).permitNumbers).toHaveLength(1);
    }
    const final = parsed.find((p) => p.record.externalId.startsWith("B24-00423"))!;
    expect(final.record.normalizedStage).toBe("near_final");
    const footing = parsed.find((p) => p.record.externalId.startsWith("B26-00507"))!;
    expect(footing.record.normalizedStage).toBe("construction");
    // External IDs are unique per (permit, date, inspection).
    const ids = parsed.map((p) => p.record.externalId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("throws on a PDF with no inspection table (layout change)", async () => {
    const adapter = new LewisInspectionsAdapter();
    await expect(
      adapter.parse(rawArtifact(EMPTY_PDF, "https://lewiscountywa.gov/x.pdf"), testContext(adapter.key)),
    ).rejects.toThrow(/no inspection rows|layout/i);
  });

  it("inspectionDateFromFilename accepts the dated series only", () => {
    expect(
      inspectionDateFromFilename("https://x/documents/19707/07.15.2026_Scheduled_Inspections_-_Permitting.pdf"),
    ).toBe("2026-07-15");
    expect(inspectionDateFromFilename("https://x/media/documents/Exhibit_A_-_2026_Fee_Schedule_Final_Version.pdf")).toBeNull();
  });

  it("D1: clean parse has no column-shape violations; a drift is caught", async () => {
    const adapter = new LewisInspectionsAdapter();
    const raw = rawArtifact(await readFile(join(FIXTURES_DIR, GOLDEN)), "x", {
      inspectionDate: "2026-07-15",
    });
    const parsed = await adapter.parse(raw, testContext(adapter.key));
    // Descriptive type/reason values never look like permit numbers or dates.
    expect(adapter.checkInvariants(raw, parsed)).toEqual([]);

    // Simulate a horizontal column drift: a permit number bleeds into the
    // inspection-type column.
    const drifted = parsed.map((p) => ({
      ...p,
      rawFields: { ...p.rawFields, inspectionType: "B26-00067" },
    }));
    const violations = adapter.checkInvariants(raw, drifted);
    expect(violations.map((v) => v.check)).toContain("lewis_column_shift");
  });
});
