import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NormalizedSourceRecordSchema } from "@otn/domain";
import type { DiscoveredArtifact, RawArtifact } from "@otn/source-sdk";
import { OlympiaSmartgovReportsAdapter } from "./olympia-smartgov-reports.js";
import { FIXTURES_DIR, testContext } from "./test-utils.js";

const PDF = join(FIXTURES_DIR, "olympia_smartgov_reports", "permits-issued-last-30-days.pdf");

function rawPdf(body: Buffer): RawArtifact {
  const discovered: DiscoveredArtifact = {
    idempotencyKey: "test:olympia",
    canonicalUrl: "https://ci-olympia-wa.smartgovcommunity.com/Public/ReportsView#report=test",
    parentUrl: null,
    expectedContentType: "application/pdf",
    sourcePublishedAt: null,
  };
  return {
    discovered,
    body,
    contentType: "application/pdf",
    httpStatus: 200,
    headers: {},
    retrievedAt: new Date("2026-07-19T00:00:00Z"),
  };
}

describe("olympia_smartgov_reports — positional parse reconciles with the report's printed totals", () => {
  it("parses every permit and self-reconciles (per-category + Grand Total: 572)", async () => {
    const adapter = new OlympiaSmartgovReportsAdapter();
    const raw = rawPdf(await readFile(PDF));
    const parsed = await adapter.parse(raw, testContext(adapter.key));

    // The report prints Grand Total: 572; a correct parse yields exactly that,
    // and every category count matches its printed "Total … Permits: N".
    expect(adapter.checkInvariants(raw, parsed)).toEqual([]);
    expect(parsed.length).toBe(572);

    // Every emitted record is schema-valid.
    for (const p of parsed.slice(0, 40)) {
      const v = NormalizedSourceRecordSchema.safeParse(p.record);
      expect(v.success, JSON.stringify(v.success ? null : v.error.issues)).toBe(true);
      expect(p.record.county).toBe("Thurston");
      expect(p.record.permittingJurisdiction).toBe("City of Olympia");
      expect(p.record.normalizedStage).toBe("permit_issued");
    }
  });

  it("maps the first ADU permit (26-3143) field-by-field", async () => {
    const adapter = new OlympiaSmartgovReportsAdapter();
    const raw = rawPdf(await readFile(PDF));
    const parsed = await adapter.parse(raw, testContext(adapter.key));

    const rec = parsed.find((p) => p.record.externalId === "26-3143");
    expect(rec, "permit 26-3143 present").toBeDefined();
    const r = rec!.record;
    expect(r.permitType).toBe("Accessory Dwelling Unit (ADU)");
    expect(r.issueDate).toBe("2026-07-10");
    expect(r.addressRaw).toContain("235 THOMAS ST NW");
    const applicant = r.organizations.find((o) => o.role === "applicant")!;
    expect(applicant.name).toBe("ROBINSON, JIM");
    // A person applicant (SURNAME, GIVEN) is flagged non-business; no PII identifiers attached.
    expect(rec!.rawFields.applicantIsBusiness).toBe(false);
    expect(applicant.phone).toBeUndefined();
    expect(applicant.address).toBeUndefined();
  });

  it("flags a business applicant (Olympic Roofing LLC on 26-3536)", async () => {
    const adapter = new OlympiaSmartgovReportsAdapter();
    const raw = rawPdf(await readFile(PDF));
    const parsed = await adapter.parse(raw, testContext(adapter.key));
    const rec = parsed.find((p) => p.record.externalId === "26-3536");
    expect(rec, "permit 26-3536 present").toBeDefined();
    expect(rec!.record.organizations[0]!.name).toContain("OLYMPIC ROOFING");
    expect(rec!.rawFields.applicantIsBusiness).toBe(true);
  });
});

describe("olympia_smartgov_reports — discovery & capture-fed gate", () => {
  it("discovers the single issued-permits report artifact", async () => {
    const adapter = new OlympiaSmartgovReportsAdapter();
    const arts = await adapter.discover(testContext(adapter.key));
    expect(arts).toHaveLength(1);
    expect(arts[0]!.idempotencyKey).toBe("olympia_smartgov_reports:permits_issued_last_30_days");
  });

  it("fetch dead-letters (session-bound eid gate) rather than fabricating", async () => {
    const adapter = new OlympiaSmartgovReportsAdapter();
    const [art] = await adapter.discover(testContext(adapter.key));
    await expect(adapter.fetch(art!, testContext(adapter.key))).rejects.toThrow(/capture-fed|eid/i);
  });

  it("an empty body throws instead of emitting nothing silently", async () => {
    const adapter = new OlympiaSmartgovReportsAdapter();
    await expect(adapter.parse(rawPdf(Buffer.alloc(0)), testContext(adapter.key))).rejects.toThrow(
      /empty artifact/i,
    );
  });
});
