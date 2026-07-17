import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NormalizedSourceRecordSchema } from "@otn/domain";
import type { RawArtifact } from "@otn/source-sdk";
import { TacomaPermitsArcgisAdapter, tacomaStage } from "./tacoma-permits-arcgis.js";
import { FIXTURES_DIR, testContext } from "./test-utils.js";

function rawArtifact(body: Buffer | string): RawArtifact {
  return {
    discovered: {
      idempotencyKey: "test:tacoma",
      canonicalUrl: "https://services3.arcgis.com/x/query",
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

describe("tacoma_permits_arcgis (golden fixture — live window page of 2026-07-17)", () => {
  it("parses all features with valid normalized records", async () => {
    const adapter = new TacomaPermitsArcgisAdapter();
    const body = await readFile(join(FIXTURES_DIR, "tacoma_permits_arcgis/window-page-1.json"));
    const parsed = await adapter.parse(rawArtifact(body), testContext(adapter.key));

    expect(parsed.length).toBe(1000); // manual count comparison, fixture metadata
    for (const p of parsed) {
      const v = NormalizedSourceRecordSchema.safeParse(p.record);
      expect(v.success, JSON.stringify(v.success ? null : v.error.issues)).toBe(true);
      expect(p.record.county).toBe("Pierce");
      expect(p.record.permittingJurisdiction).toBe("City of Tacoma");
      expect(p.record.city).toBe("Tacoma");
    }
    // Applicant organizations carry explicit source text (confirmed roles).
    const withOrg = parsed.filter((p) => p.record.organizations.length > 0);
    expect(withOrg.length).toBeGreaterThan(500);
    for (const p of withOrg.slice(0, 20)) {
      expect(p.record.organizations[0]!.evidenceText).toContain("applicant_name");
    }
    // Accela portal deep links are unescaped into working citation URLs.
    const linked = parsed.find((p) => p.record.sourceUrl.includes("aca-prod.accela.com"))!;
    expect(linked.record.sourceUrl).not.toContain("&amp;");
  });

  it("maps the Accela workflow vocabulary to §9 stages by pattern bucket", async () => {
    const adapter = new TacomaPermitsArcgisAdapter();
    const body = await readFile(join(FIXTURES_DIR, "tacoma_permits_arcgis/window-page-1.json"));
    const parsed = await adapter.parse(rawArtifact(body), testContext(adapter.key));

    const byStatus = new Map<string, string>();
    for (const p of parsed) byStatus.set(p.record.statusRaw ?? "", p.record.normalizedStage);
    expect(byStatus.get("Permit Issued")).toBe("permit_issued");
    expect(byStatus.get("Finaled")).toBe("complete");
    expect(byStatus.get("Cancelled")).toBe("withdrawn");
    expect(byStatus.get("Plan Review in Process")).toBe("permit_applied");
    expect(byStatus.get("Awaiting Resubmittal")).toBe("permit_applied");

    // Planning types route to entitlement while under review.
    expect(tacomaStage("Plan Review in Process", true)).toBe("entitlement");
    expect(tacomaStage("Some Future Status", false)).toBe("unknown"); // never guessed

    // 0 valuation / 0 housing_units are unknowns, never real zeros.
    const zeroVal = parsed.filter((p) => p.record.valuationUsd === 0);
    expect(zeroVal.length).toBe(0);
  });

  it("emits runner-rejectable records for malformed features", async () => {
    const adapter = new TacomaPermitsArcgisAdapter();
    const parsed = await adapter.parse(
      rawArtifact(JSON.stringify({ features: [{ attributes: { bad: true } }] })),
      testContext("tacoma_permits_arcgis"),
    );
    expect(parsed.length).toBe(1);
    expect(NormalizedSourceRecordSchema.safeParse(parsed[0]!.record).success).toBe(false);
  });
});
