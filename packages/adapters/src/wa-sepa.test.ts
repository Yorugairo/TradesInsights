import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NormalizedSourceRecordSchema } from "@otn/domain";
import type { RawArtifact } from "@otn/source-sdk";
import { WaSepaAdapter } from "./wa-sepa.js";
import { FIXTURES_DIR, testContext } from "./test-utils.js";

function rawArtifact(body: Buffer | string, url = "https://data.wa.gov/resource/mmcb-z6jf.json?x"): RawArtifact {
  return {
    discovered: {
      idempotencyKey: `test:${url}`,
      canonicalUrl: url,
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

afterEach(() => vi.unstubAllGlobals());

describe("wa_sepa parse (golden fixture, 90-day pilot-county window)", () => {
  it("emits one valid record per register row with county mapping and orgs", async () => {
    const adapter = new WaSepaAdapter();
    const ctx = testContext(adapter.key);
    const body = await readFile(join(FIXTURES_DIR, "wa_sepa/window-90d.json"));
    const parsed = await adapter.parse(rawArtifact(body), ctx);

    expect(parsed.length).toBe(407);
    const counties = new Map<string, number>();
    for (const p of parsed) {
      const v = NormalizedSourceRecordSchema.safeParse(p.record);
      expect(v.success, JSON.stringify(v.success ? null : v.error.issues)).toBe(true);
      counties.set(p.record.county, (counties.get(p.record.county) ?? 0) + 1);
      expect(p.record.recordType).toBe("sepa_document");
      expect(p.record.normalizedStage).toBe("unknown"); // stage derivation is M2's job
    }
    expect(counties.get("King")).toBe(215);
    expect(counties.get("Pierce")).toBe(120);
    expect(counties.get("Thurston")).toBe(45);
    expect(counties.get("Lewis")).toBe(27);

    const first = parsed[0]!.record;
    expect(first.externalId).toBe("193986");
    expect(first.title).toContain("SEPA 202601471");
    expect(first.title).toContain("130th Place NE");
    expect(first.issueDate).toBeTruthy();
    expect(first.sourceUrl).toContain("apps.ecology.wa.gov/separ");
    // Lead agency and applicant become role-tagged organizations when stated.
    const withApplicant = parsed.find((p) =>
      p.record.organizations.some((o) => o.role === "applicant"),
    );
    expect(withApplicant).toBeTruthy();
    // Checkpoint = max leadagencyissuedate in the window (fixture max: 07-14).
    expect(ctx.savedCheckpoint).toEqual({ issueDateHighWater: "2026-07-14" });
  });

  it("skips rows outside pilot counties and rejects malformed rows via the runner boundary", async () => {
    const adapter = new WaSepaAdapter();
    const ctx = testContext(adapter.key);
    const rows = [
      { separegisterid: "1", sepanumber: "202600001", countyname: "SKAGIT" },
      { separegisterid: "2", sepanumber: "202600002", countyname: "KING", leadagencyname: "King County" },
      { bad: "row" },
    ];
    const parsed = await adapter.parse(rawArtifact(JSON.stringify(rows)), ctx);
    // SKAGIT skipped; KING valid; malformed emitted as runner-rejectable.
    expect(parsed.length).toBe(2);
    expect(NormalizedSourceRecordSchema.safeParse(parsed[0]!.record).success).toBe(true);
    expect(parsed[0]!.record.county).toBe("King");
    expect(NormalizedSourceRecordSchema.safeParse(parsed[1]!.record).success).toBe(false);
  });

  it("discovers bounded pilot-county pages from the count query", async () => {
    const adapter = new WaSepaAdapter();
    const ctx = testContext(adapter.key, { backfill: { from: "2026-04-16", to: "2026-07-15" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify([{ count: "407" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const items = await adapter.discover(ctx);
    expect(items.length).toBe(1);
    const url = decodeURIComponent(items[0]!.canonicalUrl);
    expect(url).toContain("countyname in('THURSTON','PIERCE','LEWIS','KING')");
    expect(url).toContain("leadagencyissuedate >= '2026-04-16");
    expect(url).toContain("leadagencyissuedate <= '2026-07-15");
    expect(url).toContain("$limit=1000");
  });
});
