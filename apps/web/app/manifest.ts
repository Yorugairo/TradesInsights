import type { MetadataRoute } from "next";

/**
 * Installability (mobile M1). Next 15 serves this at /manifest.webmanifest and
 * links it from <head> automatically — no plugin, no build step.
 *
 * `start_url` is the digest, not "/": the app's job on open is to show the
 * owner their week. The field crew never reaches this manifest's start_url —
 * they arrive on a token link and stay there.
 *
 * Colours are the cockpit tokens from globals.css (--canvas / --accent), stated
 * literally because a manifest cannot read CSS custom properties. If the
 * palette changes, this changes with it.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "OTN Insights",
    short_name: "Insights",
    description: "Construction opportunity intelligence for trade contractors",
    start_url: "/app/digests",
    display: "standalone",
    orientation: "portrait",
    background_color: "#061109",
    theme_color: "#061109",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // Maskable is a separate asset, not the same file relabelled: Android
      // crops to a circle and an unpadded icon loses its edges.
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
