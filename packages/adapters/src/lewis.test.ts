import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NormalizedSourceRecordSchema } from "@otn/domain";
import type { RawArtifact } from "@otn/source-sdk";
import {
  LewisCurrentPlanningAdapter,
  parseLandingRows,
  splitFileNumbers,
} from "./lewis-current-planning.js";
import { LewisSourceCanaryAdapter, unwrapSafelink } from "./lewis-source-canary.js";
import { FIXTURES_DIR, testContext } from "./test-utils.js";

async function fixture(rel: string): Promise<Buffer> {
  return readFile(join(FIXTURES_DIR, rel));
}

function rawArtifact(body: Buffer | string, url: string, meta?: Record<string, unknown>): RawArtifact {
  return {
    discovered: {
      idempotencyKey: `test:${url}`,
      canonicalUrl: url,
      parentUrl: null,
      expectedContentType: null,
      sourcePublishedAt: null,
      ...(meta ? { meta } : {}),
    },
    body: Buffer.isBuffer(body) ? body : Buffer.from(body),
    contentType: "text/html",
    httpStatus: 200,
    headers: {},
    retrievedAt: new Date("2026-07-15T00:00:00Z"),
  };
}

describe("lewis_current_planning landing table (golden fixture)", () => {
  it("parses every application row with file numbers, name, type, and detail link", async () => {
    const body = await fixture("lewis_current_planning/landing.html");
    const rows = parseLandingRows(
      body,
      "https://lewiscountywa.gov/departments/community-development/current-planning-applications/",
    );
    expect(rows.length).toBe(14);

    const first = rows[0]!;
    expect(first.fileNumbers).toEqual(["SUP25-0001", "SEP25-0011"]);
    expect(first.projectName).toBe("Good Crushing Inc – Mining Amendment Project");
    expect(first.applicationType).toBe("Special Use");
    expect(first.detailUrl).toBe(
      "https://lewiscountywa.gov/departments/community-development/current-planning-applications/sup25-0001-good-crushing/",
    );

    const roamers = rows.find((r) => r.fileNumbers[0] === "SUP25-0002")!;
    expect(roamers.projectName).toBe("Roamers RV Park Project");
  });

  it("splitFileNumbers keeps only real file-number tokens", () => {
    expect(splitFileNumbers("SUP25-0001 / SEP25-0011")).toEqual(["SUP25-0001", "SEP25-0011"]);
    expect(splitFileNumbers(" AP25-00004 / SEP25-0027 ")).toEqual(["AP25-00004", "SEP25-0027"]);
    expect(splitFileNumbers("File Number(s)")).toEqual([]);
  });
});

describe("lewis_current_planning detail parse (golden fixture)", () => {
  const meta = {
    kind: "application",
    fileNumbers: ["SUP25-0002"],
    projectName: "Roamers RV Park Project",
    applicationType: "Special Use",
  };

  it("emits one valid entitlement record with sectioned documents", async () => {
    const adapter = new LewisCurrentPlanningAdapter();
    const ctx = testContext(adapter.key);
    const body = await fixture("lewis_current_planning/detail-sup25-0002-roamers.html");
    const url =
      "https://lewiscountywa.gov/departments/community-development/current-planning-applications/sup25-0002-roamers-rv-park/";
    const [p] = await adapter.parse(rawArtifact(body, url, meta), ctx);

    const v = NormalizedSourceRecordSchema.safeParse(p!.record);
    expect(v.success, JSON.stringify(v.success ? null : v.error.issues)).toBe(true);
    const r = p!.record;
    expect(r.externalId).toBe("SUP25-0002");
    expect(r.title).toBe("SUP25-0002 – Roamers RV Park Project");
    expect(r.county).toBe("Lewis");
    expect(r.permittingJurisdiction).toBe("Lewis County");
    expect(r.applicationType).toBe("Special Use");
    expect(r.statusRaw).toBe("under review");
    expect(r.normalizedStage).toBe("entitlement");

    const docs = (p!.rawFields as { documents: { url: string; text: string }[] }).documents;
    expect(docs.length).toBeGreaterThan(30);
    expect(docs[0]!.url).toContain("/documents/");
    expect(docs.some((d) => /Notice of Hearing/i.test(d.text))).toBe(true);
  });

  it("landing artifact parses to zero records (stored for provenance only)", async () => {
    const adapter = new LewisCurrentPlanningAdapter();
    const ctx = testContext(adapter.key);
    const body = await fixture("lewis_current_planning/landing.html");
    const parsed = await adapter.parse(
      rawArtifact(body, "https://lewiscountywa.gov/x", { kind: "landing" }),
      ctx,
    );
    expect(parsed).toEqual([]);
  });

  it("throws when the detail page has no h1 (schema change)", async () => {
    const adapter = new LewisCurrentPlanningAdapter();
    const ctx = testContext(adapter.key);
    await expect(
      adapter.parse(rawArtifact("<html><body><p>redesign</p></body></html>", "https://lewiscountywa.gov/x", meta), ctx),
    ).rejects.toThrow(/no h1/);
  });
});

describe("lewis_source_canary (golden fixture)", () => {
  it("finds planning, permits, records, and portal links and emits one record", async () => {
    const adapter = new LewisSourceCanaryAdapter();
    const ctx = testContext(adapter.key);
    const body = await fixture("lewis_source_canary/landing.html");
    const [p] = await adapter.parse(
      rawArtifact(body, "https://lewiscountywa.gov/departments/community-development/"),
      ctx,
    );
    expect(NormalizedSourceRecordSchema.safeParse(p!.record).success).toBe(true);
    const links = (p!.rawFields as { links: Record<string, string | null> }).links;
    expect(links["planning"]).toContain("current-planning-applications");
    expect(links["permits"]).toContain("building-permit-data");
    expect(links["records"]).toContain("docs.lewiscountywa.gov");
    // SmartGov hostname discovered from the official page (never guessed),
    // unwrapped from the Outlook safelink.
    expect(links["portal"]).toContain("co-lewis-wa.smartgovcommunity.com");
  });

  it("throws (canary alarm) when a required link disappears", async () => {
    const adapter = new LewisSourceCanaryAdapter();
    const ctx = testContext(adapter.key);
    await expect(
      adapter.parse(
        rawArtifact(
          "<html><body><a href='/departments/community-development/building-permit-data/'>Permits</a></body></html>",
          "https://lewiscountywa.gov/departments/community-development/",
        ),
        ctx,
      ),
    ).rejects.toThrow(/required link\(s\) missing: planning/);
  });

  it("unwrapSafelink decodes Outlook safelinks and passes other URLs through", () => {
    expect(
      unwrapSafelink(
        "https://gcc02.safelinks.protection.outlook.com/?url=https%3A%2F%2Fco-lewis-wa.smartgovcommunity.com%2FPublic%2FHome&data=x",
      ),
    ).toBe("https://co-lewis-wa.smartgovcommunity.com/Public/Home");
    expect(unwrapSafelink("https://example.gov/a")).toBe("https://example.gov/a");
    expect(unwrapSafelink("not a url")).toBe("not a url");
  });
});
