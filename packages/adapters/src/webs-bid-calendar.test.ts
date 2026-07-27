import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NormalizedSolicitationRecordSchema } from "@otn/domain";
import { isSolicitation, type RawArtifact } from "@otn/source-sdk";
import {
  WebsBidCalendarAdapter,
  pagerTargets,
  parseCalendarPage,
  usShortDate,
} from "./webs-bid-calendar.js";
import { FIXTURES_DIR, testContext } from "./test-utils.js";

const DIR = join(FIXTURES_DIR, "webs_bid_calendar");

function pageArtifact(body: Buffer, page: number): RawArtifact {
  return {
    discovered: {
      idempotencyKey: `test:webs:page-${page}`,
      canonicalUrl: `https://pr-webs-vendor.des.wa.gov/BidCalendar.aspx#page=${page}`,
      parentUrl: null,
      expectedContentType: "text/html",
      sourcePublishedAt: null,
      meta: { page },
    },
    body,
    contentType: "text/html",
    httpStatus: 200,
    headers: {},
    retrievedAt: new Date("2026-07-27T00:00:00Z"),
  };
}

describe("webs_bid_calendar — grid parsing (live page of 2026-07-27)", () => {
  it("parses 25 solicitations with reference numbers and close dates", async () => {
    const rows = parseCalendarPage(await readFile(join(DIR, "bid-calendar.html")));
    expect(rows).toHaveLength(25);
    for (const r of rows) {
      expect(r.detailId).toMatch(/^\d+$/);
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.closeDate).toMatch(/^\d{2}\/\d{2}\/\d{2}$/);
    }
    expect(rows.filter((r) => r.referenceNumber).length).toBeGreaterThan(0);
  });

  it("addresses cells by control-id suffix, not position", async () => {
    // Optional fields (pre-bid conference, Q&A deadline) are omitted on some
    // rows, which shifts every later cell. Positional indexing mis-assigns
    // exactly the rows that differ, so this asserts a named field lands.
    const rows = parseCalendarPage(await readFile(join(DIR, "bid-calendar.html")));
    const withConference = rows.filter((r) => r.preBidConference);
    const withoutConference = rows.filter((r) => !r.preBidConference);
    expect(withConference.length).toBeGreaterThan(0);
    expect(withoutConference.length).toBeGreaterThan(0);
    for (const r of withConference) expect(r.preBidConference).toMatch(/\d{2}\/\d{2}\/\d{2}/);
  });

  it("finds the numeric pager and excludes the per-row Additional Data links", async () => {
    const targets = pagerTargets(await readFile(join(DIR, "bid-calendar.html")));
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((t) => !t.includes("AdditionalDataLinkButton"))).toBe(true);
  });

  it("an error page yields zero rows — which the caller must treat as failure", () => {
    expect(parseCalendarPage("<html><body>Session expired</body></html>")).toEqual([]);
  });
});

describe("webs_bid_calendar — record mapping", () => {
  it("emits statewide solicitations with a typed deadline and no county", async () => {
    const adapter = new WebsBidCalendarAdapter();
    const raw = pageArtifact(await readFile(join(DIR, "bid-calendar.html")), 1);
    const parsed = await adapter.parse(raw, testContext(adapter.key));
    expect(parsed).toHaveLength(25);

    for (const p of parsed) {
      const v = NormalizedSolicitationRecordSchema.safeParse(p.record);
      expect(v.success, JSON.stringify(v.success ? null : v.error.issues)).toBe(true);
      const rec = v.data!;
      expect(p.kind).toBe("solicitation");
      // The whole reason bids are not permits: no county, no city, no parcel.
      expect(rec.county).toBeNull();
      expect(rec.city).toBeNull();
      // Not published on the public calendar — recorded as unknown, never
      // filled with a placeholder that would read as a real agency.
      expect(rec.procuringAgency).toBeNull();
      expect(rec.documentType).toBe("solicitation");
    }

    const dated = parsed.filter(isSolicitation).filter((p) => p.record.bidDueAt !== null);
    expect(dated).toHaveLength(25);
  });

  it("marks a solicitation with an amendment date as amended", async () => {
    const adapter = new WebsBidCalendarAdapter();
    const raw = pageArtifact(await readFile(join(DIR, "bid-calendar.html")), 1);
    const parsed = await adapter.parse(raw, testContext(adapter.key));
    const amended = parsed.filter(isSolicitation).filter((p) => p.record.status === "amended");
    expect(amended.length).toBeGreaterThan(0);
    for (const p of amended) {
      expect((p.rawFields as { amendmentDate?: string }).amendmentDate).toMatch(/\d{2}\/\d{2}\/\d{2}/);
    }
  });
});

describe("webs_bid_calendar — drift invariants", () => {
  it("a clean page trips nothing", async () => {
    const adapter = new WebsBidCalendarAdapter();
    const raw = pageArtifact(await readFile(join(DIR, "bid-calendar.html")), 1);
    const parsed = await adapter.parse(raw, testContext(adapter.key));
    expect(adapter.checkInvariants(raw, parsed)).toEqual([]);
  });

  it("an empty grid trips the invariant instead of reading as a quiet day", async () => {
    // THE failure this source is most likely to have: an expired ViewState
    // renders a well-formed page with no rows and HTTP 200.
    const adapter = new WebsBidCalendarAdapter();
    const raw = pageArtifact(Buffer.from("<html><body>Your session has expired</body></html>"), 1);
    const parsed = await adapter.parse(raw, testContext(adapter.key));
    expect(parsed).toHaveLength(0);
    const v = adapter.checkInvariants(raw, parsed);
    expect(v.some((x) => x.check === "webs_empty_grid")).toBe(true);
  });

  it("flags a close-date column that stopped holding a date", () => {
    const adapter = new WebsBidCalendarAdapter();
    const drift = [
      {
        kind: "solicitation" as const,
        rawFields: { detailId: "57169", closeDate: "Open Until Filled" },
        record: {},
      },
    ] as unknown as Parameters<typeof adapter.checkInvariants>[1];
    const v = adapter.checkInvariants(
      pageArtifact(Buffer.from(""), 1),
      drift,
    );
    expect(v.some((x) => x.check === "webs_close_date_column_shift")).toBe(true);
  });
});

describe("webs usShortDate", () => {
  it("expands a two-digit year and keeps the time when present", () => {
    expect(usShortDate("07/28/26")).toBe("2026-07-28T07:00:00.000Z"); // midnight Pacific
    expect(usShortDate("06/29/26 02:00")).toBe("2026-06-29T09:00:00.000Z");
  });

  it("returns null rather than a guess for anything else", () => {
    expect(usShortDate("Open Until Filled")).toBeNull();
    expect(usShortDate(null)).toBeNull();
    expect(usShortDate("")).toBeNull();
  });
});
