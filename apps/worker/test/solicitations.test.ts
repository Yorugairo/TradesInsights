/**
 * The SECOND record class, end to end through the SAME runner.
 *
 * Two things are being proven here and they are separable:
 *
 *  1. A solicitation round-trips: it persists to `insights.solicitations` with a
 *     TYPED `bid_due_at`, re-running does not duplicate it, and an amendment
 *     updates the existing row rather than creating a second one.
 *
 *  2. `parsed_count`, `duplicate_count` and `rejected_count` move for
 *     solicitations exactly as they do for permits. This is the fleet audit's
 *     open question made executable: `rejected_count` read 0 across all 36
 *     sources and ~27,000 records, which is either "validation never rejects
 *     anything" or "the counter is dead". A counter that structurally cannot
 *     increment is a blind spot, not a clean bill of health — so the invalid
 *     record below exists to force it off zero.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type pg from "pg";
import { solicitations, type Db } from "@otn/db";
import {
  MemoryObjectStore,
  createLogger,
  runSource,
  type DiscoveredArtifact,
  type ParsedRecord,
  type RawArtifact,
  type SourceAdapter,
} from "@otn/source-sdk";
import { FIXTURES_DIR } from "../src/jobs.js";
import { resetSource, testDb } from "./helpers.js";

const logger = createLogger({ app: "solicitations-test" });
const SOURCE_KEY = "fake_source";

interface Emission {
  /** Varied per run so the artifact hash changes and the runner re-parses. */
  bodyMarker: string;
  bidDueAt: string | null;
  /** Emit a deliberately invalid record alongside the good one. */
  withInvalid?: boolean;
}

class SolicitationProbeAdapter implements SourceAdapter {
  readonly key = SOURCE_KEY;
  readonly parserVersion = "1.0.0";

  constructor(private readonly emission: Emission) {}

  async discover(): Promise<DiscoveredArtifact[]> {
    return [
      {
        idempotencyKey: `${this.key}:solicitation-probe`,
        canonicalUrl: "https://example.test/bids/probe",
        parentUrl: null,
        expectedContentType: "text/html",
        sourcePublishedAt: null,
      },
    ];
  }

  async fetch(item: DiscoveredArtifact): Promise<RawArtifact> {
    return {
      discovered: item,
      body: Buffer.from(`<html><!-- ${this.emission.bodyMarker} --></html>`),
      contentType: "text/html",
      httpStatus: 200,
      headers: {},
      retrievedAt: new Date("2026-07-27T12:00:00Z"),
    };
  }

  async parse(): Promise<ParsedRecord[]> {
    const out: ParsedRecord[] = [
      {
        kind: "solicitation",
        rawFields: { number: "PROBE-001", due: this.emission.bidDueAt },
        record: {
          sourceKey: this.key,
          externalId: "PROBE-001",
          solicitationNumber: "PROBE-001",
          title: "Probe solicitation",
          description: null,
          procuringAgency: "Test Procuring Agency",
          primeContractor: null,
          documentType: "solicitation",
          bidDueAt: this.emission.bidDueAt,
          issuedAt: null,
          status: "open",
          // Statewide: no county. The permit record could not express this.
          county: null,
          city: null,
          scopeRaw: null,
          tradeTags: [],
          organizations: [],
          sourceUrl: "https://example.test/bids/probe",
          evidence: [],
        },
      },
    ];
    if (this.emission.withInvalid) {
      out.push({
        kind: "solicitation",
        rawFields: { number: "PROBE-BAD" },
        record: {
          // `title` is empty and `status` is not in the enum — two independent
          // reasons the schema must refuse this.
          sourceKey: this.key,
          externalId: "PROBE-BAD",
          solicitationNumber: null,
          title: "",
          description: null,
          procuringAgency: "Test Procuring Agency",
          primeContractor: null,
          documentType: "solicitation",
          bidDueAt: null,
          status: "bidding_confirmed",
          issuedAt: null,
          county: null,
          city: null,
          scopeRaw: null,
          tradeTags: [],
          organizations: [],
          sourceUrl: "https://example.test/bids/probe",
          evidence: [],
        } as unknown as ParsedRecord["record"],
      } as ParsedRecord);
    }
    return out;
  }
}

let db: Db;
let pool: pg.Pool;
let sourceId: string;

async function run(emission: Emission) {
  return runSource({
    db,
    adapter: new SolicitationProbeAdapter(emission),
    objectStore: new MemoryObjectStore(),
    logger,
    fixturesDir: FIXTURES_DIR,
    userAgent: "OTNInsightsBot/0.1 (test)",
  });
}

async function rows() {
  return db
    .select()
    .from(solicitations)
    .where(and(eq(solicitations.sourceId, sourceId), eq(solicitations.externalId, "PROBE-001")));
}

beforeAll(async () => {
  ({ db, pool } = await testDb());
  sourceId = await resetSource(db, SOURCE_KEY);
});

afterAll(async () => {
  await db.delete(solicitations).where(eq(solicitations.sourceId, sourceId));
  await pool.end();
});

describe("solicitations — the second record class through the shared runner", () => {
  it("persists a bid with a typed deadline and a null county", async () => {
    const result = await run({ bodyMarker: "run-1", bidDueAt: "2026-08-14T14:00:00-07:00" });
    expect(result.status).toBe("succeeded");
    expect(result.metrics.parsed).toBe(1);

    const [row] = await rows();
    expect(row).toBeDefined();
    expect(row!.county).toBeNull();
    expect(row!.documentType).toBe("solicitation");
    // The whole point of the record class: a real timestamp, not a string in
    // rawFields. 14:00 Pacific = 21:00 UTC.
    expect(row!.bidDueAt).toBeInstanceOf(Date);
    expect(row!.bidDueAt!.toISOString()).toBe("2026-08-14T21:00:00.000Z");
  });

  it("re-running the same bid counts a duplicate, not a second row", async () => {
    // Different bytes so the unchanged-artifact short circuit does not fire and
    // the record genuinely reaches the persist branch.
    const result = await run({ bodyMarker: "run-2", bidDueAt: "2026-08-14T14:00:00-07:00" });
    expect(result.metrics.duplicate).toBe(1);
    expect(result.metrics.parsed).toBe(0);
    expect(await rows()).toHaveLength(1);
  });

  it("an amended deadline updates the existing row in place", async () => {
    // A bid whose due date moves is the SAME solicitation, which is why
    // `observed_at` is deliberately NOT in the dedupe key (see migration 0036 —
    // this inverts the project_events lesson on purpose).
    const result = await run({ bodyMarker: "run-3", bidDueAt: "2026-08-21T14:00:00-07:00" });
    expect(result.metrics.parsed).toBe(1);

    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]!.bidDueAt!.toISOString()).toBe("2026-08-21T21:00:00.000Z");
  });

  it("rejected_count increments on an invalid solicitation", async () => {
    const result = await run({
      bodyMarker: "run-4",
      bidDueAt: "2026-08-21T14:00:00-07:00",
      withInvalid: true,
    });
    // The good record is unchanged (duplicate); the bad one is rejected. The
    // counter moving off zero is the assertion that matters.
    expect(result.metrics.rejected).toBe(1);
    expect(result.metrics.duplicate).toBe(1);
    // A rejected record must not be written.
    const bad = await db
      .select()
      .from(solicitations)
      .where(and(eq(solicitations.sourceId, sourceId), eq(solicitations.externalId, "PROBE-BAD")));
    expect(bad).toHaveLength(0);
  });
});

/**
 * The PERMIT side of the same question. The fleet audit measured
 * `rejected_count = 0` across all 36 sources and ~27,000 records, and every one
 * of those records went through `NormalizedSourceRecordSchema`, not the
 * solicitation schema. Proving the solicitation counter works does not answer
 * whether the permit one can — so it is asserted directly here.
 *
 * The honest reading of the production zero: the counter is LIVE, and 0 means
 * the adapters genuinely emit schema-valid records (they construct
 * `NormalizedSourceRecord` under `tsc`, so most malformed output is a compile
 * error long before it is a runtime rejection). Not a dead counter.
 */
class InvalidPermitAdapter implements SourceAdapter {
  readonly key = SOURCE_KEY;
  readonly parserVersion = "1.0.0";

  async discover(): Promise<DiscoveredArtifact[]> {
    return [
      {
        idempotencyKey: `${this.key}:invalid-permit`,
        canonicalUrl: "https://example.test/permits/probe",
        parentUrl: null,
        expectedContentType: "text/html",
        sourcePublishedAt: null,
      },
    ];
  }

  async fetch(item: DiscoveredArtifact): Promise<RawArtifact> {
    return {
      discovered: item,
      body: Buffer.from("<html><!-- invalid-permit --></html>"),
      contentType: "text/html",
      httpStatus: 200,
      headers: {},
      retrievedAt: new Date("2026-07-27T12:00:00Z"),
    };
  }

  async parse(): Promise<ParsedRecord[]> {
    return [
      {
        rawFields: { permit: "BAD-1" },
        // `county` is not in CountySchema and `normalizedStage` is not a stage.
        record: {
          sourceKey: this.key,
          externalId: "BAD-1",
          recordType: "permit",
          title: "Invalid permit probe",
          description: null,
          permittingJurisdiction: "Nowhere",
          county: "Atlantis",
          city: null,
          addressRaw: null,
          parcelIds: [],
          geometry: null,
          applicationType: null,
          permitType: null,
          documentType: null,
          statusRaw: null,
          normalizedStage: "not_a_stage",
          applicationDate: null,
          issueDate: null,
          sourceUpdatedAt: null,
          valuationUsd: null,
          units: null,
          lots: null,
          squareFeet: null,
          organizations: [],
          sourceUrl: "https://example.test/permits/probe",
          evidence: [],
        },
      } as unknown as ParsedRecord,
    ];
  }
}

describe("rejected_count on the permit path", () => {
  it("increments when a record fails NormalizedSourceRecordSchema", async () => {
    const result = await runSource({
      db,
      adapter: new InvalidPermitAdapter(),
      objectStore: new MemoryObjectStore(),
      logger,
      fixturesDir: FIXTURES_DIR,
      userAgent: "OTNInsightsBot/0.1 (test)",
    });
    expect(result.metrics.rejected).toBe(1);
    expect(result.metrics.parsed).toBe(0);
  });
});
