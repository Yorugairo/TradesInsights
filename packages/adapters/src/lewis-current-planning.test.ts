import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NormalizedSourceRecordSchema } from "@otn/domain";
import type { DiscoveredArtifact, RawArtifact } from "@otn/source-sdk";
import { LewisCurrentPlanningAdapter, parseLandingRows } from "./lewis-current-planning.js";
import { FIXTURES_DIR, testContext } from "./test-utils.js";

const LANDING = "lewis_current_planning/landing.html";
const DETAIL = "lewis_current_planning/detail-sup25-0002-roamers.html";
const LEWIS_PLANNING_URL =
  "https://lewiscountywa.gov/departments/community-development/current-planning-applications/";

function artifact(body: Buffer, meta: Record<string, unknown>): RawArtifact {
  const discovered: DiscoveredArtifact = {
    idempotencyKey: "test:lewis-planning",
    canonicalUrl: "https://lewiscountywa.gov/documents/planning/sup25-0002/",
    parentUrl: LEWIS_PLANNING_URL,
    expectedContentType: "text/html",
    sourcePublishedAt: null,
    meta,
  };
  return {
    discovered,
    body,
    contentType: "text/html",
    httpStatus: 200,
    headers: {},
    retrievedAt: new Date("2026-07-15T00:00:00Z"),
  };
}

describe("lewis_current_planning (golden fixtures)", () => {
  it("parses a detail application page into a valid planning_application record", async () => {
    const adapter = new LewisCurrentPlanningAdapter();
    const landing = await readFile(join(FIXTURES_DIR, LANDING));
    const row = parseLandingRows(landing, LEWIS_PLANNING_URL).find((r) =>
      r.fileNumbers.some((f) => /SUP25-0002/i.test(f)),
    )!;
    expect(row, "SUP25-0002 landing row present").toBeDefined();

    const raw = artifact(await readFile(join(FIXTURES_DIR, DETAIL)), {
      kind: "application",
      fileNumbers: row.fileNumbers,
      projectName: row.projectName,
      applicationType: row.applicationType,
    });
    const parsed = await adapter.parse(raw, testContext(adapter.key));
    expect(parsed.length).toBe(1);
    expect(NormalizedSourceRecordSchema.safeParse(parsed[0]!.record).success).toBe(true);
    expect(parsed[0]!.record.county).toBe("Lewis");
    expect(parsed[0]!.record.recordType).toBe("planning_application");
    // WS5 canary: a clean descriptive project name → no column-shift violation.
    expect(adapter.checkInvariants(raw, parsed)).toEqual([]);
  });

  it("returns no records for the landing page (stored for provenance only)", async () => {
    const adapter = new LewisCurrentPlanningAdapter();
    const raw = artifact(await readFile(join(FIXTURES_DIR, LANDING)), { kind: "landing" });
    expect(await adapter.parse(raw, testContext(adapter.key))).toEqual([]);
  });

  it("column-shift canary flags a file/parcel id in the project-name column", () => {
    const adapter = new LewisCurrentPlanningAdapter();
    const drift = [
      { rawFields: { projectName: "SUP25-0001" }, record: { externalId: "SUP25-0001" } },
    ] as unknown as Parameters<typeof adapter.checkInvariants>[1];
    const v = adapter.checkInvariants(
      null as unknown as Parameters<typeof adapter.checkInvariants>[0],
      drift,
    );
    expect(v.some((x) => x.check === "lewis_planning_column_shift")).toBe(true);
  });
});
