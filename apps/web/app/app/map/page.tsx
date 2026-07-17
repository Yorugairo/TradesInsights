import "leaflet/dist/leaflet.css";
import { redirect } from "next/navigation";
import { sql } from "drizzle-orm";
import { currentSession } from "../../../lib/auth.js";
import { db } from "../../../lib/db.js";
import { accountByKey } from "../../../lib/queries.js";
import MapClient, { type MapPoint } from "./map-client.js";

export const dynamic = "force-dynamic";

/** #3 — account-scoped map of opportunities with known locations. */
async function mapPoints(accountProfileId: string): Promise<MapPoint[]> {
  const res = await db().execute(sql`
    SELECT o.id AS opportunity_id, p.canonical_name, p.current_stage, p.county,
      o.current_score, o.state, p.geometry_source, p.campus_block,
      ST_X(ST_Centroid(p.geometry)) AS lon, ST_Y(ST_Centroid(p.geometry)) AS lat
    FROM opportunities o
    JOIN projects p ON p.id = o.project_id
    WHERE o.account_profile_id = ${accountProfileId}
      AND p.geometry IS NOT NULL
      AND o.state IN ('priority_review', 'promoted', 'weekly_digest', 'archive')
    ORDER BY o.current_score DESC NULLS LAST
    LIMIT 2000`);
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    opportunityId: r["opportunity_id"] as string,
    name: r["canonical_name"] as string,
    stage: r["current_stage"] as string,
    county: r["county"] as string,
    score: r["current_score"] === null ? null : Number(r["current_score"]),
    state: r["state"] as string,
    lon: Number(r["lon"]),
    lat: Number(r["lat"]),
    geometrySource: (r["geometry_source"] as string | null) ?? null,
    campusBlock: (r["campus_block"] as string | null) ?? null,
  }));
}

export default async function MapPage() {
  const session = await currentSession();
  if (!session?.accountKey) redirect("/login");
  const account = await accountByKey(db(), session.accountKey);
  if (!account) redirect("/login");
  const points = await mapPoints(account.id);
  const geocoded = points.filter((p) => p.geometrySource === "census_geocoder").length;

  return (
    <main>
      <h1>Opportunity map — {account.name}</h1>
      <p style={{ color: "#666" }} data-testid="map-summary">
        {points.length} opportunities with a known location ({geocoded} located by address
        geocoding — labeled as inferences). Marker color: priority (red), promoted (purple),
        digest (orange), archive (gray). Base map © OpenStreetMap contributors.
      </p>
      <MapClient points={points} />
    </main>
  );
}
