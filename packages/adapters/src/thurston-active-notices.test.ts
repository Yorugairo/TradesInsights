import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NormalizedSourceRecordSchema } from "@otn/domain";
import type { RawArtifact } from "@otn/source-sdk";
import {
  ThurstonActiveNoticesAdapter,
  acresFromText,
  lotsFromText,
  noticeDateFields,
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
      adapter.parse(rawArtifact("<html><body><h1>New permitting portal</h1></body></html>"), ctx),
    ).rejects.toThrow(/page shape changed/);
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

describe("thurston_active_notices WS6 — lots, dates, business-gated org", () => {
  it("lotsFromText extracts deterministic lot counts (null when absent)", () => {
    expect(lotsFromText("an 11-lot residential plat")).toBe(11);
    expect(lotsFromText("proposal to subdivide into 5 lots")).toBe(5);
    expect(lotsFromText("18 single family residential lots")).toBe(18);
    expect(lotsFromText("a new garage, no subdivision")).toBeNull();
    expect(lotsFromText(null)).toBeNull();
  });

  it("acresFromText reads acreage for evidence", () => {
    expect(acresFromText("on 4.5 acres of land")).toBe("4.5");
    expect(acresFromText("a 40 acre parcel")).toBe("40");
    expect(acresFromText("no acreage stated")).toBeNull();
  });

  it("noticeDateFields maps issuance/application dates, leaving hearings null", () => {
    expect(noticeDateFields("Date of Issuance: 3/23/2026", "2026-03-23")).toEqual({
      applicationDate: null,
      issueDate: "2026-03-23",
    });
    expect(noticeDateFields("Notice of Application received", "2026-02-01")).toEqual({
      applicationDate: "2026-02-01",
      issueDate: null,
    });
    // A future hearing date is NOT a lifecycle date.
    expect(noticeDateFields("Public Hearing - July 28, 2026", "2026-07-28")).toEqual({
      applicationDate: null,
      issueDate: null,
    });
  });

  it("a homeowner RUE hearing gets null dates and no org (golden fixture)", async () => {
    const adapter = new ThurstonActiveNoticesAdapter();
    const body = await readFile(join(FIXTURES_DIR, "thurston_active_notices/landing.html"));
    const parsed = await adapter.parse(rawArtifact(body), testContext(adapter.key));
    const moore = parsed.find((p) => p.record.externalId === "2019101651")!;
    expect(moore.record.issueDate).toBeNull(); // future hearing, not issuance
    expect(moore.record.applicationDate).toBeNull();
    expect(moore.record.organizations).toEqual([]); // "Moore Garage RUE" is a homeowner name
  });

  it("promotes lots + application date + a business project org (inline accordion)", async () => {
    const adapter = new ThurstonActiveNoticesAdapter();
    const html = `<html><body>
      <h2>Projects with Active Notices</h2>
      <div class="accordion-group">
        <div class="accordion-item">
          <button class="accordion-title" aria-controls="b1">Project Number: 2026100001 (Cascade Ridge Development LLC) Notice of Application received - February 1, 2026</button>
        </div>
        <div id="b1" class="accordion-text">
          <p>Location: 100 Main St NE, Olympia, WA 98501</p>
          <p>Preliminary plat proposal to subdivide into 11 lots on 4.5 acres of residential land.</p>
        </div>
      </div>
    </body></html>`;
    const parsed = await adapter.parse(rawArtifact(html), testContext(adapter.key));
    const rec = parsed.find((p) => p.record.externalId === "2026100001")!.record;
    expect(rec.lots).toBe(11);
    expect(rec.applicationDate).toBe("2026-02-01");
    expect(rec.issueDate).toBeNull();
    expect(rec.sourceUpdatedAt).toBe("2026-02-01");
    expect(rec.organizations).toEqual([
      {
        name: "Cascade Ridge Development LLC",
        role: null,
        evidenceText: "Project/development entity: Cascade Ridge Development LLC",
      },
    ]);
    expect(rec.evidence.some((e) => e.factPath === "lots")).toBe(true);
    expect(rec.evidence.some((e) => e.text.includes("4.5 acres"))).toBe(true);
    expect(NormalizedSourceRecordSchema.safeParse(rec).success).toBe(true);
  });
});
