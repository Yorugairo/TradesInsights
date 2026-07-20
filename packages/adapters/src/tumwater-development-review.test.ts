import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NormalizedSourceRecordSchema } from "@otn/domain";
import type { DiscoveredArtifact, RawArtifact } from "@otn/source-sdk";
import {
  TumwaterDevelopmentReviewAdapter,
  agendaDateIso,
} from "./tumwater-development-review.js";
import { FIXTURES_DIR, testContext } from "./test-utils.js";

const INDEX = join(FIXTURES_DIR, "tumwater_development_review", "drc-agendas.index.json");

function rawIndex(body: Buffer): RawArtifact {
  const discovered: DiscoveredArtifact = {
    idempotencyKey: "test:tumwater-drc",
    canonicalUrl:
      "https://www.ci.tumwater.wa.us/departments/community-development-department/permitting-building/development-review",
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

describe("tumwater_development_review — parses the captured DRC agendas index", () => {
  it("emits one record per dated agenda row and self-reconciles", async () => {
    const adapter = new TumwaterDevelopmentReviewAdapter();
    const raw = rawIndex(await readFile(INDEX));
    const parsed = await adapter.parse(raw, testContext(adapter.key));

    expect(adapter.checkInvariants(raw, parsed)).toEqual([]);
    expect(parsed.length).toBe(80);

    for (const p of parsed) {
      const v = NormalizedSourceRecordSchema.safeParse(p.record);
      expect(v.success, JSON.stringify(v.success ? null : v.error.issues)).toBe(true);
      expect(p.record.county).toBe("Thurston");
      expect(p.record.permittingJurisdiction).toBe("City of Tumwater");
      expect(p.record.city).toBe("Tumwater");
      expect(p.record.recordType).toBe("public_notice");
      expect(p.record.documentType).toBe("development_review_agenda");
      expect(p.record.normalizedStage).toBe("unknown");
      // The index carries no party data; homeowner PII must not enter the bridge.
      expect(p.record.organizations).toEqual([]);
      expect(p.record.externalId).toMatch(/^drc-\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("maps a hyphen-format meeting date (07-23-2026)", async () => {
    const adapter = new TumwaterDevelopmentReviewAdapter();
    const parsed = await adapter.parse(rawIndex(await readFile(INDEX)), testContext(adapter.key));
    const rec = parsed.find((p) => p.record.externalId === "drc-2026-07-23");
    expect(rec, "07-23-2026 present").toBeDefined();
    expect(rec!.record.sourceUpdatedAt).toBe("2026-07-23");
    expect(rec!.record.title).toContain("2026-07-23");
    expect((rec!.rawFields as { url: string }).url).toMatch(/showpublisheddocument/);
  });

  it("handles the older slash date format (12/05/2024)", async () => {
    const adapter = new TumwaterDevelopmentReviewAdapter();
    const parsed = await adapter.parse(rawIndex(await readFile(INDEX)), testContext(adapter.key));
    const rec = parsed.find((p) => p.record.externalId === "drc-2024-12-05");
    expect(rec, "12/05/2024 present").toBeDefined();
    expect(rec!.record.sourceUpdatedAt).toBe("2024-12-05");
  });

  it("carries the meeting type through to statusRaw (a canceled meeting)", async () => {
    const adapter = new TumwaterDevelopmentReviewAdapter();
    const parsed = await adapter.parse(rawIndex(await readFile(INDEX)), testContext(adapter.key));
    const canceled = parsed.find((p) => p.record.statusRaw && /cancel/i.test(p.record.statusRaw));
    expect(canceled, "a canceled meeting is present").toBeDefined();
    expect(canceled!.record.evidence.some((e) => /canceled/i.test(e.text))).toBe(true);
  });

  it("agendaDateIso parses both separators and rejects non-dates", () => {
    expect(agendaDateIso("07-23-2026")).toBe("2026-07-23");
    expect(agendaDateIso("12/05/2024")).toBe("2024-12-05");
    expect(agendaDateIso("1/2/2025")).toBe("2025-01-02");
    expect(agendaDateIso("Special Meeting")).toBeNull();
    expect(agendaDateIso("2026-07-23")).toBeNull(); // ISO input is not the source format
  });
});

describe("tumwater_development_review — discovery & capture-fed gate", () => {
  it("discovers the single DRC agendas index artifact", async () => {
    const adapter = new TumwaterDevelopmentReviewAdapter();
    const arts = await adapter.discover(testContext(adapter.key));
    expect(arts).toHaveLength(1);
    expect(arts[0]!.idempotencyKey).toBe("tumwater_development_review:drc_agendas_index");
  });

  it("fetch dead-letters (Akamai edge gate) rather than driving a bot", async () => {
    const adapter = new TumwaterDevelopmentReviewAdapter();
    const [art] = await adapter.discover(testContext(adapter.key));
    await expect(adapter.fetch(art!, testContext(adapter.key))).rejects.toThrow(/capture-fed|akamai/i);
  });

  it("an empty body throws instead of emitting nothing silently", async () => {
    const adapter = new TumwaterDevelopmentReviewAdapter();
    await expect(
      adapter.parse(rawIndex(Buffer.alloc(0)), testContext(adapter.key)),
    ).rejects.toThrow(/empty artifact/i);
  });

  it("malformed JSON throws rather than silently parsing to nothing", async () => {
    const adapter = new TumwaterDevelopmentReviewAdapter();
    await expect(
      adapter.parse(rawIndex(Buffer.from("{not json", "utf8")), testContext(adapter.key)),
    ).rejects.toThrow(/not valid JSON/i);
  });

  it("a shape-changed index (no agenda_rows) throws the schema guard", async () => {
    const adapter = new TumwaterDevelopmentReviewAdapter();
    await expect(
      adapter.parse(rawIndex(Buffer.from(JSON.stringify({ surface: "x" }), "utf8")), testContext(adapter.key)),
    ).rejects.toThrow(/shape validation/i);
  });
});
