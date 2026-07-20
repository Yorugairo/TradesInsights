import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NormalizedSourceRecordSchema } from "@otn/domain";
import type { DiscoveredArtifact, RawArtifact } from "@otn/source-sdk";
import { TumwaterSepaAdapter } from "./tumwater-sepa.js";
import { FIXTURES_DIR, testContext } from "./test-utils.js";

const INDEX = join(FIXTURES_DIR, "tumwater_sepa", "noa-sepa.index.json");

function rawIndex(body: Buffer): RawArtifact {
  const discovered: DiscoveredArtifact = {
    idempotencyKey: "test:tumwater",
    canonicalUrl:
      "https://www.ci.tumwater.wa.us/departments/community-development-department/permitting-building/notice-of-applications-sepa-determinations",
    parentUrl: null,
    expectedContentType: "application/json",
    sourcePublishedAt: null,
  };
  return {
    discovered,
    body,
    contentType: "application/json",
    httpStatus: 200,
    headers: {},
    retrievedAt: new Date("2026-07-19T00:00:00Z"),
  };
}

describe("tumwater_sepa — parses the captured NOA/SEPA index", () => {
  it("emits one record per notice row and self-reconciles against the index", async () => {
    const adapter = new TumwaterSepaAdapter();
    const raw = rawIndex(await readFile(INDEX));
    const parsed = await adapter.parse(raw, testContext(adapter.key));

    // Every row in the golden sample carries at least one notice → one record each.
    expect(adapter.checkInvariants(raw, parsed)).toEqual([]);
    expect(parsed.length).toBe(14);

    for (const p of parsed) {
      const v = NormalizedSourceRecordSchema.safeParse(p.record);
      expect(v.success, JSON.stringify(v.success ? null : v.error.issues)).toBe(true);
      expect(p.record.county).toBe("Thurston");
      expect(p.record.permittingJurisdiction).toBe("City of Tumwater");
      expect(p.record.city).toBe("Tumwater");
      expect(p.record.recordType).toBe("public_notice");
      // Outcome (approved vs denied) is inside the PDF we don't fetch — never inferred.
      expect(p.record.normalizedStage).toBe("unknown");
      // The index carries no party data; homeowner PII must not enter the bridge.
      expect(p.record.organizations).toEqual([]);
    }
  });

  it("maps a single-stage NOA row (5th Ave Townhomes, TUM-26-0115)", async () => {
    const adapter = new TumwaterSepaAdapter();
    const parsed = await adapter.parse(rawIndex(await readFile(INDEX)), testContext(adapter.key));

    const rec = parsed.find((p) => p.record.externalId === "TUM-26-0115");
    expect(rec, "TUM-26-0115 present").toBeDefined();
    const r = rec!.record;
    expect(r.title).toBe("TUM-26-0115 – 5th Ave Townhomes Preliminary Plat");
    expect(r.documentType).toBe("Notice of Application");
    expect(r.sourceUpdatedAt).toBe("2026-05-08");
    const notices = rec!.rawFields.notices as Array<Record<string, unknown>>;
    expect(notices).toHaveLength(1);
    expect(notices[0]!.isoDate).toBe("2026-05-08");
    expect(notices[0]!.external).toBe(false); // local Laserfiche doc
  });

  it("promotes the most-advanced stage and flags the external Ecology SEPA link (TUM-25-1421)", async () => {
    const adapter = new TumwaterSepaAdapter();
    const parsed = await adapter.parse(rawIndex(await readFile(INDEX)), testContext(adapter.key));

    const rec = parsed.find((p) => p.record.externalId === "TUM-25-1421");
    expect(rec, "TUM-25-1421 present").toBeDefined();
    const r = rec!.record;
    // NOA + SEPA + NOD present → documentType is the most-advanced (decision).
    expect(r.documentType).toBe("Notice of Decision");
    expect(r.sourceUpdatedAt).toBe("2026-05-22"); // latest of the three notice dates
    const notices = rec!.rawFields.notices as Array<Record<string, unknown>>;
    expect(notices).toHaveLength(3);
    const sepa = notices.find((n) => n.kind === "sepa_determination")!;
    expect(sepa.external).toBe(true); // apps.ecology.wa.gov record via ____isexternal=true
  });

  it("slugs a stable externalId for a row with no TUM case number", async () => {
    const adapter = new TumwaterSepaAdapter();
    const parsed = await adapter.parse(rawIndex(await readFile(INDEX)), testContext(adapter.key));

    const rec = parsed.find((p) => p.record.externalId === "notice-i-5-commerce-plat-vacation");
    expect(rec, "un-numbered I-5 Commerce row present").toBeDefined();
    expect(rec!.record.title).toBe("Notice – I-5 Commerce Plat Vacation");
    expect(rec!.rawFields.caseNumber).toBeNull();
  });
});

describe("tumwater_sepa — discovery & capture-fed gate", () => {
  it("discovers the single NOA/SEPA index artifact", async () => {
    const adapter = new TumwaterSepaAdapter();
    const arts = await adapter.discover(testContext(adapter.key));
    expect(arts).toHaveLength(1);
    expect(arts[0]!.idempotencyKey).toBe("tumwater_sepa:noa_sepa_index");
  });

  it("fetch dead-letters (Akamai edge gate) rather than driving a bot", async () => {
    const adapter = new TumwaterSepaAdapter();
    const [art] = await adapter.discover(testContext(adapter.key));
    await expect(adapter.fetch(art!, testContext(adapter.key))).rejects.toThrow(/capture-fed|akamai/i);
  });

  it("an empty body throws instead of emitting nothing silently", async () => {
    const adapter = new TumwaterSepaAdapter();
    await expect(
      adapter.parse(rawIndex(Buffer.alloc(0)), testContext(adapter.key)),
    ).rejects.toThrow(/empty artifact/i);
  });

  it("malformed JSON throws rather than silently parsing to nothing", async () => {
    const adapter = new TumwaterSepaAdapter();
    await expect(
      adapter.parse(rawIndex(Buffer.from("{not json", "utf8")), testContext(adapter.key)),
    ).rejects.toThrow(/not valid JSON/i);
  });

  it("a shape-changed index (no rows) throws the schema guard", async () => {
    const adapter = new TumwaterSepaAdapter();
    await expect(
      adapter.parse(rawIndex(Buffer.from(JSON.stringify({ surface: "x" }), "utf8")), testContext(adapter.key)),
    ).rejects.toThrow(/shape validation/i);
  });
});
