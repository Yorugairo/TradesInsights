/**
 * #3 — project geometry: materialization from resolved records (source data)
 * and Census geocoding of address-only projects (a labeled inference with a
 * unique-match + county cross-check guard — never a fabricated location).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { projects, rawArtifacts, sourceRecords, sourceRuns, type Db } from "@otn/db";
import { geocodeProjects, materializeProjectGeometry, type GeocodeFetcher } from "@otn/resolution";
import { deleteTestProjects, resetSource, testDb } from "./helpers.js";

const RUN = randomUUID().slice(0, 8).toUpperCase();

let db: Db;
let pool: pg.Pool;
let sourceId: string;
let artifactId: string;
const createdIds: string[] = [];

async function seedProject(input: {
  name: string;
  address?: string | null;
  city?: string | null;
  county?: string;
  recordGeometry?: { type: "Point"; coordinates: [number, number] } | null;
}): Promise<string> {
  const [project] = await db
    .insert(projects)
    .values({
      canonicalName: input.name,
      permittingJurisdiction: `Geo Test City ${RUN}`,
      county: input.county ?? "Lewis",
      city: input.city ?? null,
      addressNormalized: input.address ?? null,
      currentStage: "permit_issued",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    })
    .returning({ id: projects.id });
  createdIds.push(project!.id);
  if (input.recordGeometry !== undefined) {
    const [record] = await db
      .insert(sourceRecords)
      .values({
        sourceId,
        rawArtifactId: artifactId,
        externalId: input.name,
        recordType: "permit",
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        rawFieldsJson: {},
        normalizedJson: { title: input.name, geometry: input.recordGeometry },
        normalizedFingerprint: `geo-${input.name}`,
      })
      .returning({ id: sourceRecords.id });
    await db.execute(sql`
      INSERT INTO record_resolutions
        (source_record_id, project_id, resolver_version, matched_rule, features_json, score, decision, status)
      VALUES (${record!.id}, ${project!.id}, 'test', 'new_project', '{}', 1, 'auto', 'active')`);
  }
  return project!.id;
}

function censusResponse(matches: unknown[]): { status: number; json(): Promise<unknown> } {
  return { status: 200, json: () => Promise.resolve({ result: { addressMatches: matches } }) };
}

function match(lon: number, lat: number, county: string, matched = "MATCHED ADDR, WA"): unknown {
  return {
    coordinates: { x: lon, y: lat },
    matchedAddress: matched,
    geographies: { Counties: [{ BASENAME: county }] },
  };
}

beforeAll(async () => {
  ({ db, pool } = await testDb());
  sourceId = await resetSource(db, "fake_source");
  const [run] = await db
    .insert(sourceRuns)
    .values({ sourceId, status: "succeeded" })
    .returning({ id: sourceRuns.id });
  const [artifact] = await db
    .insert(rawArtifacts)
    .values({
      sourceId,
      sourceRunId: run!.id,
      canonicalUrl: `https://example.invalid/geocode-test/${RUN}`,
      retrievedAt: new Date(),
      contentType: "application/json",
      httpStatus: 200,
      storageKey: `raw/fake_source/geocode-test-${RUN}`,
      sha256: RUN.padEnd(64, "9").toLowerCase(),
      byteSize: 2,
      headersJson: {},
      parserVersion: "test",
    })
    .returning({ id: rawArtifacts.id });
  artifactId = artifact!.id;
});

afterAll(async () => {
  await deleteTestProjects(db, createdIds);
  await pool.end();
});

describe("#3 materializeProjectGeometry", () => {
  it("fills project geometry from an active resolved record and stamps provenance", async () => {
    const id = await seedProject({
      name: `GEO-MAT-${RUN}`,
      recordGeometry: { type: "Point", coordinates: [-122.9, 46.98] },
    });
    await materializeProjectGeometry(db);
    const row = (
      await db.execute(sql`
        SELECT geometry_source, ST_X(geometry::geometry) AS lon FROM projects WHERE id = ${id}`)
    ).rows[0] as { geometry_source: string; lon: number };
    expect(row.geometry_source).toBe("source_record");
    expect(Number(row.lon)).toBeCloseTo(-122.9, 5);
  });

  it("record geometry replaces a geocoded point (source data beats inference)", async () => {
    const id = await seedProject({
      name: `GEO-UP-${RUN}`,
      recordGeometry: { type: "Point", coordinates: [-122.5, 47.01] },
    });
    await db.execute(sql`
      UPDATE projects SET geometry = ST_SetSRID(ST_MakePoint(-120.0, 45.0), 4326),
        geometry_source = 'census_geocoder', geocode_meta_json = '{"status":"matched"}'::jsonb
      WHERE id = ${id}`);
    await materializeProjectGeometry(db);
    const row = (
      await db.execute(sql`
        SELECT geometry_source, ST_X(geometry::geometry) AS lon FROM projects WHERE id = ${id}`)
    ).rows[0] as { geometry_source: string; lon: number };
    expect(row.geometry_source).toBe("source_record");
    expect(Number(row.lon)).toBeCloseTo(-122.5, 5);
  });
});

describe("#3 geocodeProjects (mock fetcher — the guard, not the service)", () => {
  it("accepts only a unique match whose county equals the project's", async () => {
    const okId = await seedProject({ name: `GEO-OK-${RUN}`, address: "123 MAIN ST" });
    const mismatchId = await seedProject({ name: `GEO-XC-${RUN}`, address: "456 OAK AVE" });
    const ambiguousId = await seedProject({ name: `GEO-AMB-${RUN}`, address: "789 ELM ST" });
    const noneId = await seedProject({ name: `GEO-NONE-${RUN}`, address: "1 NOWHERE LN" });

    const responses = new Map<string, unknown[]>([
      ["123 MAIN ST", [match(-122.91, 46.99, "Lewis")]],
      ["456 OAK AVE", [match(-122.3, 47.6, "King")]], // wrong county returned
      ["789 ELM ST", [match(-122.9, 46.9, "Lewis"), match(-122.8, 46.8, "Lewis")]],
      ["1 NOWHERE LN", []],
    ]);
    const fetcher: GeocodeFetcher = (url) => {
      const addr = decodeURIComponent(new URL(url).searchParams.get("address") ?? "");
      const key = [...responses.keys()].find((k) => addr.startsWith(k))!;
      return Promise.resolve(censusResponse(responses.get(key) ?? []));
    };

    const ids = [okId, mismatchId, ambiguousId, noneId];
    const summary = await geocodeProjects(db, { projectIds: ids, fetcher, delayMs: 0 });
    expect(summary).toMatchObject({
      attempted: 4, matched: 1, countyMismatch: 1, ambiguous: 1, noMatch: 1, errors: 0,
    });

    const rows = (
      await db.execute(sql`
        SELECT id, geometry_source, geocode_meta_json->>'status' AS status,
          geometry IS NOT NULL AS has_geom
        FROM projects WHERE id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`)
    ).rows as { id: string; geometry_source: string | null; status: string; has_geom: boolean }[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(okId)).toMatchObject({
      geometry_source: "census_geocoder", status: "matched", has_geom: true,
    });
    // The guard: wrong county / ambiguity / no match NEVER produce a location.
    expect(byId.get(mismatchId)).toMatchObject({ status: "county_mismatch", has_geom: false });
    expect(byId.get(ambiguousId)).toMatchObject({ status: "ambiguous", has_geom: false });
    expect(byId.get(noneId)).toMatchObject({ status: "no_match", has_geom: false });

    // Attempts are recorded: a rerun skips all four (no re-hitting the service).
    const again = await geocodeProjects(db, { projectIds: ids, fetcher, delayMs: 0 });
    expect(again.attempted).toBe(0);
  });

  it("transient service errors are not persisted — the next run retries", async () => {
    const id = await seedProject({ name: `GEO-ERR-${RUN}`, address: "500 RETRY RD" });
    const failing: GeocodeFetcher = () =>
      Promise.resolve({ status: 503, json: () => Promise.resolve({}) });
    const first = await geocodeProjects(db, { projectIds: [id], fetcher: failing, delayMs: 0 });
    expect(first).toMatchObject({ attempted: 1, errors: 1, matched: 0 });

    const working: GeocodeFetcher = () =>
      Promise.resolve(censusResponse([match(-122.92, 46.97, "Lewis")]));
    const second = await geocodeProjects(db, { projectIds: [id], fetcher: working, delayMs: 0 });
    expect(second).toMatchObject({ attempted: 1, matched: 1 });
  });

  it("never touches a project that already has geometry", async () => {
    const id = await seedProject({
      name: `GEO-HAS-${RUN}`,
      address: "9 ALREADY PL",
      recordGeometry: { type: "Point", coordinates: [-122.7, 46.95] },
    });
    await materializeProjectGeometry(db);
    const explode: GeocodeFetcher = () => {
      throw new Error("must not be called");
    };
    const summary = await geocodeProjects(db, { projectIds: [id], fetcher: explode, delayMs: 0 });
    expect(summary.attempted).toBe(0);
  });
});
