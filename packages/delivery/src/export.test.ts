import { describe, expect, it, vi } from "vitest";
import {
  csvField,
  postWebhook,
  pursuitsToCsv,
  pursuitsToPayload,
  type ExportRow,
  type WebhookPayload,
} from "./export.js";

/**
 * WS-D — pure serialization + webhook-transport tests (no DB). The account-
 * isolation + full-query path is covered DB-backed in apps/worker/test/export.test.ts.
 */

function row(over: Partial<ExportRow> = {}): ExportRow {
  return {
    opportunityId: "opp-1",
    dealname: "Riverside TI",
    amount: 250_000,
    project: "Riverside TI",
    county: "Thurston",
    stage: "permit_issued",
    pursuitState: "qualified",
    score: 84,
    units: null,
    gcName: "Acme Builders",
    gcPhone: "+1 360 555 0100",
    gcVerified: true,
    bidWindow: "open",
    bidWindowNote: "Typical bid window is open.",
    sourceUrl: "https://permits.example.gov/1",
    sourceUrls: ["https://permits.example.gov/1"],
    ...over,
  };
}

describe("csvField (RFC-4180 escaping)", () => {
  it("leaves plain values unquoted and renders null/undefined as empty", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField(84)).toBe("84");
    expect(csvField(true)).toBe("true");
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
  });

  it("quotes and doubles embedded quotes / commas / newlines (blocks CSV injection)", () => {
    expect(csvField("Smith, Jones & Co")).toBe('"Smith, Jones & Co"');
    expect(csvField('He said "hi"')).toBe('"He said ""hi"""');
    expect(csvField("line1\nline2")).toBe('"line1\nline2"');
  });
});

describe("pursuitsToCsv", () => {
  it("emits a header plus one row per opportunity, escaping delimiter-bearing fields", () => {
    const csv = pursuitsToCsv([
      row(),
      row({ opportunityId: "opp-2", gcName: "Wall, Board & Sons", dealname: 'The "Big" Job' }),
    ]);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toContain("opportunity_id,dealname,amount");
    expect(lines).toHaveLength(3); // header + 2 rows
    // The comma/quote-bearing fields are quoted, not spilled into new columns.
    expect(lines[2]).toContain('"Wall, Board & Sons"');
    expect(lines[2]).toContain('"The ""Big"" Job"');
    // Header column count === data column count (no injected columns).
    expect(lines[2]!.match(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/g)!.length).toBe(
      lines[0]!.split(",").length - 1,
    );
  });

  it("produces only a header row for an empty export", () => {
    const csv = pursuitsToCsv([]);
    expect(csv.trimEnd().split("\r\n")).toHaveLength(1);
  });
});

describe("pursuitsToPayload", () => {
  it("wraps rows in the documented HubSpot/Zapier envelope", () => {
    const payload = pursuitsToPayload([row(), row({ opportunityId: "opp-2" })]);
    expect(payload.source).toBe("otn-insights");
    expect(payload.count).toBe(2);
    expect(payload.opportunities).toHaveLength(2);
    expect(payload.opportunities[0]).toMatchObject({
      dealname: "Riverside TI",
      amount: 250_000,
      gcVerified: true,
      bidWindow: "open",
    });
    expect(typeof payload.generatedAt).toBe("string");
  });
});

describe("postWebhook (governance: destination + never-throw)", () => {
  const payload: WebhookPayload = pursuitsToPayload([row()]);

  it("POSTs ONLY to the supplied url, with the JSON payload as the body", async () => {
    const calls: { url: unknown; init: RequestInit | undefined }[] = [];
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const res = await postWebhook("https://hooks.example.com/abc", payload, { fetchImpl });

    expect(res.status).toBe("sent");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://hooks.example.com/abc"); // the configured url ONLY
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toMatchObject({ count: 1, source: "otn-insights" });
  });

  it("returns failed (not thrown) on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const res = await postWebhook("https://hooks.example.com/abc", payload, { fetchImpl });
    expect(res.status).toBe("failed");
    expect(res.reason).toContain("500");
  });

  it("returns failed (not thrown) when fetch itself rejects", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const res = await postWebhook("https://hooks.example.com/abc", payload, { fetchImpl });
    expect(res.status).toBe("failed");
    expect(res.reason).toContain("ECONNREFUSED");
  });
});
