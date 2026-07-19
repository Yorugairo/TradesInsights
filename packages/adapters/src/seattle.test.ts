import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NormalizedSourceRecordSchema } from "@otn/domain";
import type { RawArtifact } from "@otn/source-sdk";
import {
  SEATTLE_BUILDING_CONFIG,
  SEATTLE_LAND_USE_CONFIG,
  SeattleSocrataAdapter,
} from "./seattle-socrata.js";
import { SeattleSourceCanaryAdapter } from "./seattle-source-canary.js";
import { FIXTURES_DIR, testContext } from "./test-utils.js";

function rawArtifact(body: Buffer | string, url: string, meta?: Record<string, unknown>): RawArtifact {
  return {
    discovered: {
      idempotencyKey: `test:${url}`,
      canonicalUrl: url,
      parentUrl: null,
      expectedContentType: "application/json",
      sourcePublishedAt: null,
      ...(meta ? { meta } : {}),
    },
    body: Buffer.isBuffer(body) ? body : Buffer.from(body),
    contentType: "application/json",
    httpStatus: 200,
    headers: {},
    retrievedAt: new Date("2026-07-15T00:00:00Z"),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("seattle_building_permits parse (golden fixture)", () => {
  it("emits valid Seattle records with deterministic stage mapping", async () => {
    const adapter = new SeattleSocrataAdapter(SEATTLE_BUILDING_CONFIG);
    const ctx = testContext(adapter.key);
    const body = await readFile(join(FIXTURES_DIR, "seattle_building_permits/window-2026-06.json"));
    const parsed = await adapter.parse(rawArtifact(body, "https://data.seattle.gov/resource/76t5-zqzr.json?x"), ctx);

    expect(parsed.length).toBe(514);
    for (const p of parsed) {
      const v = NormalizedSourceRecordSchema.safeParse(p.record);
      expect(v.success, JSON.stringify(v.success ? null : v.error.issues)).toBe(true);
      expect(p.record.county).toBe("King");
      expect(p.record.permittingJurisdiction).toBe("City of Seattle");
      expect(p.record.city).toBe("Seattle");
    }

    const first = parsed[0]!.record;
    expect(first.externalId).toBe("7097350-CN");
    expect(first.applicationDate).toBe("2026-06-01T00:00:00.000");
    expect(first.valuationUsd).toBeCloseTo(219583);
    expect(first.units).toBe(1);
    expect(first.statusRaw).toBe("Corrections Required");
    expect(first.normalizedStage).toBe("permit_applied"); // no issueddate
    expect(first.addressRaw).toContain("3212 NW 69TH ST");

    // Stage mapping: issued/completed rows map deterministically.
    const issued = parsed.find((p) => p.record.issueDate && !( p.rawFields as {completeddate?: string}).completeddate);
    if (issued) expect(issued.record.normalizedStage).toBe("permit_issued");

    // Checkpoint advanced to max applieddate.
    expect(ctx.savedCheckpoint).toEqual({ appliedDateHighWater: "2026-06-30" });
  });

  it("D1 checkInvariants: golden parse is clean; a swapped valuation is flagged", async () => {
    const adapter = new SeattleSocrataAdapter(SEATTLE_BUILDING_CONFIG);
    const ctx = testContext(adapter.key);
    const raw = rawArtifact(
      await readFile(join(FIXTURES_DIR, "seattle_building_permits/window-2026-06.json")),
      "https://data.seattle.gov/resource/76t5-zqzr.json?x",
    );
    const parsed = await adapter.parse(raw, ctx);
    expect(adapter.checkInvariants!(raw, parsed)).toEqual([]); // reconciles

    // A column reorder lands a wild value in `cost` → out-of-range violation.
    const tampered = structuredClone(parsed);
    (tampered[0]!.record as { valuationUsd: number | null }).valuationUsd = 9_000_000_000;
    const violations = adapter.checkInvariants!(raw, tampered);
    expect(violations.some((v) => v.check === "seattle_valuation_range")).toBe(true);
  });

  it("emits a runner-rejectable record for a malformed row (missing permitnum)", async () => {
    const adapter = new SeattleSocrataAdapter(SEATTLE_BUILDING_CONFIG);
    const ctx = testContext(adapter.key);
    const parsed = await adapter.parse(
      rawArtifact(JSON.stringify([{ description: "no permitnum" }]), "https://x"),
      ctx,
    );
    expect(parsed.length).toBe(1);
    expect(NormalizedSourceRecordSchema.safeParse(parsed[0]!.record).success).toBe(false);
  });

  it("discovers bounded deterministic pages from the count query", async () => {
    const adapter = new SeattleSocrataAdapter(SEATTLE_BUILDING_CONFIG);
    const ctx = testContext(adapter.key, { backfill: { from: "2026-04-16", to: "2026-07-15" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify([{ count: "1536" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const items = await adapter.discover(ctx);
    expect(items.length).toBe(2); // ceil(1536/1000)
    expect(items[0]!.canonicalUrl).toContain("%24where=".replace("%24", "$"));
    expect(items[0]!.canonicalUrl).toContain("$limit=1000");
    expect(items[0]!.canonicalUrl).toContain("$offset=0");
    expect(items[1]!.canonicalUrl).toContain("$offset=1000");
    expect(items[0]!.canonicalUrl).toContain(encodeURIComponent("applieddate, permitnum"));
    // Bounded window, never unbounded.
    expect(decodeURIComponent(items[0]!.canonicalUrl)).toContain("applieddate >= '2026-04-16");
    expect(decodeURIComponent(items[0]!.canonicalUrl)).toContain("applieddate <= '2026-07-15");
  });
});

describe("seattle_land_use_permits parse (golden fixture)", () => {
  it("maps land-use stages to entitlement/approved", async () => {
    const adapter = new SeattleSocrataAdapter(SEATTLE_LAND_USE_CONFIG);
    const ctx = testContext(adapter.key);
    const body = await readFile(join(FIXTURES_DIR, "seattle_land_use_permits/window-90d.json"));
    const parsed = await adapter.parse(rawArtifact(body, "https://data.seattle.gov/resource/ht3q-kdvx.json?x"), ctx);
    expect(parsed.length).toBe(78);
    for (const p of parsed) {
      expect(NormalizedSourceRecordSchema.safeParse(p.record).success).toBe(true);
      expect(p.record.recordType).toBe("land_use_permit");
      expect(["entitlement", "approved"]).toContain(p.record.normalizedStage);
    }
  });
});

describe("seattle WS3 — contractor org + land-use decisiondate", () => {
  const buildingUrl = "https://data.seattle.gov/resource/76t5-zqzr.json?x";
  const landUseUrl = "https://data.seattle.gov/resource/ht3q-kdvx.json?x";

  it("emits the contractor company as a primary_contractor org (building only, sparse)", async () => {
    const adapter = new SeattleSocrataAdapter(SEATTLE_BUILDING_CONFIG);
    const body = await readFile(join(FIXTURES_DIR, "seattle_building_permits/window-2026-06.json"));
    const parsed = await adapter.parse(rawArtifact(body, buildingUrl), testContext(adapter.key));

    const cn = parsed.find((p) => p.record.externalId === "7145069-CN")!;
    expect(cn.record.organizations).toEqual([
      {
        name: "Steffen Deetjen",
        role: "primary_contractor",
        evidenceText: "contractorcompanyname: Steffen Deetjen",
      },
    ]);
    // Only the rows publishing a contractor carry one (sparse ~4/514).
    expect(parsed.filter((p) => p.record.organizations.length > 0).length).toBe(4);
  });

  it("drives land-use issueDate + approved stage off decisiondate, not issueddate", async () => {
    const adapter = new SeattleSocrataAdapter(SEATTLE_LAND_USE_CONFIG);
    const body = await readFile(join(FIXTURES_DIR, "seattle_land_use_permits/window-90d.json"));
    const parsed = await adapter.parse(rawArtifact(body, landUseUrl), testContext(adapter.key));

    const decided = parsed.find((p) => p.record.externalId === "3044068-LU")!;
    expect(decided.record.issueDate).toBe("2026-07-02");
    expect(decided.record.normalizedStage).toBe("approved");
    // Undecided land-use rows stay entitlement with a null issueDate.
    const pending = parsed.filter((p) => p.record.externalId !== "3044068-LU");
    expect(
      pending.every((p) => p.record.normalizedStage === "entitlement" && p.record.issueDate === null),
    ).toBe(true);
  });

  it("keeps building issueDate on issueddate (decisiondate change does not leak)", async () => {
    const adapter = new SeattleSocrataAdapter(SEATTLE_BUILDING_CONFIG);
    const body = await readFile(join(FIXTURES_DIR, "seattle_building_permits/window-2026-06.json"));
    const parsed = await adapter.parse(rawArtifact(body, buildingUrl), testContext(adapter.key));
    const issuedRec = parsed.find((p) => (p.rawFields as { issueddate?: string }).issueddate)!;
    expect(issuedRec.record.issueDate).toBe((issuedRec.rawFields as { issueddate: string }).issueddate);
    expect(issuedRec.record.normalizedStage).toBe("permit_issued");
  });
});

describe("seattle_source_canary (golden fixture)", () => {
  it("finds both dataset links on the research page", async () => {
    const adapter = new SeattleSourceCanaryAdapter();
    const ctx = testContext(adapter.key);
    const body = await readFile(join(FIXTURES_DIR, "seattle_source_canary/landing.html"));
    const [p] = await adapter.parse(rawArtifact(body, "https://www.seattle.gov/x"), ctx);
    const links = (p!.rawFields as { links: Record<string, string | null> }).links;
    expect(links["building_permits_dataset"]).toContain("76t5-zqzr");
    expect(links["land_use_permits_dataset"]).toContain("ht3q-kdvx");
    expect(NormalizedSourceRecordSchema.safeParse(p!.record).success).toBe(true);
  });

  it("throws (canary alarm) when a dataset link disappears", async () => {
    const adapter = new SeattleSourceCanaryAdapter();
    const ctx = testContext(adapter.key);
    await expect(
      adapter.parse(
        rawArtifact(
          '<html><body><a href="https://data.seattle.gov/Permitting/Building-Permits/76t5-zqzr">B</a></body></html>',
          "https://www.seattle.gov/x",
        ),
        ctx,
      ),
    ).rejects.toThrow(/missing.*land_use_permits_dataset/);
  });
});
