import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NormalizedSourceRecordSchema } from "@otn/domain";
import type { RawArtifact } from "@otn/source-sdk";
import {
  LaceyProjectPagesAdapter,
  projectNumberFromTitle,
  parcelsFromText,
  proponentFromDescription,
} from "./lacey-project-pages.js";
import { LaceyProjectsRestAdapter } from "./lacey-projects-rest.js";
import { FIXTURES_DIR, testContext } from "./test-utils.js";

async function fixture(rel: string): Promise<Buffer> {
  return readFile(join(FIXTURES_DIR, rel));
}

function rawArtifact(
  body: Buffer,
  url: string,
  meta?: Record<string, unknown>,
): RawArtifact {
  return {
    discovered: {
      idempotencyKey: `test:${url}`,
      canonicalUrl: url,
      parentUrl: null,
      expectedContentType: null,
      sourcePublishedAt: null,
      ...(meta ? { meta } : {}),
    },
    body,
    contentType: "application/octet-stream",
    httpStatus: 200,
    headers: {},
    retrievedAt: new Date("2026-07-15T00:00:00Z"),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("lacey_projects_rest parse (golden fixture)", () => {
  it("emits one valid record per WP project with decoded titles", async () => {
    const adapter = new LaceyProjectsRestAdapter();
    const ctx = testContext(adapter.key);
    const body = await fixture("lacey_projects_rest/projects-page1.json");
    const parsed = await adapter.parse(rawArtifact(body, "https://cityoflacey.org/wp-json/x"), ctx);

    expect(parsed.length).toBe(79);
    for (const p of parsed) {
      const v = NormalizedSourceRecordSchema.safeParse(p.record);
      expect(v.success, JSON.stringify(v.success ? null : v.error.issues)).toBe(true);
    }

    const first = parsed[0]!.record;
    expect(first.externalId).toBe("41713");
    expect(first.title).toBe("#26-0165 – Tec Equipment Phase II, Temp-Use Permit");
    expect(first.county).toBe("Thurston");
    expect(first.permittingJurisdiction).toBe("City of Lacey");
    expect(first.sourceUpdatedAt).toBe("2026-07-14T14:46:21");
    expect(first.sourceUrl).toContain("cityoflacey.org/projects/");
    expect(first.normalizedStage).toBe("unknown");
    // Checkpoint advanced to the max modified in the fixture.
    expect(ctx.savedCheckpoint).toEqual({ modifiedHighWater: "2026-07-14T14:46:21" });
  });

  it("emits a runner-rejectable record for a malformed item, keeps the rest", async () => {
    const adapter = new LaceyProjectsRestAdapter();
    const ctx = testContext(adapter.key);
    const body = Buffer.from(
      JSON.stringify([
        { id: 1, date: "2026-01-01T00:00:00", modified: "2026-01-02T00:00:00", link: "https://cityoflacey.org/projects/x/", title: { rendered: "#26-0001 Test" } },
        { id: 2, title: "not-an-object" },
      ]),
    );
    const parsed = await adapter.parse(rawArtifact(body, "https://cityoflacey.org/wp-json/x"), ctx);
    expect(parsed.length).toBe(2);
    expect(NormalizedSourceRecordSchema.safeParse(parsed[0]!.record).success).toBe(true);
    expect(NormalizedSourceRecordSchema.safeParse(parsed[1]!.record).success).toBe(false);
  });

  it("filters to the backfill window on the source modified time", async () => {
    const adapter = new LaceyProjectsRestAdapter();
    const ctx = testContext(adapter.key, {
      backfill: { from: "2026-07-01", to: "2026-07-31" },
    });
    const body = await fixture("lacey_projects_rest/projects-page1.json");
    const parsed = await adapter.parse(rawArtifact(body, "https://cityoflacey.org/wp-json/x"), ctx);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.length).toBeLessThan(79);
    for (const p of parsed) {
      const m = (p.rawFields as { modified: string }).modified.slice(0, 10);
      expect(m >= "2026-07-01" && m <= "2026-07-31").toBe(true);
    }
  });

  it("discovers one artifact per WP page from X-WP-TotalPages", async () => {
    const adapter = new LaceyProjectsRestAdapter();
    const ctx = testContext(adapter.key);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("[]", {
          status: 200,
          headers: { "content-type": "application/json", "x-wp-totalpages": "3" },
        }),
      ),
    );
    const items = await adapter.discover(ctx);
    expect(items.map((i) => i.idempotencyKey)).toEqual([
      "lacey_projects_rest:page-1",
      "lacey_projects_rest:page-2",
      "lacey_projects_rest:page-3",
    ]);
    expect(items[1]!.canonicalUrl).toContain("&page=2");
  });
});

describe("lacey_project_pages parse (golden fixture)", () => {
  const meta = {
    postId: 36731,
    modified: "2026-07-08T13:46:31",
    published: "2025-09-12T09:15:23",
  };

  it("extracts title, description, address, geometry, parcel, proponent, documents", async () => {
    const adapter = new LaceyProjectPagesAdapter();
    const ctx = testContext(adapter.key);
    const body = await fixture("lacey_project_pages/project-25-0261-41st-ave.html");
    const url = "https://cityoflacey.org/projects/25-0261-41st-ave/";
    const [p] = await adapter.parse(rawArtifact(body, url, meta), ctx);

    const v = NormalizedSourceRecordSchema.safeParse(p!.record);
    expect(v.success, JSON.stringify(v.success ? null : v.error.issues)).toBe(true);
    const r = p!.record;
    expect(r.externalId).toBe("25-0261");
    expect(r.title).toBe("#25-0261 – 41st Ave");
    expect(r.description).toContain("213,000 square-foot, mixed-use development");
    expect(r.addressRaw).toBe("41st Ave NE Lacey");
    expect(r.geometry).toEqual({ type: "Point", coordinates: [-122.7700628, 47.0903725] });
    expect(r.parcelIds).toEqual(["11935210200"]);
    expect(r.organizations).toEqual([
      {
        name: "Resource Management Solutions, LLC",
        role: "proponent",
        evidenceText: expect.stringContaining("is proposing"),
      },
    ]);
    expect(r.sourceUpdatedAt).toBe("2026-07-08T13:46:31");
    expect(r.county).toBe("Thurston");
    expect(r.normalizedStage).toBe("unknown");

    const docs = (p!.rawFields as { documents: { url: string; text: string }[] }).documents;
    expect(docs.length).toBeGreaterThan(20);
    expect(docs[0]).toEqual({
      url: "https://cityoflacey.org/wp-content/uploads/sites/3/2026/07/SPR-Decision-7.8.26-Exhibits-1-3.pdf",
      text: "SPR Decision 7.8.26 Exhibits 1-3",
    });
  });

  it("parses a page without parcel/proponent mentions without fabricating them", async () => {
    const adapter = new LaceyProjectPagesAdapter();
    const ctx = testContext(adapter.key);
    const body = await fixture("lacey_project_pages/project-26-0165-tec-equipment.html");
    const url = "https://cityoflacey.org/projects/26-0165-tec-equipment-phase-ii-temp-use-permit/";
    const [p] = await adapter.parse(
      rawArtifact(body, url, { postId: 41713, modified: "2026-07-14T14:46:21", published: "2026-07-14T14:46:19" }),
      ctx,
    );
    const r = p!.record;
    expect(NormalizedSourceRecordSchema.safeParse(r).success).toBe(true);
    expect(r.externalId).toBe("26-0165");
    expect(r.parcelIds).toEqual([]);
    expect(r.organizations).toEqual([]);
    expect(r.statusRaw).toBeNull();
    expect(r.valuationUsd).toBeNull();
  });

  it("throws loudly when the page shape changed (no project title)", async () => {
    const adapter = new LaceyProjectPagesAdapter();
    const ctx = testContext(adapter.key);
    const body = await fixture("lacey_project_pages/malformed-no-title.html");
    await expect(
      adapter.parse(rawArtifact(body, "https://cityoflacey.org/projects/broken/", meta), ctx),
    ).rejects.toThrow(/no h2.text-center/);
  });

  it("discover skips items older than the checkpoint floor and sets a new checkpoint", async () => {
    const adapter = new LaceyProjectPagesAdapter();
    const ctx = testContext(adapter.key, {
      checkpoint: { modifiedHighWater: "2026-07-08T13:46:31" },
    });
    const list = await fixture("lacey_projects_rest/projects-page1.json");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(list, { status: 200, headers: { "content-type": "application/json" } }),
      ),
    );
    const items = await adapter.discover(ctx);
    // Only pages modified on/after 2026-07-07 (floor minus 1-day overlap) are fetched.
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThan(79);
    for (const i of items) {
      const m = (i.meta as { modified: string }).modified.slice(0, 10);
      expect(m >= "2026-07-07").toBe(true);
    }
    expect(ctx.savedCheckpoint).toEqual({ modifiedHighWater: "2026-07-14T14:46:21" });
  });

  it("discover honors an explicit backfill window instead of the checkpoint", async () => {
    const adapter = new LaceyProjectPagesAdapter();
    const ctx = testContext(adapter.key, {
      checkpoint: { modifiedHighWater: "2026-07-14T14:46:21" },
      backfill: { from: "2026-04-01", to: "2026-06-30" },
    });
    const list = await fixture("lacey_projects_rest/projects-page1.json");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(list, { status: 200, headers: { "content-type": "application/json" } }),
      ),
    );
    const items = await adapter.discover(ctx);
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) {
      const m = (i.meta as { modified: string }).modified.slice(0, 10);
      expect(m >= "2026-04-01" && m <= "2026-06-30").toBe(true);
    }
  });
});

describe("lacey extraction helpers", () => {
  it("projectNumberFromTitle", () => {
    expect(projectNumberFromTitle("#25-0261 – 41st Ave")).toBe("25-0261");
    expect(projectNumberFromTitle("# 26-0165 Temp Use")).toBe("26-0165");
    expect(projectNumberFromTitle("No number here")).toBeNull();
  });

  it("parcelsFromText finds only explicitly-stated parcels", () => {
    expect(parcelsFromText("Assessor’s parcel 11935210200, Section 35")).toEqual([
      "11935210200",
    ]);
    expect(parcelsFromText("parcels 11835220100 and 11835220101 combined")).toEqual([
      "11835220100",
      "11835220101",
    ]);
    expect(parcelsFromText("about 12345678 square feet")).toEqual([]);
  });

  it("proponentFromDescription is bounded to explicit proposing language", () => {
    expect(
      proponentFromDescription("Acme Development, LLC is proposing to build 40 units."),
    ).toEqual({
      name: "Acme Development, LLC",
      evidenceText: "Acme Development, LLC is proposing",
    });
    expect(proponentFromDescription("The site was rezoned last year.")).toBeNull();
    // No legal-entity suffix -> no match; never guess.
    expect(proponentFromDescription("John Smith is proposing a garage.")).toBeNull();
  });
});
