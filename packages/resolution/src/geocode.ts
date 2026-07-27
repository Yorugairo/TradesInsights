import { sql } from "drizzle-orm";
import { EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import { withConnectionRetry, type Db } from "@otn/db";

/**
 * #3 — project geometry, two deterministic passes:
 *
 * 1. materializeProjectGeometry: fill projects.geometry from an active
 *    resolved record's OWN geometry (the resolver's fillGeometry does this
 *    for records arriving now; this heals projects resolved before it
 *    existed). Provenance 'source_record' — this is source data.
 *
 * 2. geocodeProjects: for projects with an address but no geometry, ask the
 *    US Census Bureau geocoder (official, free, no key —
 *    geocoding.geo.census.gov; verified 2026-07-17). Normalized addresses are
 *    street-only (city/zip stripped), so a blind geocode could fabricate a
 *    location. Guard: accept ONLY a unique match whose returned county equals
 *    the project's stored county (the geographies endpoint returns the
 *    matched point's county). A geocoded point is an INFERENCE — provenance
 *    'census_geocoder' + full attempt metadata; it never overwrites record
 *    geometry, and a later record geometry may overwrite IT.
 *
 * Every attempt (match, no_match, ambiguous, county_mismatch, error) is
 * recorded in geocode_meta_json so reruns skip already-attempted projects.
 */

const CENSUS_URL = "https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress";
const BENCHMARK = "Public_AR_Current";
const VINTAGE = "Current_Current";

let envProxyAgent: Dispatcher | undefined;
function proxyDispatcher(): Dispatcher | undefined {
  if (!process.env.HTTPS_PROXY && !process.env.https_proxy) return undefined;
  envProxyAgent ??= new EnvHttpProxyAgent();
  return envProxyAgent;
}

export type GeocodeFetcher = (url: string) => Promise<{ status: number; json(): Promise<unknown> }>;

const defaultFetcher: GeocodeFetcher = async (url) => {
  const dispatcher = proxyDispatcher();
  const res = await undiciFetch(url, dispatcher ? { dispatcher } : {});
  return { status: res.status, json: () => res.json() };
};

export interface MaterializeSummary {
  projectsFilled: number;
}

/** Pass 1 — heal project geometry from active resolved records' geometry. */
export async function materializeProjectGeometry(
  db: Db,
  opts: { logger?: { info(o: unknown, m?: string): void } } = {},
): Promise<MaterializeSummary> {
  // Deliberately NOT retried. This is one set-based statement whose WHERE
  // clause excludes rows it has already filled, so a replay legitimately
  // matches zero rows and would report `projectsFilled: 0` for work that DID
  // happen — a retry here would corrupt the metric it is meant to protect. The
  // pool keep-alive covers this one; there is no long loop for a connection to
  // go idle inside.
  const res = await db.execute(sql`
    UPDATE projects p
    SET geometry = ST_SetSRID(ST_GeomFromGeoJSON(g.geom), 4326),
        geometry_source = 'source_record',
        geocode_meta_json = NULL
    FROM (
      SELECT DISTINCT ON (rr.project_id)
        rr.project_id, sr.normalized_json->'geometry' AS geom
      FROM record_resolutions rr
      JOIN source_records sr ON sr.id = rr.source_record_id
      WHERE rr.status = 'active'
        AND sr.normalized_json->'geometry' IS NOT NULL
        AND sr.normalized_json->>'geometry' != 'null'
      ORDER BY rr.project_id, sr.last_seen_at DESC
    ) g
    WHERE p.id = g.project_id
      AND (p.geometry IS NULL OR p.geometry_source = 'census_geocoder')`);
  const summary = { projectsFilled: Number(res.rowCount ?? 0) };
  opts.logger?.info(summary, "project geometry materialized from records");
  return summary;
}

interface CensusMatch {
  coordinates: { x: number; y: number };
  matchedAddress?: string;
  geographies?: { Counties?: { BASENAME?: string }[] };
}

export interface GeocodeSummary {
  attempted: number;
  matched: number;
  noMatch: number;
  ambiguous: number;
  countyMismatch: number;
  errors: number;
}

export async function geocodeProjects(
  db: Db,
  opts: {
    limit?: number;
    county?: string;
    /** Restrict to specific projects (targeted re-runs; test isolation). */
    projectIds?: string[];
    /** Milliseconds between requests (polite pacing on a public service). */
    delayMs?: number;
    fetcher?: GeocodeFetcher;
    logger?: { info(o: unknown, m?: string): void; warn?(o: unknown, m?: string): void };
  } = {},
): Promise<GeocodeSummary> {
  const limit = opts.limit ?? 500;
  const delayMs = opts.delayMs ?? 150;
  const fetcher = opts.fetcher ?? defaultFetcher;
  const countyFilter = opts.county ? sql`AND p.county = ${opts.county}` : sql``;
  const idFilter =
    opts.projectIds && opts.projectIds.length > 0
      ? sql`AND p.id IN (${sql.join(
          opts.projectIds.map((id) => sql`${id}`),
          sql`, `,
        )})`
      : sql``;

  const candidates = await db.execute(sql`
    SELECT p.id, p.address_normalized, p.city, p.county
    FROM projects p
    WHERE p.geometry IS NULL
      AND p.address_normalized IS NOT NULL
      AND p.geocode_meta_json IS NULL
      AND p.permitting_jurisdiction != 'Test Jurisdiction'
      ${countyFilter}
      ${idFilter}
    ORDER BY p.last_seen_at DESC
    LIMIT ${limit}`);

  const summary: GeocodeSummary = {
    attempted: 0, matched: 0, noMatch: 0, ambiguous: 0, countyMismatch: 0, errors: 0,
  };

  for (const row of candidates.rows as {
    id: string;
    address_normalized: string;
    city: string | null;
    county: string;
  }[]) {
    summary.attempted++;
    // Street + (city when known) + state. County correctness is verified from
    // the RESPONSE, never assumed from the query.
    const oneline = [row.address_normalized, row.city, "WA"].filter(Boolean).join(", ");
    const url = `${CENSUS_URL}?address=${encodeURIComponent(oneline)}&benchmark=${BENCHMARK}&vintage=${VINTAGE}&format=json&layers=Counties`;

    const attemptedAt = new Date().toISOString();
    const meta = (status: string, extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        status,
        query: oneline,
        benchmark: BENCHMARK,
        vintage: VINTAGE,
        attemptedAt,
        ...extra,
      });

    /**
     * Persist one attempt's outcome, surviving a transient pooler drop.
     *
     * Safe to replay: every branch below is a single UPDATE keyed by primary
     * key writing computed values, so a second execution writes identical
     * bytes. Worth replaying: each row costs an HTTP round trip to the Census
     * geocoder that a lost write would throw away, and the nightly batch is 500
     * rows long — plenty of time for an idle connection to be reaped.
     */
    const persist = (stmt: ReturnType<typeof sql>) =>
      withConnectionRetry(() => db.execute(stmt), {
        onRetry: (attempt, err) =>
          opts.logger?.warn?.(
            { projectId: row.id, attempt, err: String(err) },
            "transient fault writing geocode result — retrying",
          ),
      });

    try {
      const res = await fetcher(url);
      if (res.status !== 200) {
        summary.errors++;
        opts.logger?.warn?.({ projectId: row.id, httpStatus: res.status }, "geocoder http error");
        // Transient service errors are NOT persisted — the next run retries.
        continue;
      }
      const body = (await res.json()) as { result?: { addressMatches?: CensusMatch[] } };
      const matches = body.result?.addressMatches ?? [];

      if (matches.length === 0) {
        summary.noMatch++;
        await persist(sql`
          UPDATE projects SET geocode_meta_json = ${meta("no_match")}::jsonb WHERE id = ${row.id}`);
      } else if (matches.length > 1) {
        summary.ambiguous++;
        await persist(sql`
          UPDATE projects SET geocode_meta_json = ${meta("ambiguous", { matches: matches.length })}::jsonb
          WHERE id = ${row.id}`);
      } else {
        const m = matches[0]!;
        const countyName = m.geographies?.Counties?.[0]?.BASENAME ?? null;
        if (countyName !== row.county) {
          summary.countyMismatch++;
          await persist(sql`
            UPDATE projects SET geocode_meta_json = ${meta("county_mismatch", {
              matchedAddress: m.matchedAddress ?? null,
              returnedCounty: countyName,
            })}::jsonb
            WHERE id = ${row.id}`);
        } else {
          summary.matched++;
          await persist(sql`
            UPDATE projects
            SET geometry = ST_SetSRID(ST_MakePoint(${m.coordinates.x}, ${m.coordinates.y}), 4326),
                geometry_source = 'census_geocoder',
                geocode_meta_json = ${meta("matched", {
                  matchedAddress: m.matchedAddress ?? null,
                  returnedCounty: countyName,
                })}::jsonb
            WHERE id = ${row.id} AND geometry IS NULL`);
        }
      }
    } catch (err) {
      summary.errors++;
      opts.logger?.warn?.({ projectId: row.id, err: String(err) }, "geocode attempt failed");
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  opts.logger?.info(summary, "geocode run complete");
  return summary;
}
