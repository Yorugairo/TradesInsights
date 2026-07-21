import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NormalizedSourceRecordSchema } from "@otn/domain";
import type { DiscoveredArtifact, RawArtifact } from "@otn/source-sdk";
import { ThurstonHearingExaminerAdapter } from "./thurston-hearing-examiner.js";
import { FIXTURES_DIR, testContext } from "./test-utils.js";

/**
 * WS-G G.2 — Thurston County Hearing Examiner VERIFY-FIRST SCAFFOLD (disabled).
 * Fixtures are CLEARLY-LABELED SYNTHETIC (see decisions.index.json).
 */
const DIR = join(FIXTURES_DIR, "thurston_hearing_examiner");
const INDEX = join(DIR, "decisions.index.json");
const GOLDEN = join(DIR, "decisions.golden.json");
const MALFORMED = join(DIR, "decisions.malformed.json");

function rawIndex(body: Buffer): RawArtifact {
  const discovered: DiscoveredArtifact = {
    idempotencyKey: "test:thurston_he",
    canonicalUrl:
      "https://www.thurstoncountywa.gov/departments/community-planning-and-economic-development/permitting/hearing-examiner/hearing-examiner-decisions",
    parentUrl: null,
    expectedContentType: "application/json",
    sourcePublishedAt: null,
  };
  return { discovered, body, contentType: "application/json", httpStatus: 200, headers: {}, retrievedAt: new Date("2026-07-21T00:00:00Z") };
}

describe("thurston_hearing_examiner — parses the SYNTHETIC decisions capture", () => {
  it("emits one entitlement record per decision and matches the golden", async () => {
    const adapter = new ThurstonHearingExaminerAdapter();
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
      expect(p.record.recordType).toBe("public_notice");
      // Approve/deny is inside the decision PDF (not fetched) → stage never claims approved.
      expect(p.record.normalizedStage).toBe("entitlement");
      expect(p.record.organizations).toEqual([]); // applicant is often a homeowner — PII stays out
      // decision_issued is the primary intended event, declared for activation.
      expect(p.rawFields.intendedEventTypes).toContain("decision_issued");
    }
  });

  it("expands the decision-type abbreviation and keys on case + type", async () => {
    const adapter = new ThurstonHearingExaminerAdapter();
    const parsed = await adapter.parse(rawIndex(await readFile(INDEX)), testContext(adapter.key));
    const sup = parsed.find((p) => p.record.externalId === "2026100001-SUP");
    expect(sup, "2026100001-SUP present").toBeDefined();
    expect(sup!.record.documentType).toBe("Special Use Permit Decision");
    expect(sup!.record.statusRaw).toBe("decision issued");
    expect(sup!.record.sourceUpdatedAt).toBe("2026-05-12");
  });

  it("is idempotent across reruns of the same capture", async () => {
    const adapter = new ThurstonHearingExaminerAdapter();
    const a = await adapter.parse(rawIndex(await readFile(INDEX)), testContext(adapter.key));
    const b = await adapter.parse(rawIndex(await readFile(INDEX)), testContext(adapter.key));
    expect(a.map((p) => p.record)).toEqual(b.map((p) => p.record));
  });
});

describe("thurston_hearing_examiner — discovery & disabled verify-first gate", () => {
  it("discovers the single decisions-index artifact", async () => {
    const adapter = new ThurstonHearingExaminerAdapter();
    const arts = await adapter.discover(testContext(adapter.key));
    expect(arts).toHaveLength(1);
    expect(arts[0]!.idempotencyKey).toBe("thurston_hearing_examiner:decisions_index");
  });

  it("fetch dead-letters (disabled verify-first scaffold)", async () => {
    const adapter = new ThurstonHearingExaminerAdapter();
    const [art] = await adapter.discover(testContext(adapter.key));
    await expect(adapter.fetch(art!, testContext(adapter.key))).rejects.toThrow(/verify-first|capture-fed|dead-letter/i);
  });

  it("an empty body throws", async () => {
    const adapter = new ThurstonHearingExaminerAdapter();
    await expect(adapter.parse(rawIndex(Buffer.alloc(0)), testContext(adapter.key))).rejects.toThrow(/empty artifact/i);
  });

  it("malformed JSON throws", async () => {
    const adapter = new ThurstonHearingExaminerAdapter();
    await expect(
      adapter.parse(rawIndex(Buffer.from("{not json", "utf8")), testContext(adapter.key)),
    ).rejects.toThrow(/not valid JSON/i);
  });

  it("a shape-broken index (SYNTHETIC failure fixture) throws the schema guard", async () => {
    const adapter = new ThurstonHearingExaminerAdapter();
    await expect(
      adapter.parse(rawIndex(await readFile(MALFORMED)), testContext(adapter.key)),
    ).rejects.toThrow(/shape validation/i);
  });
});
