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

describe("wa_sepa WS2 — applicant contact + site geo (business-gated)", () => {
  it("promotes site parcels/geo and a business applicant's mailing address on the golden fixture", async () => {
    const adapter = new WaSepaAdapter();
    const body = await readFile(join(FIXTURES_DIR, "wa_sepa/window-90d.json"));
    const parsed = await adapter.parse(rawArtifact(body), testContext(adapter.key));

    expect(parsed.some((p) => p.record.parcelIds.length > 0)).toBe(true);
    expect(parsed.some((p) => p.record.geometry?.type === "Point")).toBe(true);
    expect(parsed.some((p) => p.record.addressRaw !== null)).toBe(true);
    // At least one business/agency applicant carries a promoted mailing address.
    expect(
      parsed.some((p) => p.record.organizations.some((o) => o.role === "applicant" && o.address)),
    ).toBe(true);
    // All 407 still schema-validate with the added fields.
    for (const p of parsed) {
      expect(NormalizedSourceRecordSchema.safeParse(p.record).success).toBe(true);
    }
  });

  it("attaches contact for a business, name-only for a person, never throws on garbled contact", async () => {
    const adapter = new WaSepaAdapter();
    const rows = [
      {
        separegisterid: "b1", sepanumber: "202600011", countyname: "THURSTON",
        applicantname: "Cascade Development LLC",
        applicantcontactinfo:
          "Cascade Development LLC\nJane Doe, PM\n500 Union Ave SE, Olympia, WA 98501\n(360) 555-0199\njane@cascade.com",
        siteparcelnumber: "12345, 67890",
        siteline1address: "9 Elm St", sitecityname: "Olympia", sitezipcode: "98501",
        sitelatitudedecimal: "47.04", sitelongitudedecimal: "-122.9",
        leadagencyfilenumber: "LU-26-0001",
      },
      {
        separegisterid: "p1", sepanumber: "202600012", countyname: "THURSTON",
        applicantname: "John Smith",
        applicantcontactinfo: "John Smith\n123 Main St, Olympia, WA 98501\njohn@gmail.com",
      },
      {
        separegisterid: "m1", sepanumber: "202600013", countyname: "THURSTON",
        applicantname: "Widget Builders LLC",
        applicantcontactinfo: "garbled contact with no structure",
      },
    ];
    const parsed = await adapter.parse(rawArtifact(JSON.stringify(rows)), testContext(adapter.key));
    expect(parsed.length).toBe(3);

    const biz = parsed[0]!.record;
    const bizApplicant = biz.organizations.find((o) => o.role === "applicant")!;
    expect(bizApplicant.address).toBe("500 Union Ave SE, Olympia, WA 98501");
    expect(bizApplicant.phone).toBe("(360) 555-0199");
    expect(biz.parcelIds).toEqual(["12345", "67890"]);
    expect(biz.geometry).toEqual({ type: "Point", coordinates: [-122.9, 47.04] });
    expect(biz.addressRaw).toBe("9 Elm St, Olympia 98501");
    expect(biz.city).toBe("Olympia");
    // The cross-source lead-agency file number rides in externalRef evidence.
    expect(biz.evidence.some((e) => e.factPath === "externalRef" && e.text.includes("LU-26-0001"))).toBe(true);

    // Private individual → name only; no PII identifiers attached.
    const person = parsed[1]!.record.organizations.find((o) => o.role === "applicant")!;
    expect(person.name).toBe("John Smith");
    expect(person.address).toBeUndefined();
    expect(person.phone).toBeUndefined();

    // Business name but unparseable contact → name only, still schema-valid.
    const garbled = parsed[2]!.record.organizations.find((o) => o.role === "applicant")!;
    expect(garbled.address).toBeUndefined();
    expect(NormalizedSourceRecordSchema.safeParse(parsed[2]!.record).success).toBe(true);
  });

  it("does not promote an address/phone for a family trust (M2 PII gate)", async () => {
    const adapter = new WaSepaAdapter();
    const rows = [
      {
        separegisterid: "t1",
        sepanumber: "202600021",
        countyname: "THURSTON",
        applicantname: "Smith Family Trust",
        applicantcontactinfo: "Smith Family Trust\n742 Evergreen Ter, Olympia, WA 98501\n(360) 555-0100",
      },
    ];
    const parsed = await adapter.parse(rawArtifact(JSON.stringify(rows)), testContext(adapter.key));
    const applicant = parsed[0]!.record.organizations.find((o) => o.role === "applicant")!;
    // "TRUST" is no longer a business marker → name only, no promoted PII.
    expect(applicant.name).toBe("Smith Family Trust");
    expect(applicant.address).toBeUndefined();
    expect(applicant.phone).toBeUndefined();
  });
});
