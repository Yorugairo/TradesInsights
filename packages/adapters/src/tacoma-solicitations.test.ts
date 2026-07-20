import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NormalizedSourceRecordSchema } from "@otn/domain";
import type { RawArtifact } from "@otn/source-sdk";
import { TacomaSolicitationsAdapter } from "./tacoma-solicitations.js";
import { FIXTURES_DIR, testContext } from "./test-utils.js";

function rawArtifact(body: Buffer, category: string): RawArtifact {
  return {
    discovered: {
      idempotencyKey: `test:tacoma-sol:${category}`,
      canonicalUrl: `https://tacoma.gov/.../${category}/`,
      parentUrl: null,
      expectedContentType: "text/html",
      sourcePublishedAt: null,
      meta: { category },
    },
    body,
    contentType: "text/html",
    httpStatus: 200,
    headers: {},
    retrievedAt: new Date("2026-07-17T00:00:00Z"),
  };
}

describe("tacoma_solicitations (golden fixtures — live pages of 2026-07-17)", () => {
  it("parses the public-works table into bidding_confirmed solicitation records", async () => {
    const adapter = new TacomaSolicitationsAdapter();
    const body = await readFile(
      join(FIXTURES_DIR, "tacoma_solicitations/public-works-and-improvements-solicitations.html"),
    );
    const parsed = await adapter.parse(
      rawArtifact(body, "public-works-and-improvements-solicitations"),
      testContext(adapter.key),
    );
    expect(parsed.length).toBeGreaterThanOrEqual(3); // manual comparison in metadata.json
    for (const p of parsed) {
      const v = NormalizedSourceRecordSchema.safeParse(p.record);
      expect(v.success, JSON.stringify(v.success ? null : v.error.issues)).toBe(true);
      expect(p.record.recordType).toBe("solicitation");
      // The one public signal allowed to say "bidding": an explicit solicitation.
      expect(p.record.normalizedStage).toBe("bidding_confirmed");
      expect(p.record.externalId).toMatch(/^[A-Z]{2}\d{2}-\d{3,5}[A-Z]?$/);
      expect(p.record.statusRaw).toContain("due");
    }
    const sidewalk = parsed.find((p) => p.record.externalId === "PW26-0068F")!;
    expect(sidewalk.record.title).toContain("2026 Sidewalk Replacement");
    expect(sidewalk.record.applicationDate).toBe("2026-07-02"); // Date Issued
    expect(sidewalk.record.description).toContain("07/21/2026");
  });

  it("parses services and supplies category pages too", async () => {
    const adapter = new TacomaSolicitationsAdapter();
    for (const cat of ["services-solicitations", "supplies-solicitations"]) {
      const body = await readFile(join(FIXTURES_DIR, `tacoma_solicitations/${cat}.html`));
      const parsed = await adapter.parse(rawArtifact(body, cat), testContext(adapter.key));
      expect(parsed.length).toBeGreaterThan(0);
      for (const p of parsed) {
        expect(NormalizedSourceRecordSchema.safeParse(p.record).success).toBe(true);
      }
    }
  });

  it("a layout change yields zero rows + a warning, never fabricated records", async () => {
    const adapter = new TacomaSolicitationsAdapter();
    const parsed = await adapter.parse(
      rawArtifact(Buffer.from("<html><body><p>redesigned page</p></body></html>"), "public-works"),
      testContext(adapter.key),
    );
    expect(parsed.length).toBe(0);
  });
});

describe("tacoma_solicitations WS5 — column-shift canary", () => {
  it("clean golden parse yields no invariant violations", async () => {
    const adapter = new TacomaSolicitationsAdapter();
    const raw = rawArtifact(
      await readFile(
        join(FIXTURES_DIR, "tacoma_solicitations/public-works-and-improvements-solicitations.html"),
      ),
      "public-works-and-improvements-solicitations",
    );
    const parsed = await adapter.parse(raw, testContext(adapter.key));
    expect(adapter.checkInvariants(raw, parsed)).toEqual([]);
  });

  it("flags a non-date in the due-date column", () => {
    const adapter = new TacomaSolicitationsAdapter();
    const drift = [
      { rawFields: { dueDate: "RFP" }, record: { externalId: "PW26-0140F" } },
    ] as unknown as Parameters<typeof adapter.checkInvariants>[1];
    const v = adapter.checkInvariants(
      null as unknown as Parameters<typeof adapter.checkInvariants>[0],
      drift,
    );
    expect(v.some((x) => x.check === "tacoma_solicitation_column_shift")).toBe(true);
  });
});
