import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NormalizedSourceRecordSchema } from "@otn/domain";
import type { RawArtifact } from "@otn/source-sdk";
import {
  KingPublicNoticesAdapter,
  permitNumbersFromCell,
  slugId,
} from "./king-public-notices.js";
import { FIXTURES_DIR, testContext } from "./test-utils.js";

function rawArtifact(body: Buffer | string): RawArtifact {
  return {
    discovered: {
      idempotencyKey: "test:king",
      canonicalUrl:
        "https://kingcounty.gov/en/dept/local-services/buildings-property/public-notices-permit-records-search/public-notices",
      parentUrl: null,
      expectedContentType: "text/html",
      sourcePublishedAt: null,
    },
    body: Buffer.isBuffer(body) ? body : Buffer.from(body),
    contentType: "text/html",
    httpStatus: 200,
    headers: {},
    retrievedAt: new Date("2026-07-15T00:00:00Z"),
  };
}

describe("king_public_notices (golden fixture)", () => {
  it("parses the rolling notices table into valid unincorporated-King records", async () => {
    const adapter = new KingPublicNoticesAdapter();
    const ctx = testContext(adapter.key);
    const body = await readFile(join(FIXTURES_DIR, "king_public_notices/landing.html"));
    const parsed = await adapter.parse(rawArtifact(body), ctx);

    expect(parsed.length).toBeGreaterThan(20);
    for (const p of parsed) {
      const v = NormalizedSourceRecordSchema.safeParse(p.record);
      expect(v.success, JSON.stringify(v.success ? null : v.error.issues)).toBe(true);
      expect(p.record.county).toBe("King");
      expect(p.record.permittingJurisdiction).toBe("Unincorporated King County");
      expect(p.record.normalizedStage).toBe("unknown"); // notices carry no explicit stage
    }

    const dwel = parsed.find((p) => p.record.externalId === "DWEL25-0209")!;
    expect(dwel.record.title).toBe("DWEL25-0209 – West Single Family Residence");
    expect(dwel.record.parcelIds).toEqual(["1823069034", "1823069080"]);
    expect(dwel.record.documentType).toContain("Notice of Application");
    const dwelRaw = dwel.rawFields as {
      accelaUrl: string | null;
      documents: { url: string; text: string }[];
    };
    expect(dwelRaw.accelaUrl).toContain("aca-prod.accela.com");
    expect(dwelRaw.documents.length).toBeGreaterThanOrEqual(3);

    // Multi-permit row keeps the first number as id, all numbers in rawFields.
    const multi = parsed.find((p) => p.record.externalId === "SHOR25-0022")!;
    expect((multi.rawFields as { permitNumbers: string[] }).permitNumbers).toEqual([
      "SHOR25-0022",
      "SHOR25-0023",
    ]);

    // Non-permit notices (non-project SEPA, STRC meetings) get stable slug ids.
    const nonPermit = parsed.filter((p) => p.record.externalId.startsWith("nonpermit-"));
    expect(nonPermit.length).toBeGreaterThan(0);
  });

  it("throws when the table yields zero records (schema change)", async () => {
    const adapter = new KingPublicNoticesAdapter();
    const ctx = testContext(adapter.key);
    await expect(
      adapter.parse(rawArtifact("<html><body><p>redesigned</p></body></html>"), ctx),
    ).rejects.toThrow(/zero records/);
  });

  it("permitNumbersFromCell and slugId helpers", () => {
    expect(permitNumbersFromCell("SHOR25-0022 / SHOR25-0023")).toEqual([
      "SHOR25-0022",
      "SHOR25-0023",
    ]);
    expect(permitNumbersFromCell("GRDE23-0083")).toEqual(["GRDE23-0083"]);
    expect(permitNumbersFromCell("Non-Project SEPA")).toEqual([]);
    expect(slugId("Non-Project SEPA", "Pacific Raceways Mod")).toBe(
      "nonpermit-non-project-sepa-pacific-raceways-mod",
    );
  });
});
