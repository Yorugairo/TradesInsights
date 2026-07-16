import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NormalizedSourceRecordSchema } from "@otn/domain";
import type { RawArtifact } from "@otn/source-sdk";
import { KingPermitReportsAdapter, reportInfoFromUrl } from "./king-permit-reports.js";
import { FIXTURES_DIR, testContext } from "./test-utils.js";

function rawArtifact(body: Buffer, url: string, meta: Record<string, unknown>): RawArtifact {
  return {
    discovered: {
      idempotencyKey: `test:${url}`,
      canonicalUrl: url,
      parentUrl: null,
      expectedContentType: null,
      sourcePublishedAt: null,
      meta,
    },
    body,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    httpStatus: 200,
    headers: {},
    retrievedAt: new Date("2026-07-15T00:00:00Z"),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("king_permit_reports issued-permits xlsx (golden fixture)", () => {
  it("parses issued permits with header-keyed columns", async () => {
    const adapter = new KingPermitReportsAdapter();
    const ctx = testContext(adapter.key);
    const body = await readFile(
      join(FIXTURES_DIR, "king_permit_reports/kingcounty-issued-permits-2026-06.xlsx"),
    );
    const parsed = await adapter.parse(
      rawArtifact(body, "https://cdn.kingcounty.gov/x/kingcounty-issued-permits-2026-06.xlsx", {
        kind: "issued_permits",
        month: "2026-06",
      }),
      ctx,
    );
    expect(parsed.length).toBeGreaterThan(100);
    for (const p of parsed) {
      const v = NormalizedSourceRecordSchema.safeParse(p.record);
      expect(v.success, JSON.stringify(v.success ? null : v.error.issues)).toBe(true);
      expect(p.record.county).toBe("King");
      expect(p.record.permittingJurisdiction).toBe("Unincorporated King County");
      expect(p.record.normalizedStage).toBe("permit_issued");
    }

    const addc = parsed.find((p) => p.record.externalId === "ADDC22-0668")!;
    expect(addc.record.title).toContain("CONWELL SHOP");
    expect(addc.record.issueDate).toBe("2026-06-05");
    expect(addc.record.applicationDate).toBe("2022-12-20");
    expect(addc.record.valuationUsd).toBeCloseTo(342941.32);
    expect(addc.record.parcelIds).toEqual(["1220069074"]);
    expect(addc.record.statusRaw).toBe("Permit Issued");
    expect(addc.record.addressRaw).toContain("ENUMCLAW");
    expect(addc.record.organizations.map((o) => o.role)).toEqual(["applicant", "owner"]);
    const raw = addc.rawFields as { accelaUrl: string | null; parcelGisUrl: string | null };
    expect(raw.accelaUrl).toContain("accela.com");
    expect(raw.parcelGisUrl).toContain("parcelviewer");

    // D1 — the golden workbook reconciles; a value/date column swap is flagged.
    const artifact = rawArtifact(body, "https://cdn.kingcounty.gov/x/kingcounty-issued-permits-2026-06.xlsx", { kind: "issued_permits", month: "2026-06" });
    expect(adapter.checkInvariants!(artifact, parsed)).toEqual([]);
    const tampered = structuredClone(parsed);
    (tampered[0]!.record as { issueDate: string | null }).issueDate = "1970-01-01"; // epoch-ish → out of window
    expect(adapter.checkInvariants!(artifact, tampered).some((v) => v.check === "king_issue_date_window")).toBe(true);
  });

  it("parses new applications with permit_applied stage and zero job value → null", async () => {
    const adapter = new KingPermitReportsAdapter();
    const ctx = testContext(adapter.key);
    const body = await readFile(
      join(FIXTURES_DIR, "king_permit_reports/king-county-new-applications-2026-06.xlsx"),
    );
    const parsed = await adapter.parse(
      rawArtifact(body, "https://cdn.kingcounty.gov/x/kingcounty-new-applications-2026-06.xlsx", {
        kind: "new_applications",
        month: "2026-06",
      }),
      ctx,
    );
    expect(parsed.length).toBeGreaterThan(100);
    const flod = parsed.find((p) => p.record.externalId === "FLOD26-0179")!;
    expect(flod.record.normalizedStage).toBe("permit_applied");
    expect(flod.record.recordType).toBe("permit_application");
    expect(flod.record.applicationDate).toBe("2026-06-29");
    expect(flod.record.issueDate).toBeNull();
    // JOB VALUE 0 in the sheet → null, never zero.
    expect(flod.record.valuationUsd).toBeNull();
    expect(flod.record.statusRaw).toBe("Application Complete");
  });

  it("throws when no permit rows are found (layout change)", async () => {
    const adapter = new KingPermitReportsAdapter();
    const ctx = testContext(adapter.key);
    // A valid empty workbook.
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Sheet1");
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    await expect(
      adapter.parse(
        rawArtifact(buf, "https://cdn.kingcounty.gov/x/kingcounty-issued-permits-2026-06.xlsx", {
          kind: "issued_permits",
          month: "2026-06",
        }),
        ctx,
      ),
    ).rejects.toThrow(/no permit rows/);
  });
});

describe("king_permit_reports discovery", () => {
  it("reportInfoFromUrl handles both name variants and rejects others", () => {
    expect(
      reportInfoFromUrl("https://cdn.kingcounty.gov/x/king-county-issued-permits-2026-01.xlsx?rev=1"),
    ).toEqual({ kind: "issued_permits", month: "2026-01", ext: "xlsx" });
    expect(
      reportInfoFromUrl("https://cdn.kingcounty.gov/x/kingcounty-new-applications-2026-06.xlsx"),
    ).toEqual({ kind: "new_applications", month: "2026-06", ext: "xlsx" });
    expect(
      reportInfoFromUrl("https://cdn.kingcounty.gov/x/king-county-new-applications-2024-07.xls"),
    ).toEqual({ kind: "new_applications", month: "2024-07", ext: "xls" });
    expect(reportInfoFromUrl("https://cdn.kingcounty.gov/x/some-other-report.xlsx")).toBeNull();
  });

  it("discovers both kinds within the backfill window, skipping legacy .xls", async () => {
    const adapter = new KingPermitReportsAdapter();
    const ctx = testContext(adapter.key, { backfill: { from: "2026-04-16", to: "2026-07-15" } });
    const landing = await readFile(join(FIXTURES_DIR, "king_permit_reports/landing.html"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(landing, { status: 200, headers: { "content-type": "text/html" } })),
    );
    const items = await adapter.discover(ctx);
    const ids = items.map((i) => i.idempotencyKey).sort();
    expect(ids).toEqual([
      "king_permit_reports:issued_permits:2026-04",
      "king_permit_reports:issued_permits:2026-05",
      "king_permit_reports:issued_permits:2026-06",
      "king_permit_reports:new_applications:2026-04",
      "king_permit_reports:new_applications:2026-05",
      "king_permit_reports:new_applications:2026-06",
    ]);
  });

  it("normal runs use the month checkpoint with one-month overlap", async () => {
    const adapter = new KingPermitReportsAdapter();
    const ctx = testContext(adapter.key, { checkpoint: { monthHighWater: "2026-06" } });
    const landing = await readFile(join(FIXTURES_DIR, "king_permit_reports/landing.html"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(landing, { status: 200, headers: { "content-type": "text/html" } })),
    );
    const items = await adapter.discover(ctx);
    const months = [...new Set(items.map((i) => (i.meta as { month: string }).month))].sort();
    expect(months[0]).toBe("2026-05");
    expect(ctx.savedCheckpoint).toEqual({ monthHighWater: "2026-06" });
  });
});
