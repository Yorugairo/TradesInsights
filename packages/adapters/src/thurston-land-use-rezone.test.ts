import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NormalizedSourceRecordSchema } from "@otn/domain";
import type { DiscoveredArtifact, RawArtifact } from "@otn/source-sdk";
import { ThurstonLandUseRezoneAdapter } from "./thurston-land-use-rezone.js";
import { FIXTURES_DIR, testContext } from "./test-utils.js";

/**
 * WS-G G.3 — Thurston rezone / Comp-Plan-Amendment VERIFY-FIRST SCAFFOLD
 * (disabled). Fixtures are CLEARLY-LABELED SYNTHETIC (see dockets.index.json).
 */
const DIR = join(FIXTURES_DIR, "thurston_land_use_rezone");
const INDEX = join(DIR, "dockets.index.json");
const GOLDEN = join(DIR, "dockets.golden.json");
const MALFORMED = join(DIR, "dockets.malformed.json");

function rawIndex(body: Buffer): RawArtifact {
  const discovered: DiscoveredArtifact = {
    idempotencyKey: "test:thurston_rezone",
    canonicalUrl:
      "https://www.thurstoncountywa.gov/departments/community-planning-and-economic-development/community-planning/plans-programs-and-code-projects/comprehensive-plan-and-development-code-dockets",
    parentUrl: null,
    expectedContentType: "application/json",
    sourcePublishedAt: null,
  };
  return { discovered, body, contentType: "application/json", httpStatus: 200, headers: {}, retrievedAt: new Date("2026-07-21T00:00:00Z") };
}

describe("thurston_land_use_rezone — parses the SYNTHETIC rezone docket capture", () => {
  it("emits one record per docket case and matches the golden", async () => {
    const adapter = new ThurstonLandUseRezoneAdapter();
    const raw = rawIndex(await readFile(INDEX));
    const parsed = await adapter.parse(raw, testContext(adapter.key));

    expect(adapter.checkInvariants(raw, parsed)).toEqual([]);
    expect(parsed.length).toBe(4);

    const golden = JSON.parse(await readFile(GOLDEN, "utf8"));
    expect(parsed.map((p) => p.record)).toEqual(golden);

    for (const p of parsed) {
      const v = NormalizedSourceRecordSchema.safeParse(p.record);
      expect(v.success, JSON.stringify(v.success ? null : v.error.issues)).toBe(true);
      expect(p.record.county).toBe("Thurston");
      expect(p.record.permittingJurisdiction).toBe("Thurston County");
      expect(p.record.organizations).toEqual([]); // owner PII stays out of the bridge
      expect(p.rawFields.intendedEventTypes).toContain("sepa_determination");
    }
  });

  it("routes a SEPA-most-advanced row to sepa_document → sepa_determination", async () => {
    const adapter = new ThurstonLandUseRezoneAdapter();
    const parsed = await adapter.parse(rawIndex(await readFile(INDEX)), testContext(adapter.key));
    const sepa = parsed.find((p) => p.record.externalId === "2026-REZ-004")!;
    expect(sepa.record.recordType).toBe("sepa_document"); // resolver → sepa_determination
    expect(sepa.record.normalizedStage).toBe("entitlement");
    expect(sepa.rawFields.derivedEventType).toBe("sepa_determination");
  });

  it("declares plat_approved on an adoption row but keeps the stage honest (entitlement, not approved)", async () => {
    const adapter = new ThurstonLandUseRezoneAdapter();
    const parsed = await adapter.parse(rawIndex(await readFile(INDEX)), testContext(adapter.key));
    const adopted = parsed.find((p) => p.record.externalId === "CPA-20")!;
    expect(adopted.record.recordType).toBe("public_notice"); // no recordType maps to plat_approved
    expect(adopted.rawFields.derivedEventType).toBe("plat_approved");
    expect(adopted.record.normalizedStage).toBe("entitlement"); // never claims approved off the index
  });

  it("keeps a bare listing with no dated document at normalizedStage unknown (honest null)", async () => {
    const adapter = new ThurstonLandUseRezoneAdapter();
    const parsed = await adapter.parse(rawIndex(await readFile(INDEX)), testContext(adapter.key));
    const bare = parsed.find((p) => p.record.externalId === "2027-REZ-001")!;
    expect(bare.record.normalizedStage).toBe("unknown");
    expect(bare.record.documentType).toBeNull();
    expect(bare.record.sourceUpdatedAt).toBeNull();
  });

  it("is idempotent across reruns of the same capture", async () => {
    const adapter = new ThurstonLandUseRezoneAdapter();
    const a = await adapter.parse(rawIndex(await readFile(INDEX)), testContext(adapter.key));
    const b = await adapter.parse(rawIndex(await readFile(INDEX)), testContext(adapter.key));
    expect(a.map((p) => p.record)).toEqual(b.map((p) => p.record));
  });
});

describe("thurston_land_use_rezone — discovery & disabled verify-first gate", () => {
  it("discovers the single rezone-docket artifact", async () => {
    const adapter = new ThurstonLandUseRezoneAdapter();
    const arts = await adapter.discover(testContext(adapter.key));
    expect(arts).toHaveLength(1);
    expect(arts[0]!.idempotencyKey).toBe("thurston_land_use_rezone:rezone_docket");
  });

  it("fetch dead-letters (disabled verify-first scaffold)", async () => {
    const adapter = new ThurstonLandUseRezoneAdapter();
    const [art] = await adapter.discover(testContext(adapter.key));
    await expect(adapter.fetch(art!, testContext(adapter.key))).rejects.toThrow(/verify-first|capture-fed|dead-letter/i);
  });

  it("an empty body throws", async () => {
    const adapter = new ThurstonLandUseRezoneAdapter();
    await expect(adapter.parse(rawIndex(Buffer.alloc(0)), testContext(adapter.key))).rejects.toThrow(/empty artifact/i);
  });

  it("malformed JSON throws", async () => {
    const adapter = new ThurstonLandUseRezoneAdapter();
    await expect(
      adapter.parse(rawIndex(Buffer.from("{not json", "utf8")), testContext(adapter.key)),
    ).rejects.toThrow(/not valid JSON/i);
  });

  it("a shape-broken index (SYNTHETIC failure fixture) throws the schema guard", async () => {
    const adapter = new ThurstonLandUseRezoneAdapter();
    await expect(
      adapter.parse(rawIndex(await readFile(MALFORMED)), testContext(adapter.key)),
    ).rejects.toThrow(/shape validation/i);
  });
});
