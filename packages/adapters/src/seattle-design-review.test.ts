import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NormalizedSourceRecordSchema } from "@otn/domain";
import type { DiscoveredArtifact, RawArtifact } from "@otn/source-sdk";
import { SeattleDesignReviewAdapter } from "./seattle-design-review.js";
import { FIXTURES_DIR, testContext } from "./test-utils.js";

/**
 * WS-G G.2 — Seattle Design Review Board VERIFY-FIRST SCAFFOLD (disabled).
 * The fixtures are CLEARLY-LABELED SYNTHETIC (see drb-agenda.index.json); these
 * tests prove the parser shape + discipline only, never a live capture.
 */
const DIR = join(FIXTURES_DIR, "seattle_design_review");
const INDEX = join(DIR, "drb-agenda.index.json");
const GOLDEN = join(DIR, "drb-agenda.golden.json");
const MALFORMED = join(DIR, "drb-agenda.malformed.json");

function rawIndex(body: Buffer): RawArtifact {
  const discovered: DiscoveredArtifact = {
    idempotencyKey: "test:seattle_dr",
    canonicalUrl: "https://www.seattle.gov/sdci/about-us/who-we-are/design-review/virtual-board-meetings",
    parentUrl: null,
    expectedContentType: "application/json",
    sourcePublishedAt: null,
  };
  return { discovered, body, contentType: "application/json", httpStatus: 200, headers: {}, retrievedAt: new Date("2026-07-21T00:00:00Z") };
}

describe("seattle_design_review — parses the SYNTHETIC DRB calendar capture", () => {
  it("emits one pre-permit record per distinct dated meeting and matches the golden", async () => {
    const adapter = new SeattleDesignReviewAdapter();
    const raw = rawIndex(await readFile(INDEX));
    const parsed = await adapter.parse(raw, testContext(adapter.key));

    expect(adapter.checkInvariants(raw, parsed)).toEqual([]);
    // 4 meetings, one project twice (EDG + Recommendation) → 4 distinct records.
    expect(parsed.length).toBe(4);

    const golden = JSON.parse(await readFile(GOLDEN, "utf8"));
    expect(parsed.map((p) => p.record)).toEqual(golden);

    for (const p of parsed) {
      const v = NormalizedSourceRecordSchema.safeParse(p.record);
      expect(v.success, JSON.stringify(v.success ? null : v.error.issues)).toBe(true);
      expect(p.record.county).toBe("King");
      expect(p.record.permittingJurisdiction).toBe("City of Seattle");
      expect(p.record.recordType).toBe("public_notice"); // resolver → notice_published
      expect(p.record.normalizedStage).toBe("entitlement"); // pre-permit
      expect(p.record.organizations).toEqual([]); // party data in the PDF, not fetched
      // decision_issued (Recommendation outcome) is declared as an intended event.
      expect(p.rawFields.intendedEventTypes).toContain("notice_published");
      expect(p.rawFields.intendedEventTypes).toContain("decision_issued");
    }
  });

  it("keys each dated meeting so EDG and Recommendation for one project are distinct", async () => {
    const adapter = new SeattleDesignReviewAdapter();
    const parsed = await adapter.parse(rawIndex(await readFile(INDEX)), testContext(adapter.key));
    const ids = parsed.map((p) => p.record.externalId);
    expect(ids).toContain("3099001-EG@2026-05-14");
    expect(ids).toContain("3099001-EG@2026-07-09");
    expect(new Set(ids).size).toBe(ids.length); // no collisions
  });

  it("is idempotent across reruns of the same capture", async () => {
    const adapter = new SeattleDesignReviewAdapter();
    const a = await adapter.parse(rawIndex(await readFile(INDEX)), testContext(adapter.key));
    const b = await adapter.parse(rawIndex(await readFile(INDEX)), testContext(adapter.key));
    expect(a.map((p) => p.record)).toEqual(b.map((p) => p.record));
  });
});

describe("seattle_design_review — discovery & disabled verify-first gate", () => {
  it("discovers the single DRB calendar artifact", async () => {
    const adapter = new SeattleDesignReviewAdapter();
    const arts = await adapter.discover(testContext(adapter.key));
    expect(arts).toHaveLength(1);
    expect(arts[0]!.idempotencyKey).toBe("seattle_design_review:drb_calendar");
  });

  it("fetch dead-letters (disabled verify-first scaffold) rather than driving a bot", async () => {
    const adapter = new SeattleDesignReviewAdapter();
    const [art] = await adapter.discover(testContext(adapter.key));
    await expect(adapter.fetch(art!, testContext(adapter.key))).rejects.toThrow(/verify-first|capture-fed|dead-letter/i);
  });

  it("an empty body throws instead of emitting nothing silently", async () => {
    const adapter = new SeattleDesignReviewAdapter();
    await expect(adapter.parse(rawIndex(Buffer.alloc(0)), testContext(adapter.key))).rejects.toThrow(/empty artifact/i);
  });

  it("malformed JSON throws rather than silently parsing to nothing", async () => {
    const adapter = new SeattleDesignReviewAdapter();
    await expect(
      adapter.parse(rawIndex(Buffer.from("{not json", "utf8")), testContext(adapter.key)),
    ).rejects.toThrow(/not valid JSON/i);
  });

  it("a shape-broken index (SYNTHETIC failure fixture) throws the schema guard", async () => {
    const adapter = new SeattleDesignReviewAdapter();
    await expect(
      adapter.parse(rawIndex(await readFile(MALFORMED)), testContext(adapter.key)),
    ).rejects.toThrow(/shape validation/i);
  });
});
