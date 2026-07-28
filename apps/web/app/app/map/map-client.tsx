"use client";

import { useEffect, useRef } from "react";

/** One mappable opportunity (project geometry present). */
export interface MapPoint {
  opportunityId: string;
  name: string;
  stage: string;
  county: string;
  score: number | null;
  state: string;
  lon: number;
  lat: number;
  /** 'source_record' (source data) vs 'census_geocoder' (labeled inference). */
  geometrySource: string | null;
  campusBlock: string | null;
}

const STATE_COLORS: Record<string, string> = {
  priority_review: "#c62828",
  promoted: "#6a1b9a",
  weekly_digest: "#ef6c00",
  archive: "#78909c",
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * #3 — Leaflet map of the account's opportunities. circleMarkers (no image
 * assets); OSM tiles with attribution — without network the base map is gray
 * but markers, popups, and links still work.
 */
export default function MapClient({ points }: { points: MapPoint[] }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let destroyed = false;
    let map: import("leaflet").Map | null = null;
    void (async () => {
      const L = (await import("leaflet")).default;
      if (destroyed || !ref.current) return;
      map = L.map(ref.current);
      const bounds =
        points.length > 0
          ? L.latLngBounds(points.map((p) => [p.lat, p.lon] as [number, number]))
          : // South Puget Sound pilot region when nothing is mappable yet.
            L.latLngBounds([
              [46.4, -123.3],
              [47.8, -121.0],
            ]);
      map.fitBounds(bounds.pad(0.1));
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(map);

      for (const p of points) {
        const color = STATE_COLORS[p.state] ?? "#78909c";
        const marker = L.circleMarker([p.lat, p.lon], {
          radius: p.state === "priority_review" || p.state === "promoted" ? 8 : 5,
          color,
          fillColor: color,
          fillOpacity: 0.7,
          weight: 1,
        }).addTo(map);
        marker.bindPopup(
          `<strong>${esc(p.name)}</strong><br/>` +
            `${esc(p.stage)} · ${esc(p.county)} · score ${p.score ?? "—"}<br/>` +
            (p.campusBlock ? `active campus (block ${esc(p.campusBlock.split(":")[1] ?? p.campusBlock)})<br/>` : "") +
            (p.geometrySource === "census_geocoder"
              ? `<em>location geocoded from address (inference)</em><br/>`
              : "") +
            `<a href="/app/opportunities/${esc(p.opportunityId)}">open opportunity</a>`,
        );
      }
    })();
    return () => {
      destroyed = true;
      map?.remove();
    };
  }, [points]);

  // Height stays inline: Leaflet measures its container on init, so the box must
  // have a resolved height before `L.map()` runs. A utility class would work too,
  // but the viewport-relative height with a floor is the datum Leaflet needs and
  // keeping it here puts it next to the code that depends on it.
  //
  // Marker colours are deliberately NOT tokenised. They are a categorical legend
  // printed in `map-summary` ("priority (red), promoted (purple), …"); rebinding
  // them to theme tokens would make the caption wrong in one of the two
  // registers, and the caption is what makes the map readable.
  return (
    <div
      ref={ref}
      data-testid="opportunity-map"
      className="rounded-lg border border-line-strong"
      style={{ height: "70vh", minHeight: 420 }}
    />
  );
}
