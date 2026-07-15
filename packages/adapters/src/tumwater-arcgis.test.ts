import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NormalizedSourceRecordSchema } from "@otn/domain";
import type { RawArtifact } from "@otn/source-sdk";
import { TumwaterDevelopmentArcgisAdapter, webMercatorToLonLat } from "./tumwater-arcgis.js";
import { FIXTURES_DIR, testContext } from "./test-utils.js";

function rawArtifact(body: Buffer | string): RawArtifact {
  return {
    discovered: {
      idempotencyKey: "test:tumwater",
      canonicalUrl: "https://services6.arcgis.com/x/query",
      parentUrl: null,
      expectedContentType: "application/json",
      sourcePublishedAt: null,
    },
    body: Buffer.isBuffer(body) ? body : Buffer.from(body),
    contentType: "application/json",
    httpStatus: 200,
    headers: {},
    retrievedAt: new Date("2026-07-15T00:00:00Z"),
  };
}

describe("tumwater_development_arcgis (golden fixture)", () => {
  it("parses the full layer snapshot with domain-mapped stages", async () => {
    const adapter = new TumwaterDevelopmentArcgisAdapter();
    const ctx = testContext(adapter.key);
    const body = await readFile(join(FIXTURES_DIR, "tumwater_development_arcgis/all-features.json"));
    const parsed = await adapter.parse(rawArtifact(body), ctx);

    expect(parsed.length).toBe(44);
    for (const p of parsed) {
      const v = NormalizedSourceRecordSchema.safeParse(p.record);
      expect(v.success, JSON.stringify(v.success ? null : v.error.issues)).toBe(true);
      expect(p.record.county).toBe("Thurston");
      expect(p.record.permittingJurisdiction).toBe("City of Tumwater");
    }

    const walmart = parsed.find((p) =>
      (p.rawFields as { PermitNumber: string | null }).PermitNumber?.includes("TUM-25-0648"),
    )!;
    expect(walmart.record.externalId).toBe("a258817b-0476-479a-bf10-79615ae762bc");
    expect(walmart.record.statusRaw).toBe("Reviewing Permits"); // RP code → official domain label
    expect(walmart.record.normalizedStage).toBe("permit_applied");
    expect(walmart.record.parcelIds).toEqual(["12703210900"]);
    expect((walmart.rawFields as { permitNumbers: string[] }).permitNumbers).toEqual([
      "TUM-25-0648",
      "TUM-25-0706",
    ]);
    // Web Mercator → WGS84 point near Tumwater.
    const [lng, lat] = walmart.record.geometry!.coordinates as [number, number];
    expect(lng).toBeGreaterThan(-123.1);
    expect(lng).toBeLessThan(-122.7);
    expect(lat).toBeGreaterThan(46.9);
    expect(lat).toBeLessThan(47.1);

    // Both codes and full-name statuses map (data contains e.g. "Under Construction").
    const stages = new Set(parsed.map((p) => p.record.normalizedStage));
    expect(stages.has("construction")).toBe(true);
    expect(stages.has("preapplication")).toBe(true);

    // Checkpoint = max last_edited_date.
    expect(ctx.savedCheckpoint).toHaveProperty("lastEditedHighWater");
  });

  it("emits runner-rejectable records for malformed features", async () => {
    const adapter = new TumwaterDevelopmentArcgisAdapter();
    const ctx = testContext(adapter.key);
    const parsed = await adapter.parse(
      rawArtifact(JSON.stringify({ features: [{ attributes: { bad: true } }] })),
      ctx,
    );
    expect(parsed.length).toBe(1);
    expect(NormalizedSourceRecordSchema.safeParse(parsed[0]!.record).success).toBe(false);
  });

  it("webMercatorToLonLat round-trips a known point", () => {
    const [lng, lat] = webMercatorToLonLat(-13683341.25, 5941196.29);
    expect(lng).toBeCloseTo(-122.92, 1);
    expect(lat).toBeCloseTo(46.99, 1);
  });
});
