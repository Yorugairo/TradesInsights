import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NormalizedSourceRecordSchema } from "@otn/domain";
import type { RawArtifact } from "@otn/source-sdk";
import {
  ThurstonActiveNoticesAdapter,
  parseNoticeHeading,
} from "./thurston-active-notices.js";
import { FIXTURES_DIR, testContext } from "./test-utils.js";

function rawArtifact(body: Buffer | string): RawArtifact {
  return {
    discovered: {
      idempotencyKey: "test:thurston",
      canonicalUrl:
        "https://www.thurstoncountywa.gov/departments/community-planning-and-economic-development/permitting/comment-project",
      parentUrl: null,
      expectedContentType: "text/html",
      sourcePublishedAt: null,
    },
    body: Buffer.isBuffer(body) ? body : Buffer.from(body),
    contentType: "text/html",
    httpStatus: 200,
    headers: {},
    retrievedAt: new Date("2026-07-15T00:00:00Z"),
  };
}

describe("thurston_active_notices (golden fixture)", () => {
  it("parses accordion notices into one record per project", async () => {
    const adapter = new ThurstonActiveNoticesAdapter();
    const ctx = testContext(adapter.key);
    const body = await readFile(join(FIXTURES_DIR, "thurston_active_notices/landing.html"));
    const parsed = await adapter.parse(rawArtifact(body), ctx);

    expect(parsed.length).toBeGreaterThan(0);
    for (const p of parsed) {
      const v = NormalizedSourceRecordSchema.safeParse(p.record);
      expect(v.success, JSON.stringify(v.success ? null : v.error.issues)).toBe(true);
      expect(p.record.county).toBe("Thurston");
      expect(p.record.permittingJurisdiction).toBe("Thurston County");
    }

    const moore = parsed.find((p) => p.record.externalId === "2019101651")!;
    expect(moore.record.title).toContain("Moore Garage RUE");
    expect(moore.record.addressRaw).toBe("7434 Puget Beach RD NE, Olympia, WA 98516");
    expect(moore.record.description).toContain("Reasonable Use Exception");
    const mooreRaw = moore.rawFields as {
      notices: { heading: string; noticeDate: string | null; links: { url: string }[] }[];
    };
    expect(mooreRaw.notices[0]!.noticeDate).toBe("2026-07-28");
    expect(mooreRaw.notices[0]!.links.length).toBeGreaterThanOrEqual(2);

    const hernandez = parsed.find((p) => p.record.externalId === "2025100139")!;
    expect(hernandez.record.title).toContain("Hernandez RUE");
  });

  it("throws when the active-notices section is missing (migration canary)", async () => {
    const adapter = new ThurstonActiveNoticesAdapter();
    const ctx = testContext(adapter.key);
    await expect(
      adapter.parse(rawArtifact("<html><body><h1>New permitting portal</h1></body></html>")),
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ).rejects.toThrow(/page shape changed/);
    void ctx;
  });

  it("parseNoticeHeading extracts number, name, and date", () => {
    expect(
      parseNoticeHeading("Project Number: 2019101651 (Moore Garage RUE) Public Hearing - July 28, 2026, at 10 am"),
    ).toEqual({ projectNumber: "2019101651", projectName: "Moore Garage RUE", noticeDate: "2026-07-28" });
    expect(
      parseNoticeHeading("Project Number: 2025100139; (Hernandez RUE) Public Hearing - July 28, 2026 at 11:00 am"),
    ).toEqual({ projectNumber: "2025100139", projectName: "Hernandez RUE", noticeDate: "2026-07-28" });
    expect(parseNoticeHeading("Some unrelated heading")).toEqual({
      projectNumber: null,
      projectName: null,
      noticeDate: null,
    });
    // Numeric issuance-date style (both 4- and 2-digit years appear live).
    expect(parseNoticeHeading("Project Number: 2010100505; Date of Issuance: 3/23/2026")).toEqual({
      projectNumber: "2010100505",
      projectName: null,
      noticeDate: "2026-03-23",
    });
    expect(parseNoticeHeading("Project Number: 2025102556; Date of Issuance: 1/15/26")).toEqual({
      projectNumber: "2025102556",
      projectName: null,
      noticeDate: "2026-01-15",
    });
  });
});
